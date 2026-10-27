// agy-rotator-windows — slots: where a saved sign-in lives and what `index.json` is allowed to say about it.
//
// Plan §3.1 + AC3/AC4, with the challenger rulings behind each rule:
//  - a slot is its own Generic credential (type 1, persist 2, user `antigravity`) under
//    `paseo-agy-accounts:<key>` — deliberately OUTSIDE the `gemini:` prefix, which `agy`'s go-keyring `DeleteAll`
//    sweeps on a `/logout` (R2-1);
//  - keyed by the blob's OWN `id_token_email`, never by "the account we expected" (R2-2/AC4), so a third account
//    signed in by hand is filed under itself and cannot overwrite another slot;
//  - `index.json` holds `{key, label, savedAt, lastUsage}` and nothing else: no blob, no email, no token (AC3).
//
// Pure in the strict sense: no Paseo import, no `node:` import, no filesystem, no spawn — this file is bundled into the
// plugin's shared bundle, which the build refuses to let near a server-only module. So the key function is a PARAMETER
// (`keyOf`), passed in by `server/store.ts` as `accountKey`. `node --test` runs it directly.

import type { UsageReading } from "./usage.ts";
import { parsePolled, type PolledReading } from "./polled.ts";

/** Slot target prefix. Never `gemini:` — see R2-1 above. */
export const SLOT_PREFIX = "paseo-agy-accounts:";
/** The live sign-in `agy` itself reads and writes. Only a Switch ever writes this target. */
export const LIVE_TARGET = "gemini:antigravity";
/** The generic credential's user name, as `agy` writes it (F1, challenger F15). */
export const CREDENTIAL_USER = "antigravity";
/** CRED_TYPE_GENERIC. */
export const CREDENTIAL_TYPE_GENERIC = 1;
/** CRED_PERSIST_LOCAL_MACHINE. */
export const CREDENTIAL_PERSIST_LOCAL_MACHINE = 2;

/** One line of `~/.paseo/plugin-data/agy-rotator-windows/index.json`. Never contains a secret. */
export interface SlotEntry {
  key: string;
  label: string;
  /** When the slot's credential was last written (RFC3339). */
  savedAt: string;
  /**
   * The slot's last `/usage` reading, for the usage summary while it is not the active account (R2-6), plus — S4 — the
   * live 5-hour poll that sits BESIDE it (`polled`), because no endpoint can return the weekly (plan §3.7, R4-7).
   */
  lastUsage: {
    at: string;
    /**
     * The last `/usage` reading, or null for a slot the poller knows and `/usage` never read — the account this whole
     * feature exists for (e.g. a second account right after it is saved) has never been active, so it has a polled 5-hour and no reading at all.
     */
    reading: UsageReading | null;
    polled?: PolledReading | null;
  } | null;
  /**
   * Position in the owner's sequence (S3, owner 2026-10-26: *"1st one. But we should let user move the account up n
   * down"*). 0-based and contiguous after a read; a switch starts AFTER the active account's position and wraps. A new
   * save appends at the end.
   */
  order: number;
}

export type SavePlan =
  | { ok: true; target: string; entry: SlotEntry; isNew: boolean }
  | { ok: false; reason: string };

/** Keys are hex from `accountKey`; a target must not be able to escape the prefix. */
const KEY_PATTERN = /^[a-z0-9]{1,64}$/;

/** `paseo-agy-accounts:<key>` — refuses anything that is not a plain key. */
export function slotTarget(key: string): string {
  if (!KEY_PATTERN.test(key)) throw new Error(`Refusing slot key ${JSON.stringify(key)}: not a plain key.`);
  return `${SLOT_PREFIX}${key}`;
}

/** The label an unknown account is saved under until the owner names it. */
export function unsavedLabel(key: string): string {
  return `unsaved-${key.slice(0, 6)}`;
}

/**
 * The `id_token_email` inside a live blob, or null. The email is used to compute the key and then dropped —
 * it is never returned to a caller that could log it, and never stored.
 */
