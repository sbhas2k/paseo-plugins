// agy-rotator-windows — the plugin's own state: `~/.paseo/plugin-data/agy-rotator-windows/index.json`, and the three slot
// operations the sidebar will call in slice 2.
//
// `index.json` is `{key, label, savedAt, lastUsage}[]` and nothing else: the secret bytes live in Credential Manager
// under `paseo-agy-accounts:<key>` (AC3), so this file is safe to read, copy or debug. Every write is atomic (temp
// file + rename) because a half-written index would hide slots the credentials still hold.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  planSave,
  removeSlotEntry,
  slotTarget,
  upsertSlot,
  parseSlotIndex,
  moveSlot,
  type SlotEntry,
  type SlotMove,
} from "../shared/slots.ts";
import { mergePolled, type PolledReading } from "../shared/polled.ts";
import { credDelete, credRead, credWrite } from "./cred.ts";
import { accountKey } from "./key.ts";

/** Same resolution as the other plugins: `PASEO_HOME` when the daemon sets it, else `~/.paseo`. */
export function paseoHome(): string {
  return process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
}

export function pluginDataDir(): string {
  return path.join(paseoHome(), "plugin-data", "agy-rotator-windows");
}

export function indexPath(): string {
  return path.join(pluginDataDir(), "index.json");
}

/**
 * The index plus whether reading it was LOSSLESS (S4, AC11): the Clean up button appears only when the file parsed and the
 * parser kept every row it found. "Not in the index" must never mean "lost", or a corrupt file would turn the vault's
 * real entries into orphans.
 */
