// agent-rescue — pure logic shared by the server, the client and the tests. No Paseo or zod imports, so
// `node --test test/rescue.test.ts` runs it directly.

/** Error texts after which the session object is dead and only a reload cures it. */
export const DEFAULT_PATTERNS: readonly string[] = [
  "A foreground turn is already active",
  "Timed out closing previous session",
  "Timeout waiting for message",
  "ACP agent exited unexpectedly",
  "Session is closed",
  "Session is not initialized",
  "RPC process is closed",
];

/** Provider id → regex over the process command line. Matched only among the daemon's own children. */
export const DEFAULT_PROVIDER_PROCESSES: Readonly<Record<string, { name: string; pattern: string }>> = {
  qoder: { name: "qodercli.exe", pattern: "qodercli\\.exe.*--acp" },
};

/** The fields this plugin reads off an agent snapshot. */
export interface RescueAgent {
  id: string;
  provider: string;
  status: string;
  lastError?: string | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
  archivedAt?: string | null;
  title?: string | null;
}

export type RescueState = "ok" | "stuck" | "reloading";

function matches(text: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/**
 * `stuck`     — status `error` and lastError matches a pattern: Reload is offered.
 * `reloading` — status `closed` with a matching lastError: the daemon emits the old record as closed and keeps
 *               lastError while a reload is in flight, so no second reload is offered.
 * `ok`        — everything else, including `idle` with a stale stuck text after a successful reload.
 */
export function rescueState(agent: RescueAgent, patterns: readonly string[]): RescueState {
  if (agent.archivedAt) return "ok";
  if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn) return "ok";
  const error = agent.lastError ?? "";
  if (!error || !patterns.some((p) => matches(error, p))) return "ok";
  if (agent.status === "error") return "stuck";
  if (agent.status === "closed") return "reloading";
  return "ok";
}

/** Other live agents of the same provider that a process restart would interrupt. */
export function blockers(agents: readonly RescueAgent[], provider: string, exceptId: string): RescueAgent[] {
  return agents.filter(
    (a) =>
      a.id !== exceptId &&
      a.provider === provider &&
      !a.archivedAt &&
      (a.status === "running" ||
        a.status === "initializing" ||
        Boolean(a.activeTurn) ||
        (a.pendingPermissions?.length ?? 0) > 0),
  );
}

export interface Invocation {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  /** Run through the SDK's execCommand (resolves `paseo` on PATH, .cmd included) instead of execFile. */
  viaPath?: boolean;
}

/**
 * How to run the Paseo CLI. `execFile("paseo")` is ENOENT on Windows (a .cmd), and an app started from the macOS
 * Dock sees only a minimal PATH. So first look for the CLI bundled with the desktop app: the plugin host runs under
 * the app's own executable, which runs the bundled CLI when started as node (Windows resources\bin\paseo.cmd does
 * exactly this). The app's resources directory is searched upward from the executable (`resources` on Windows,
 * `Contents/Resources` on macOS) and recognised by its unpacked daemon runner. With no desktop app (a daemon
 * installed from npm) `paseo` is resolved from PATH.
 * PASEO_CLI_PATH overrides: a .js/.mjs entry runs under the current executable, anything else runs directly.
 */
export function cliInvocation(
  execPath: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  platform: string,
  exists: (path: string) => boolean,
): Invocation {
  const sep = platform === "win32" ? "\\" : "/";
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1", PASEO_HOST: "" };
  const override = env.PASEO_CLI_PATH?.trim();
  if (override) {
    return /\.(c|m)?js$/i.test(override)
      ? { file: execPath, args: [override, ...args], env: childEnv }
      : { file: override, args: [...args], env: childEnv };
  }
  const res = findResources(execPath, sep, exists);
  if (!res) return { file: "paseo", args: [...args], env: childEnv, viaPath: true };
  return {
    file: execPath,
    args: [
      "--disable-warning=DEP0040",
      [res, ...RUNNER].join(sep),
      "node-script",
      [res, "app.asar", "node_modules", "@getpaseo", "cli", "dist", "index.js"].join(sep),
      ...args,
    ],
    env: childEnv,
  };
}

const RUNNER = ["app.asar.unpacked", "dist", "daemon", "node-entrypoint-runner.js"];

/** The desktop app's resources directory at or above the executable, or null when there is no desktop app. */
function findResources(execPath: string, sep: string, exists: (path: string) => boolean): string | null {
  let dir = execPath.slice(0, Math.max(execPath.lastIndexOf(sep), 0));
  for (let level = 0; level < 6 && dir; level++) {
    for (const name of ["resources", "Resources"]) {
      const res = `${dir}${sep}${name}`;
      if (exists([res, ...RUNNER].join(sep))) return res;
    }
    const up = dir.lastIndexOf(sep);
    if (up <= 0) break;
    dir = dir.slice(0, up);
  }
  return null;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  commandLine: string;
}

/** Parses `Get-CimInstance … | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json`. */
export function parseCimProcesses(json: string): ProcessInfo[] {
  if (!json.trim()) return [];
  const raw = JSON.parse(json) as unknown;
  const rows = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    pid: Number(r.ProcessId),
    ppid: Number(r.ParentProcessId),
    commandLine: String(r.CommandLine ?? ""),
  }));
}

/** The provider's processes this daemon started: pattern on the command line AND parent = the daemon. */
export function matchProviderProcesses(procs: readonly ProcessInfo[], pattern: string, daemonPid: number): ProcessInfo[] {
  return procs.filter((p) => p.ppid === daemonPid && matches(p.commandLine, pattern));
}
