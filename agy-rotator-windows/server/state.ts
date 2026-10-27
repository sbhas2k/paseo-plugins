// agy-rotator-windows — what the plugin must remember across a daemon restart, in its own data directory.
//
// S2 kept `expected` in memory only: a restart primed it from whatever was live, which is the same answer the re-assert
// would reach — but the ping-pong guard then started from zero, so an automatic switch could fire seconds after a manual
// one. This file fixes that, and keeps the last switch's label so the owner-terminal reminder still has something to say
// after a restart.
//
// It is a SEPARATE file from `index.json` on purpose: `index.json` stays exactly `{key,label,savedAt,lastUsage}[]`, so
// AC3's "no secret in plugin-data" guarantee is unchanged by this and a slot write can never drop the switch state.
// Nothing here is a secret: a 16-hex key, a label the owner typed, two timestamps.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pluginDataDir } from "./store.ts";

export interface PluginStateFile {
  /** The account the plugin believes is active. The key is the hashed email. */
  expected: { key: string; label: string } | null;
  /** When the plugin last switched, manual or automatic (RFC3339). */
  lastSwitchAt: string | null;
  /** The last switch, kept for the "N agy terminal(s) are still on <old label>" reminder. */
  lastSwitch: { at: string; fromLabel: string | null; toKey: string; toLabel: string } | null;
  updatedAt: string;
}

export const emptyPluginState = (): PluginStateFile => ({ expected: null, lastSwitchAt: null, lastSwitch: null, updatedAt: "" });

export function pluginStatePath(): string {
  return path.join(pluginDataDir(), "state.json");
}

const KEY = /^[a-z0-9]{1,64}$/;

/** Never throws: a corrupt state file is an empty state, and the plugin then learns from the live entry as before. */
export async function readPluginState(): Promise<PluginStateFile> {
  let text: string;
  try {
    text = await readFile(pluginStatePath(), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return emptyPluginState();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyPluginState();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyPluginState();
  const record = parsed as Record<string, unknown>;
  const state = emptyPluginState();
  state.expected = asAccount(record.expected);
  state.lastSwitchAt = asTime(record.lastSwitchAt);
  state.lastSwitch = asSwitch(record.lastSwitch);
  state.updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : "";
  return state;
}

/** Atomic write (temp + rename): a half-written state file would hide the previous account from the guard. */
export async function writePluginState(state: PluginStateFile): Promise<void> {
  const dir = pluginDataDir();
  await mkdir(dir, { recursive: true });
  const file = pluginStatePath();
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function asAccount(value: unknown): { key: string; label: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !KEY.test(record.key)) return null;
  if (typeof record.label !== "string" || record.label.trim().length === 0) return null;
  return { key: record.key, label: record.label };
}

function asTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function asSwitch(value: unknown): PluginStateFile["lastSwitch"] {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const at = asTime(record.at);
  const toKey = typeof record.toKey === "string" && KEY.test(record.toKey) ? record.toKey : null;
  const toLabel = typeof record.toLabel === "string" && record.toLabel.trim().length > 0 ? record.toLabel : null;
  if (at === null || toKey === null || toLabel === null) return null;
  return { at, fromLabel: typeof record.fromLabel === "string" ? record.fromLabel : null, toKey, toLabel };
}
