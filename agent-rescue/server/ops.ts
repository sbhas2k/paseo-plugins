import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execCommand } from "@getpaseo/plugin/server";
import { cliInvocation, parseCimProcesses, type ProcessInfo, type RescueAgent } from "../shared/rescue";

// agent-rescue — the side-effecting half: the CLI reload, the process list and the kill. Pure decisions live in
// shared/rescue.ts. The bundled CLI and the Windows tools run through execFile; `paseo` from PATH runs through the
// SDK's execCommand, which handles Windows command scripts.

type PaseoApi = PluginHandlerContext["paseo"];
const run = promisify(execFile);

export const paseoHome = () => process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");

/** The daemon's address, as the CLI needs it (`~/.paseo/paseo.pid` → `listen`). */
async function daemonHost(): Promise<string> {
  const pid = JSON.parse(await readFile(path.join(paseoHome(), "paseo.pid"), "utf8")) as { listen?: string; sockPath?: string };
  const host = pid.listen ?? pid.sockPath;
  if (!host) throw new Error("Could not locate this daemon's address in paseo.pid.");
  return host;
}

function errorText(error: unknown): string {
  const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
  const out = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim();
  if (e.killed) return "CLI did not answer in time";
  return (out || e.message || String(error)).split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 400);
}

/** How this host runs the CLI: the desktop app's bundled one, else `paseo` from PATH. */
function cli(args: string[]) {
  return cliInvocation(process.execPath, args, { ...process.env, PASEO_HOME: paseoHome() }, process.platform, existsSync);
}

async function runCli(args: string[], timeout: number): Promise<string> {
  const inv = cli(args);
  const options = { env: inv.env as NodeJS.ProcessEnv, timeout, maxBuffer: 1024 * 1024 };
  const { stdout } = inv.viaPath
    ? await execCommand(inv.file, inv.args, options)
    : await run(inv.file, inv.args, { ...options, windowsHide: true });
  return String(stdout);
}

/** Startup self-check: which CLI was found and whether it runs (logged, so a new platform can be verified). */
export async function probeCli(): Promise<string> {
  const inv = cli(["--version"]);
  const where = inv.viaPath ? "paseo from PATH" : `bundled CLI via ${inv.file} (${inv.args[3]})`;
  try {
    const version = (await runCli(["--version"], 30_000)).trim().split(/\r?\n/).pop();
    return `CLI OK: ${where}, version ${version}`;
  } catch (error) {
    return `CLI NOT WORKING: ${where}: ${errorText(error)} - Reload will fail; set PASEO_CLI_PATH`;
  }
}

/** `paseo agent reload <id>` once. Resolves to null on success, else the error text. */
export async function cliReload(agentId: string): Promise<string | null> {
  const host = await daemonHost();
  try {
    // The CLI's own client gives up at 60 s; this is only a backstop for a wedged CLI.
    await runCli(["agent", "reload", agentId, "--host", host, "--json"], 90_000);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

const toRescueAgent = (a: Record<string, unknown>): RescueAgent & { workspaceId: string | null; cwd: string | null } => ({
  id: String(a.id),
  provider: String(a.provider ?? ""),
  status: String(a.status ?? ""),
  lastError: (a.lastError as string | null | undefined) ?? null,
  activeTurn: a.activeTurn ?? null,
  pendingPermissions: (a.pendingPermissions as unknown[] | null | undefined) ?? [],
  archivedAt: (a.archivedAt as string | null | undefined) ?? null,
  title: (a.title as string | null | undefined) ?? null,
  workspaceId: (a.workspaceId as string | null | undefined) ?? null,
  cwd: (a.cwd as string | null | undefined) ?? null,
});

/** Every non-archived agent on the daemon (all workspaces), paged. */
export async function listAgents(paseo: PaseoApi) {
  const out: ReturnType<typeof toRescueAgent>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } } as never);
    for (const entry of res.entries) out.push(toRescueAgent(entry.agent as unknown as Record<string, unknown>));
    const info = res.pageInfo as { hasMore?: boolean; nextCursor?: string | null };
    if (!info?.hasMore || !info.nextCursor) break;
    cursor = info.nextCursor;
  }
  return out;
}

export async function getAgent(paseo: PaseoApi, agentId: string) {
  const current = await paseo.agents.ref(agentId).refresh();
  const agent = (current as { agent?: Record<string, unknown> } | null)?.agent;
  return agent ? toRescueAgent(agent) : null;
}

/** Processes by image name, filtered in CIM (an unfiltered dump is ~4 MB). Windows only. */
export async function listProcesses(imageName: string): Promise<ProcessInfo[]> {
  if (process.platform !== "win32") throw new Error("Restart processes is implemented for Windows only.");
  if (!/^[A-Za-z0-9._-]+$/.test(imageName)) throw new Error(`Refusing image name ${JSON.stringify(imageName)}`);
  const script =
    "$ProgressPreference = 'SilentlyContinue'; " +
    `Get-CimInstance Win32_Process -Filter "Name='${imageName}'" | ` +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  // -EncodedCommand: no quoting through the Windows command line at all.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return parseCimProcesses(stdout);
}

/** taskkill /T /F, as the SDK's terminateProcess does — process.kill would leave grandchildren. */
export async function killTree(pid: number): Promise<string | null> {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000, windowsHide: true });
    return null;
  } catch (error) {
    return errorText(error);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
