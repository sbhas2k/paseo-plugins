// agy-rotator-windows — the app key, found by streaming the binary that `/usage` itself runs (plan §3.7, R4-4/R4-11).
//
// The refresh grant needs an OAuth client id and secret; they are compiled into `agy.exe`. The only copy the daemon may
// use is the one in the executable `resolveAgyBinary()` returns — never a directory glob (agy's self-updater leaves a
// matching `.old` sibling behind, and a stale key is a wrong key).
//
// Values live in this process's heap and nowhere else: never a file, a log, an RPC payload, a setting, the repo or a
// published package. Nothing in this module — or its caller — prints a value.

/** 4 MB: the chunk the scan reads at a time. A whole-file read measured +397 MB of daemon RSS (spike §Q2.4). */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Carried between chunks so a match straddling the boundary is still found. Google's longest pattern is ~72 bytes. */
export const OVERLAP_BYTES = 1024;
/** The largest buffer this module ever holds: one chunk plus the carry. Asserted by the tests (N2: by construction). */
export const MAX_BUFFER_BYTES = CHUNK_BYTES + OVERLAP_BYTES;

/**
 * The client-id shape: `<10+ digits>-<20+ lowercase alphanumerics>` followed by the Google OAuth suffix. Written as a
 * placeholder here rather than an example, because this file ships and `test/package-tree.test.ts` sweeps it for anything
 * that looks like a real id.
 *
 * No `` at either end, on purpose: in the real executable these strings sit inside a blob of other string data, so the
 * byte before an id is frequently a letter/digit (measured on this box: three ids present, zero found with the boundary).
 * The shape is distinctive enough without one.
 */
export const CLIENT_ID_PATTERN = /\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/gi;
/** Google's current client-secret shape. The older `~28 char` form is not matched: three of these were found in agy. */
export const CLIENT_SECRET_PATTERN = /GOCSPX-[A-Za-z0-9_-]{28}/g;

export interface ScanHit {
  value: string;
  /** Offset in the whole stream — the de-duplication key when a match is seen in two overlapping windows. */
  at: number;
}

/** Every match in one window, with its absolute offset. Pure, so the straddle logic is testable on strings. */
export function scanWindow(text: string, baseOffset: number): { ids: ScanHit[]; secrets: ScanHit[] } {
  const ids: ScanHit[] = [];
  const secrets: ScanHit[] = [];
  for (const match of text.matchAll(CLIENT_ID_PATTERN)) ids.push({ value: match[0], at: baseOffset + (match.index ?? 0) });
  for (const match of text.matchAll(CLIENT_SECRET_PATTERN)) secrets.push({ value: match[0], at: baseOffset + (match.index ?? 0) });
  return { ids, secrets };
}

/** De-duplicate by absolute offset + value, keeping first-seen order (a match in the carry was already counted). */
export function uniqueHits(hits: readonly ScanHit[]): ScanHit[] {
  const seen = new Set<string>();
  const out: ScanHit[] = [];
  for (const hit of hits) {
    const key = `${hit.at}:${hit.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export interface ScannedKeys {
  ids: string[];
  secrets: string[];
}

export const emptyKeys = (): ScannedKeys => ({ ids: [], secrets: [] });
