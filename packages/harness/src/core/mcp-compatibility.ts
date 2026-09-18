import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  HOST_MESSAGE_MAX_BYTES,
  MCP_CAPABILITIES_FLAG,
  McpCapabilitiesSchema,
  supportsStudioContext,
  type McpCapabilities,
} from "@sapiom/agent-map/host-protocol";
import { unpackedPath } from "./asar-path.js";
import type { McpDevServerCommand } from "./inject/mcp-config.js";

export type McpPreflightResult =
  | {
      kind: "verified";
      launch: McpDevServerCommand;
      descriptor: McpCapabilities;
    }
  | { kind: "legacy"; launch: McpDevServerCommand }
  | {
      kind: "unavailable";
      launch: McpDevServerCommand;
      reason: "missing" | "invalid" | "changed" | "probe-failed";
    };

/** No shell, PATH lookup or Electron dependency in shared launcher code. */
export function mcpCommandForEntry(
  entry: string,
  runtime = process.execPath,
  electron = !!process.versions.electron,
): McpDevServerCommand {
  return {
    command: runtime,
    args: [unpackedPath(entry)],
    ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  };
}

/** Resolve without importing the executable. An unbuilt workspace stays unverified. */
export function bundledMcpCommand(): McpDevServerCommand | undefined {
  try {
    return mcpCommandForEntry(
      createRequire(import.meta.url).resolve("@sapiom/mcp"),
    );
  } catch {
    return undefined;
  }
}

/** The probe gets no credentials, Node preload hooks, host context or esbuild pin. */
function probeEnvironment(launch: McpDevServerCommand): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (launch.env?.ELECTRON_RUN_AS_NODE)
    env.ELECTRON_RUN_AS_NODE = launch.env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Qualifies precisely the command returned in the result. Old binaries ignore
 * unknown flags, so never spawn one before checking its package support marker.
 * The actual MCP rechecks the returned descriptor/fingerprint when it starts.
 */
export async function qualifyMcpCommand(
  candidate: McpDevServerCommand,
  timeoutMs = 3_000,
): Promise<McpPreflightResult> {
  const launch = {
    ...candidate,
    args: [...candidate.args],
    ...(candidate.env ? { env: { ...candidate.env } } : {}),
  };
  const unavailable = (
    reason: "missing" | "invalid" | "changed" | "probe-failed",
  ): McpPreflightResult => ({ kind: "unavailable", launch, reason });
  const entry = launch.args[0];
  if (!entry || !isAbsolute(entry) || launch.args.length !== 1)
    return unavailable("invalid");
  let before: string;
  let manifestPath: string;
  try {
    manifestPath = resolve(dirname(entry), "../package.json");
    const manifest = await readFile(manifestPath, "utf8");
    const pkg = JSON.parse(manifest);
    if (
      pkg.name !== "@sapiom/mcp" ||
      typeof pkg.bin?.["sapiom-mcp"] !== "string"
    )
      return unavailable("invalid");
    if (
      (await realpath(entry)) !==
      (await realpath(resolve(dirname(manifestPath), pkg.bin["sapiom-mcp"])))
    )
      return unavailable("invalid");
    // Snapshot both inputs so a replaced entry/manifest cannot qualify this run.
    before = manifest + "\0" + (await readFile(entry, "utf8"));
    if (pkg.sapiomCapabilities !== 1) return { kind: "legacy", launch };
  } catch {
    return unavailable("missing");
  }
  const output = await new Promise<string | null>((done) => {
    try {
      execFile(
        launch.command,
        [...launch.args, MCP_CAPABILITIES_FLAG],
        {
          cwd: dirname(entry),
          env: probeEnvironment(launch),
          windowsHide: true,
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: HOST_MESSAGE_MAX_BYTES,
          encoding: "utf8",
        },
        (error, stdout, stderr) => done(error || stderr ? null : stdout),
      );
    } catch {
      done(null);
    }
  });
  if (output === null) return unavailable("probe-failed");
  try {
    const after =
      (await readFile(manifestPath, "utf8")) +
      "\0" +
      (await readFile(entry, "utf8"));
    if (before !== after) return unavailable("changed");
    const descriptor = McpCapabilitiesSchema.parse(JSON.parse(output));
    if (
      descriptor.packageVersion !==
      JSON.parse(await readFile(manifestPath, "utf8")).version
    )
      return unavailable("changed");
    if (!supportsStudioContext(descriptor)) return { kind: "legacy", launch };
    return { kind: "verified", launch, descriptor };
  } catch {
    return unavailable("invalid");
  }
}
