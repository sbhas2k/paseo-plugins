// agy-rotator-windows — how this host runs the Paseo CLI, and the one command this plugin needs (`agent reload`).
//
// Copied from tools/paseo-plugins/agent-rescue/server/ops.ts, which already solved both problems on this platform:
//  - `execFile("paseo")` is ENOENT on Windows (the CLI is a .cmd), and a daemon started by a GUI app sees a minimal
//    PATH — so look for the CLI bundled with the desktop app first (it runs under the app's own executable, as node),
//    and fall back to `paseo` from PATH.
//  - the CLI's own client gives up at 60 s; a 90 s backstop catches a wedged CLI without hanging the plugin forever.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execCommand } from "@getpaseo/plugin/server";

const run = promisify(execFile);

export const paseoHome = (): string => process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");

const RUNNER = ["app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js"];

/** The desktop app's resources directory at or above the executable, or null when there is no desktop app. */
function findResources(execPath: string, sep: string, exists: (file: string) => boolean): string | null {
  let dir = execPath.slice(0, Math.max(execPath.lastIndexOf(sep), 0));
  for (let level = 0; level < 6 && dir; level++) {
    for (const name of ["resources", "Resources"]) {
      const candidate = `${dir}${sep}${name}`;
      if (exists([candidate, ...RUNNER].join(sep))) return candidate;
    }
    const up = dir.lastIndexOf(sep);
    if (up <= 0) break;
    dir = dir.slice(0, up);
  }
  return null;
}

interface Invocation {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  viaPath?: boolean;
}

function cli(args: string[]): Invocation {
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PASEO_HOST: "", PASEO_HOME: paseoHome() };
  const override = process.env.PASEO_CLI_PATH?.trim();
  const sep = process.platform === "win32" ? "\\" : "/";
  if (override) {
    return /\.(c|m)?js$/i.test(override)
      ? { file: process.execPath, args: [override, ...args], env }
      : { file: override, args: [...args], env };
  }
  const resources = findResources(process.execPath, sep, existsSync);
  if (!resources) return { file: "paseo", args: [...args], env, viaPath: true };
  return {
    file: process.execPath,
    args: [
      "--disable-warning=DEP0040",
      [resources, ...RUNNER].join(sep),
      "node-script",
      [resources, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js"].join(sep),
      ...args,
    ],
    env,
  };
}

/** The daemon's address, as the CLI needs it (`<paseoHome>/paseo.pid` → `listen`). */
async function daemonHost(): Promise<string> {
  const pid = JSON.parse(await readFile(path.join(paseoHome(), "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
  const host = pid.listen ?? pid.sockPath;
  if (!host) throw new Error("Could not find this daemon's address in paseo.pid.");
  return host;
}

function errorText(error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
  if (e.killed) return "CLI did not answer in time";
  const out = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim();
  return (out || e.message || String(error)).split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300);
}

async function runCli(args: string[], timeout: number): Promise<string> {
  const invocation = cli(args);
  const options = { env: invocation.env, timeout, maxBuffer: 1024 * 1024 };
  const { stdout } = invocation.viaPath
    ? await execCommand(invocation.file, invocation.args, options)
    : await run(invocation.file, invocation.args, { ...options, windowsHide: true });
  return String(stdout);
}

/** `paseo agent reload <id>`. Null on success, else the error text (never thrown: a failed reload is reported). */
export async function cliReload(agentId: string): Promise<string | null> {
  try {
    const host = await daemonHost();
    await runCli(["agent", "reload", agentId, "--host", host, "--json"], 90_000);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

/** Startup self-check, logged so a host with no working CLI is visible before a switch needs it. */
export async function probeCli(): Promise<string> {
  const invocation = cli(["--version"]);
  const where = invocation.viaPath ? "paseo from PATH" : `bundled CLI via ${invocation.file}`;
  try {
    const version = (await runCli(["--version"], 30_000)).trim().split(/\r?\n/).pop();
    return `CLI OK: ${where}, version ${version}`;
  } catch (error) {
    return `CLI NOT WORKING: ${where}: ${errorText(error)} - Switch will fail; set PASEO_CLI_PATH`;
  }
}
