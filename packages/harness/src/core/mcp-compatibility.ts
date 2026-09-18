import { execFile, spawn } from "node:child_process";
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

// Keep an owned leader alive while a broken probe's descendants retain pipes.
// Same pipe-lifetime pattern as Desktop's bounded installer, scoped to this probe.
const PROBE_RUNNER = `
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(1), {stdio:['ignore','pipe','pipe'], windowsHide:true});
child.stdout.pipe(process.stdout, {end:false});
child.stderr.pipe(process.stderr, {end:false});
child.on('error', () => { process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
`;

function runProbe(
  launch: McpDevServerCommand,
  entry: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        launch.command,
        ["-e", PROBE_RUNNER, ...launch.args, MCP_CAPABILITIES_FLAG],
        {
          cwd: dirname(entry),
          env: probeEnvironment(launch),
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch {
      done(null);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopping = false;
    const finish = (output: string | null) => {
      clearTimeout(timer);
      done(output);
    };
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32") {
          await new Promise<void>((resolveStop) =>
            execFile(
              "taskkill.exe",
              ["/pid", String(child.pid), "/T", "/F"],
              {
                windowsHide: true,
                timeout: 1_000,
                killSignal: "SIGKILL",
                maxBuffer: HOST_MESSAGE_MAX_BYTES,
              },
              () => resolveStop(),
            ),
          );
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        child.kill("SIGKILL");
      }
      // A separate deadline owns completion, even if a descendant retains pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(null);
    };
    const timer = setTimeout(() => {
      void stop();
    }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > HOST_MESSAGE_MAX_BYTES) void stop();
      else chunks.push(chunk);
    });
    child.stderr!.on("data", () => {
      void stop();
    });
    child.once("error", () => {
      void stop();
    });
    child.once("close", (code) => {
      if (!stopping)
        finish(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
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
  const output = await runProbe(launch, entry, timeoutMs);
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

/** CLI policy: use the runtime dependency only when verified; otherwise retain
 * its existing npx @latest fallback (which is never treated as preflighted).
 */
export async function prepareBundledMcpCommand(
  candidate = bundledMcpCommand(),
): Promise<McpPreflightResult | undefined> {
  if (!candidate) return undefined;
  const result = await qualifyMcpCommand(candidate);
  return result.kind === "verified" ? result : undefined;
}
