// agy-rotator-windows — the streaming key scan over the agy binary (plan §3.7 "App key", R4-4, R4-11; AC8).
//
// The file is read in `CHUNK_BYTES` pieces through a read stream, with `OVERLAP_BYTES` carried between pieces so a match
// that straddles a chunk boundary is still found. There is deliberately no whole-file read path in this module — the
// tests assert that by grepping this file for `readFile` (N2: "< 32 MB" is proved by construction, not by process RSS).
//
// Re-scans happen when the executable's size or mtime changes (agy self-updates in place), and a re-scan is the caller's
// cue to drop the locked pair: last run's key may no longer be the key the CLI will use.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { CHUNK_BYTES, MAX_BUFFER_BYTES, OVERLAP_BYTES, emptyKeys, scanWindow, uniqueHits, type ScannedKeys, type ScanHit } from "../shared/keys.ts";

export { CHUNK_BYTES, MAX_BUFFER_BYTES, OVERLAP_BYTES };

/** One streaming pass over exactly this file. Never a glob: a `.old` sibling is a stale key. */
export async function scanFile(binaryPath: string): Promise<ScannedKeys> {
  const ids: ScanHit[] = [];
  const secrets: ScanHit[] = [];
  let carry = Buffer.alloc(0);
  let consumed = 0;

  const stream = createReadStream(binaryPath, { highWaterMark: CHUNK_BYTES });
  try {
    for await (const piece of stream) {
      const chunk = piece as Buffer;
      // The only buffer this module allocates, and it is bounded: carry (≤ OVERLAP) + one chunk.
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk], carry.length + chunk.length);
      const base = consumed - carry.length;
      const found = scanWindow(window.toString("latin1"), base);
      ids.push(...found.ids);
      secrets.push(...found.secrets);
      consumed += chunk.length;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - OVERLAP_BYTES)));
    }
  } finally {
    stream.destroy();
  }

  const uniqueIds = uniqueHits(ids);
  const uniqueSecrets = uniqueHits(secrets);
  return { ids: uniqueIds.map((hit) => hit.value), secrets: uniqueSecrets.map((hit) => hit.value) };
}

export interface ScoutResult extends ScannedKeys {
  /** True when this call actually read the file; false when the cached answer still matched size+mtime. */
  scanned: boolean;
  /** True when a previous scan's answer was dropped because the executable changed (the caller must drop the pair). */
  changed: boolean;
}

/**
 * Scans at most once per executable version. `changed` is what the pairing layer watches: a new agy build means the key
 * it will use may be a different one, so the locked pair is worthless.
 */
export class KeyScout {
  private cache: { size: number; mtimeMs: number; keys: ScannedKeys } | null = null;

  async keys(binaryPath: string): Promise<ScoutResult> {
    const info = await stat(binaryPath);
    const same = this.cache !== null && this.cache.size === info.size && this.cache.mtimeMs === info.mtimeMs;
    if (same && this.cache) return { ...this.cache.keys, scanned: false, changed: false };
    const changed = this.cache !== null;
    const keys = await scanFile(binaryPath);
    this.cache = { size: info.size, mtimeMs: info.mtimeMs, keys };
    return { ...keys, scanned: true, changed };
  }

  /** The last answer without touching the disk (the poller uses it to stay off PowerShell and off the file). */
  peek(): ScannedKeys | null {
    return this.cache?.keys ?? null;
  }

  forget(): void {
    this.cache = null;
  }
}

export { emptyKeys };
