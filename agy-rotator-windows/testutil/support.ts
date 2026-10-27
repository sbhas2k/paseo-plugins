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
