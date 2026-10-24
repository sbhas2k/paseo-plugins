import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { CdpConnection } from "./cdp.ts";

// remote-browser — starting the headless Chrome this plugin owns, over the DevTools pipe (no TCP port).
// A Chrome started by a Node child dies with it (Windows job object), so a stale browser on our profile
// is rare; when one does hold it, the new Chrome hands off and exits with code 21 without ever answering. That is
// detected at once, our-profile Chromes are stopped, and the start is retried once.

export interface LaunchedBrowser {
  conn: CdpConnection;
  child: ChildProcess;
}

const CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findBrowser(configured: string | null): string | null {
  if (configured && existsSync(configured)) return configured;
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const PROFILE_IN_USE = 21;

/**
 * Stops any chrome/msedge whose command line carries OUR profile directory (never another profile), and keeps checking
 * until none is left (Chrome's helpers exit a few seconds after the browser process), up to 8 s. Windows only.
 */
export async function stopProfileBrowsers(profile: string): Promise<number> {
  if (process.platform !== "win32") return 0;
  const needle = profile.replace(/'/g, "''");
  const script =
    "$ProgressPreference='SilentlyContinue'; " +
    `$p = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" | ` +
    `? { $_.CommandLine -and $_.CommandLine.Contains('${needle}') }); ` +
    "$p | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const round = () =>
    new Promise<number>((resolve) =>
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 20_000 },
        (_err, stdout) => resolve(Number.parseInt(String(stdout).trim(), 10) || 0),
      ),
    );
  const deadline = Date.now() + 8_000;
  let found = await round();
  while (found > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    found = await round();
  }
  return found;
}

export type BrowserMode = "window" | "headless";

/**
 * "window" (default) is a real Chrome window placed off-screen on the host's desktop — a normal browser, which strict
 * bot checks (Cloudflare managed challenges) accept; it keeps drawing in a disconnected RDP session thanks to the
 * no-backgrounding/no-occlusion switches (measured with the daemon in a disconnected session). "headless" has no
 * window at all and is turned away by such checks.
 */
export function modeArgs(mode: BrowserMode): string[] {
  return mode === "headless"
    ? ["--headless=new"]
    : [
        "--window-position=-2400,-2400",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-features=CalculateNativeWinOcclusion",
      ];
}

function spawnOnce(binary: string, profile: string, timeoutMs: number, mode: BrowserMode): Promise<LaunchedBrowser> {
  const child = spawn(
    binary,
    [
      ...modeArgs(mode),
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--hide-scrollbars",
      // A person drives this browser, not an automation script: do not mark it as automation-controlled.
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true },
  );
  const conn = new CdpConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
  return new Promise<LaunchedBrowser>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`browser did not answer in ${timeoutMs / 1000}s: ${stderr.slice(-300)}`));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      const err = new Error(
        code === PROFILE_IN_USE
          ? "profile in use by another browser"
          : `browser exited during start (code ${code}): ${stderr.slice(-300)}`,
      );
      (err as Error & { code?: number | null }).code = code;
      reject(err);
    };
    child.once("exit", onExit);
    conn
      .send("Browser.getVersion", {}, undefined, timeoutMs)
      .then(() => {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve({ conn, child });
      })
      .catch(() => {
        // The exit handler or the timer reports the cause.
      });
  });
}

export async function launchBrowser(binary: string, profile: string, mode: BrowserMode = "window", timeoutMs = 20_000): Promise<LaunchedBrowser> {
  mkdirSync(profile, { recursive: true });
  try {
    return await spawnOnce(binary, profile, timeoutMs, mode);
  } catch (error) {
    const code = (error as { code?: number | null }).code;
    if (code === PROFILE_IN_USE) {
      await stopProfileBrowsers(profile);
      return spawnOnce(binary, profile, timeoutMs, mode);
    }
    // No desktop to open a window on (e.g. a Linux server without a display): fall back to headless.
    if (mode === "window") return spawnOnce(binary, profile, timeoutMs, "headless");
    throw error;
  }
}