export function readBlobEmail(blobText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blobText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const email = (parsed as Record<string, unknown>).id_token_email;
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * What saving this blob means: which slot target, which label, whether it is a new slot. The blob's own email
 * decides; an unknown email becomes `unsaved-<key[:6]>` and an existing slot keeps the label its owner gave it.
 * Nothing is written here — the caller writes the credential and then the index.
 */
export function planSave(
  blobText: string,
  index: readonly SlotEntry[],
  now: string,
  keyOf: (email: string) => string,
): SavePlan {
  const email = readBlobEmail(blobText);
  if (email === null) return { ok: false, reason: "the live entry carries no id_token_email" };
  const key = keyOf(email);
  const existing = index.find((entry) => entry.key === key);
  return {
    ok: true,
    target: slotTarget(key),
    isNew: existing === undefined,
    entry: {
      key,
      label: existing?.label ?? unsavedLabel(key),
      savedAt: now,
      lastUsage: existing?.lastUsage ?? null,
      // A new account joins the end of the sequence; a re-save keeps the position its owner gave it.
      order: existing?.order ?? index.length,
    },
  };
}

/** Replaces the entry with the same key, or appends it. Never reorders the index. */
export function upsertSlot(index: readonly SlotEntry[], entry: SlotEntry): SlotEntry[] {
  const at = index.findIndex((candidate) => candidate.key === entry.key);
  if (at === -1) return [...index, entry];
  return index.map((candidate, position) => (position === at ? entry : candidate));
}

export function removeSlotEntry(index: readonly SlotEntry[], key: string): SlotEntry[] {
  return index.filter((entry) => entry.key !== key);
}

/** `index.json` read back: an unknown or corrupt file is an empty index, and one bad line is dropped, not fatal. */
export function parseSlotIndex(text: string): SlotEntry[] {
  if (text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(rows)) return [];
  const entries: Array<Omit<SlotEntry, "order"> & { order: number | null }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const key = record.key;
    const label = record.label;
    const savedAt = record.savedAt;
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) continue;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    if (typeof savedAt !== "string" || savedAt.trim().length === 0) continue;
    entries.push({ key, label, savedAt, lastUsage: parseLastUsage(record.lastUsage), order: parseOrder(record.order) });
  }
  // An `index.json` written before S3 has no `order`: the saved-at time is the only history there is, so it decides the
  // sequence once and the next write persists it. Either way the result is sorted and renumbered 0..n-1, so callers can
  // trust that position === index.
  return entries
    .map((entry, position) => ({ entry, position }))
    .sort((a, b) => (a.entry.order ?? Number.MAX_SAFE_INTEGER) - (b.entry.order ?? Number.MAX_SAFE_INTEGER) || Date.parse(a.entry.savedAt) - Date.parse(b.entry.savedAt) || a.position - b.position)
    .map(({ entry }, position) => ({ ...entry, order: position }));
}

/** A stored order, or null when the file has none (older than S3, or hand-edited). */
function parseOrder(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export type SlotMove = "up" | "down";

/**
 * Move one account one place in the sequence (S3: ▲/▼). Returns the new index and whether anything moved — an account
 * already at an end does not. The list is renumbered so positions stay contiguous, and nothing else about a slot changes.
 */
export function moveSlot(index: readonly SlotEntry[], key: string, direction: SlotMove): { index: SlotEntry[]; moved: boolean } {
  const ordered = [...index].sort((a, b) => a.order - b.order);
  const at = ordered.findIndex((entry) => entry.key === key);
  const to = direction === "up" ? at - 1 : at + 1;
  if (at === -1 || to < 0 || to >= ordered.length) return { index: [...index], moved: false };
  const swapped = [...ordered];
  const [moved] = swapped.splice(at, 1);
  swapped.splice(to, 0, moved);
  return { index: swapped.map((entry, position) => ({ ...entry, order: position })), moved: true };
}

function parseLastUsage(value: unknown): SlotEntry["lastUsage"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string") return null;
  const reading = typeof record.reading === "object" && record.reading !== null ? (record.reading as UsageReading) : null;
  const polled = record.polled === undefined ? null : parsePolled(record.polled);
  // Neither half usable is not a record at all.
  if (reading === null && polled === null) return null;
  return { at: record.at, reading, polled };
}