export async function readIndexHealth(): Promise<{ entries: SlotEntry[]; health: { lossless: boolean; detail: string } }> {
  let text: string;
  try {
    text = await readFile(indexPath(), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { entries: [], health: { lossless: true, detail: "no index file yet" } };
    return { entries: [], health: { lossless: false, detail: error instanceof Error ? error.message : String(error) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [], health: { lossless: false, detail: "not JSON" } };
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { slots?: unknown } | null)?.slots;
  if (!Array.isArray(rows)) return { entries: [], health: { lossless: false, detail: "no slots array" } };
  const entries = parseSlotIndex(text);
  return {
    entries,
    health: entries.length === rows.length ? { lossless: true, detail: `${rows.length} rows` } : { lossless: false, detail: `${entries.length} of ${rows.length} rows kept` },
  };
}

/**
 * Run work inside the same queue as every index writer (S4, AC11): the Clean up census must not interleave with a save
 * whose credential write precedes its index line, or it would see a just-saved target as an orphan.
 */
export function exclusiveWrite<T>(work: () => Promise<T>): Promise<T> {
  return serialized(work);
}

/** The saved slots. A missing, corrupt or partly-bad file is an empty/partial index, never a throw at a caller. */
export async function readIndex(): Promise<SlotEntry[]> {
  try {
    return parseSlotIndex(await readFile(indexPath(), "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
}

async function writeIndex(entries: readonly SlotEntry[]): Promise<void> {
  const dir = pluginDataDir();
  await mkdir(dir, { recursive: true });
  const file = indexPath();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

/**
 * ONE queue for every index writer (review F-03).
 *
 * Every slot operation is read-modify-write on the whole of `index.json`: read, change one entry, rewrite the file. Two
 * of them interleaving lose an update — both read the same file, both write, the last writer wins, and an account saved
 * while a reorder was in flight disappears from the index while its credential stays behind. Serialising the writers is
 * the whole fix; a read (`readIndex`) is never queued, because the file is replaced atomically.
 */
let indexQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  // Run after whatever is queued, whether it succeeded or not — a failed rename must not wedge every later write.
  const run = indexQueue.then(work, work);
  indexQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** What a save landed on. `key`/`label` are repeated at the top level so callers do not reach through `entry`. */
export interface SavedSlot {
  key: string;
  label: string;
  target: string;
  entry: SlotEntry;
  isNew: boolean;
}

/**
 * Save the current sign-in as a slot: the blob's OWN `id_token_email` chooses the key and therefore the target, so a
 * third account signed in by hand is filed under itself (AC4 / R2-2). An unknown email gets `unsaved-<key[:6]>` until
 * the owner names it. Throws when the blob carries no email — it never guesses a key.
 */
async function saveSlotNow(blob: Buffer, now: string = new Date().toISOString()): Promise<SavedSlot> {
  const index = await readIndex();
  const plan = planSave(blob.toString("utf8"), index, now, accountKey);
  if (!plan.ok) throw new Error(`Not saving a slot: ${plan.reason}.`);
  await credWrite(plan.target, blob);
  try {
    await writeIndex(upsertSlot(index, plan.entry));
  } catch (error) {
    // The credential is written but the index cannot record it. Drop a NEW credential so a half-save leaves nothing
    // behind; a re-save of an existing slot keeps its (refreshed) blob, which is strictly better than deleting it.
    if (plan.isNew) await credDelete(plan.target).catch(() => false);
    throw error;
  }
  return { key: plan.entry.key, label: plan.entry.label, target: plan.target, entry: plan.entry, isNew: plan.isNew };
}

/** Give a slot the name its owner chose. The label is the only free text this plugin stores. */
async function renameSlotNow(key: string, label: string): Promise<SlotEntry> {
  const trimmed = label.trim().slice(0, 80);
  if (trimmed.length === 0) throw new Error("A slot needs a name.");
  const index = await readIndex();
  const entry = index.find((candidate) => candidate.key === key);
  if (!entry) throw new Error(`No saved account with key ${key}.`);
  const renamed: SlotEntry = { ...entry, label: trimmed };
  await writeIndex(upsertSlot(index, renamed));
  return renamed;
}

/**
 * Move one account one place in the owner's sequence (S3 ▲/▼). Rewrites `index.json` only — no credential is touched and
 * nothing is switched: the new order takes effect for the NEXT switch, which is what the owner asked for.
 */
async function reorderSlotNow(key: string, direction: SlotMove): Promise<{ moved: boolean; labels: string[] }> {
  const index = await readIndex();
  const result = moveSlot(index, key, direction);
  if (!result.moved) return { moved: false, labels: index.map((entry) => entry.label) };
  await writeIndex(result.index);
  return { moved: true, labels: result.index.map((entry) => entry.label) };
}

/**
 * Merge a live poll into the slot's index line (S4, R4-7): a poll can never carry the weekly, so it merges beside the
 * `/usage` reading and never replaces it. A slot with no reading gets one with `reading: null` — the account the feature
 * exists for has never been active.
 */
async function setPolledNow(key: string, polled: PolledReading): Promise<void> {
  const index = await readIndex();
  const entry = index.find((candidate) => candidate.key === key);
  if (!entry) return;
  const base = {
    at: entry.lastUsage?.at ?? polled.at,
    reading: entry.lastUsage?.reading ?? null,
    polled: entry.lastUsage?.polled ?? null,
  };
  const merged = mergePolled(base, polled);
  await writeIndex(upsertSlot(index, { ...entry, lastUsage: merged }));
}

/** Remember a slot's last reading (the index only — no credential is touched). */
async function setSlotUsageNow(key: string, lastUsage: SlotEntry["lastUsage"]): Promise<void> {
  const index = await readIndex();
  const entry = index.find((candidate) => candidate.key === key);
  if (!entry) return;
  await writeIndex(upsertSlot(index, { ...entry, lastUsage }));
}

/** The slot's blob, or null when the credential is gone (the index still lists it — a stale line, not a secret). */
export async function loadSlot(key: string): Promise<Buffer | null> {
  return credRead(slotTarget(key));
}

/** Remove the slot's credential and its index line. False when there was nothing to remove. */
async function removeSlotNow(key: string): Promise<boolean> {
  const target = slotTarget(key);
  const existed = await credDelete(target);
  const index = await readIndex();
  const remaining = removeSlotEntry(index, key);
  if (remaining.length !== index.length) await writeIndex(remaining);
  return existed || remaining.length !== index.length;
}

// The public surface: every writer goes through the queue, so two of them can never lose each other's update.

/** Save the current sign-in as a slot (serialised). */
export function saveSlot(blob: Buffer, now: string = new Date().toISOString()): Promise<SavedSlot> {
  return serialized(() => saveSlotNow(blob, now));
}

/** Give a slot the name its owner chose (serialised). */
export function renameSlot(key: string, label: string): Promise<SlotEntry> {
  return serialized(() => renameSlotNow(key, label));
}

/** Merge a live poll into a slot (serialised). */
export function setPolled(key: string, polled: PolledReading): Promise<void> {
  return serialized(() => setPolledNow(key, polled));
}

/** Remember a slot's last reading (serialised). */
export function setSlotUsage(key: string, lastUsage: SlotEntry["lastUsage"]): Promise<void> {
  return serialized(() => setSlotUsageNow(key, lastUsage));
}

/** Remove the slot's credential and its index line (serialised). */
export function removeSlot(key: string): Promise<boolean> {
  return serialized(() => removeSlotNow(key));
}

/** Move one account one place in the sequence (serialised). */
export function reorderSlot(key: string, direction: SlotMove): Promise<{ moved: boolean; labels: string[] }> {
  return serialized(() => reorderSlotNow(key, direction));
}
