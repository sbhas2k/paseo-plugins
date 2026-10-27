// agy-rotator-windows — one `/usage` read for the account that is signed in (plan §3.2, fact F3).
//
// The invocation is exactly what §3.2 fixes and nothing else:
//   `agy -p /usage --output-format json`, from a FRESH TEMP CWD (F4: from the repository cwd it hung for >90 s), with
//   stdin CLOSED (F3's probe), and a 60 s cap. It spends no quota, writes no credential and leaves no conversation.
//
// `/usage` reads the quota of whichever account is signed in, so this process is the one place the plugin learns
// figures. It never passes a token, never sets an account and never touches a file `agy` owns: it parses the stdout of
// the documented command. `spawn` (not `execFile`) because only `spawn` can close stdin.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseUsage } from "../shared/usage.ts";
import type { UsageSnapshot } from "./usage-cache.ts";

export const USAGE_ARGS = ["-p", "/usage", "--output-format", "json"] as const;
export const USAGE_TIMEOUT_MS = 60_000;

/** `Please sign in` is what a logged-out CLI says, on whichever channel it chooses (antigravity-cli's own quota.ts). */
const SIGNED_OUT = /please sign in|not logged into/i;

/**
 * Where `agy` is: an explicit override, the Antigravity installer's own directory (the daemon's PATH may predate the
 * install — the installer only adds it to the user PATH), then PATH itself.
 */
export function resolveAgyBinary(explicit?: string): string {
  const chosen = explicit?.trim();
  if (chosen) return chosen;
  const fromEnv = process.env.PASEO_ANTIGRAVITY_BIN?.trim();
  if (fromEnv) return fromEnv;
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates =
    process.platform === "win32"
      ? [path.join(localAppData, "agy", "bin", "agy.exe"), path.join(os.homedir(), ".local", "bin", "agy.exe")]
      : [path.join(os.homedir(), ".local", "bin", "agy")];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return process.platform === "win32" ? "agy.exe" : "agy";
}

/** One read. Never throws: a broken spawn is a reading like any other, and the tick must survive it. */
export async function readUsage(binary: string = resolveAgyBinary()): Promise<UsageSnapshot> {
  const at = Date.now();
  // A fresh temp directory per read: the repo cwd is what made /usage hang (F4), and one read per two minutes does not
  // deserve a reused directory.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agy-rotator-windows-usage-"));
  try {
    const { stdout, stderr } = await runUsageProcess(binary, cwd);
    return interpret(stdout, stderr, at, binary);
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
    // A failed process still carries what it printed, and a signed-out agy may say why on the way out.
    if (SIGNED_OUT.test(`${failed.stdout ?? ""}\n${failed.stderr ?? ""}`)) return { at, kind: "signed-out", reading: null };
    return {
      at,
      kind: "error",
      reading: null,
      message: failed.killed === true ? `agy did not answer /usage within ${USAGE_TIMEOUT_MS / 1000}s` : (failed.message ?? String(error)),
    };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

function runUsageProcess(binary: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...USAGE_ARGS], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, USAGE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`agy exited ${String(code)}${timedOut ? " (timed out)" : ""}`), { stdout, stderr, killed: timedOut }));
    });
  });
}

function interpret(stdout: string, stderr: string, at: number, binary: string): UsageSnapshot {
  if (SIGNED_OUT.test(`${stdout}\n${stderr}`)) return { at, kind: "signed-out", reading: null };
  const reading = parseUsage(stdout, stderr);
  if (reading === null) {
    // Length only: the answer's content is the owner's quota, and it is not being logged.
    return {
      at,
      kind: "unavailable",
      reading: null,
      message: `${binary} answered /usage with something this parser does not trust (${stdout.length} bytes)`,
    };
  }
  return { at, kind: "ok", reading };
}
