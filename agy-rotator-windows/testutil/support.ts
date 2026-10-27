// Shared test support: the synthetic 560-byte blob and a throwaway PASEO_HOME. Every test in this plugin uses these and
// nothing else — never the live `gemini:antigravity` entry, never a real email, never a real token.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountKey } from "../server/key.ts";

/** A 560-byte synthetic blob — the size `agy` itself writes (F1) — JSON-shaped, one non-ASCII byte, no newline. */
export function syntheticBlob(email: string): Buffer {
  const build = (padding: number): string =>
    JSON.stringify({
      token: {
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh-token",
        expiry: "2026-10-26T18:13:01Z",
        expires_in: 3599,
      },
      auth_method: "synthetic",
      id_token_email: email,
      note: `é${"x".repeat(padding)}`,
    });
  let padding = 0;
  while (Buffer.byteLength(build(padding), "utf8") < 560) padding++;
  const text = build(padding);
  assert.equal(Buffer.byteLength(text, "utf8"), 560);
  assert.equal(text.endsWith("\n"), false);
  return Buffer.from(text, "utf8");
}

/** A throwaway email — the key is what every assertion should use, never the address itself. */
export function testEmail(tag: string): string {
  return `${tag}-${randomBytes(4).toString("hex")}@example.invalid`;
}

export const keyOf = (email: string): string => accountKey(email);

/** A throwaway "live" target: slot-shaped on purpose, so `writeLive` may write it and nothing real is touched. */
export function testLiveTarget(): string {
  return `paseo-agy-accounts:test-live-${randomBytes(6).toString("hex")}`;
}

/**
 * AC11 regression (2026-10-27): a test run left ONE `paseo-agy-accounts:*` target behind — a fixture whose test threw
 * between writing the credential and reaching the `finally` that would have deleted it (or a run that was killed).
 *
 * Two defences, both here:
 *  - `trackFixture` records an EXACT target name *before* the credential is written, so a later throw still leaves a name
 *    the file's `after` hook can delete;
 *  - `sweepFixtures` runs at the end of a test file and deletes (a) any `paseo-agy-accounts:test-*` target and (b) the
 *    exact hex16 targets THIS RUN registered — never a hex16 target chosen by pattern (that is how a real account card's
 *    slot would be deleted), and never a target the index knows.
 */
const fixtures = new Set<string>();

/** Register an exact target name. Call this BEFORE writing the credential, never after. */
export function trackFixture(target: string): string {
  fixtures.add(target);
  return target;
}

const SLOT_PREFIX = "paseo-agy-accounts:";

/** Delete this run's fixtures (and any stray `test-` target). Safe by construction: see above. */
export async function sweepFixtures(): Promise<void> {
  const { credDelete, credEnumerate } = await import("../server/cred.ts");
  const { readIndex } = await import("../server/store.ts");
  let indexed: Set<string>;
  try {
    indexed = new Set((await readIndex()).map((entry) => `${SLOT_PREFIX}${entry.key}`));
  } catch {
    // Without the index there is no safe way to tell a fixture from an account card: delete nothing.
    return;
  }
  let census: string[] = [];
  try {
    census = await credEnumerate(SLOT_PREFIX);
  } catch {
    return;
  }
  for (const target of census) {
    if (!target.startsWith(SLOT_PREFIX) || indexed.has(target)) continue;
    const key = target.slice(SLOT_PREFIX.length);
    if (key.startsWith("test-") || fixtures.has(target)) await credDelete(target).catch(() => {});
  }
  fixtures.clear();
}

/** The targets under the plugin's prefix right now (names only) — the before/after proof's own census. */
export async function fixtureCensus(): Promise<string[]> {
  const { credEnumerate } = await import("../server/cred.ts");
  return (await credEnumerate(SLOT_PREFIX)).filter((target) => target.startsWith(SLOT_PREFIX));
}

/** This run's registered targets, for the budget assertion in the leak-guard test. */
export const trackedFixtures = (): string[] => [...fixtures];

/** Points PASEO_HOME at a temp directory for the duration of `fn`, then removes it and restores the variable. */
export async function withTempPaseoHome<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-rotator-windows-test-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
