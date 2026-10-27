import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// agy-rotator-windows — the setting the owner edits (S3, owner 2026-10-26: *"Also 80 % auto switch should be configurable. We
// should let use put any values that want. 100 should give error"*).
//
// The setting is expressed the way the owner thinks about it — **"Switch when used ≥ N %"** — while `decide()` keeps
// working in REMAINING terms (`remaining <= threshold`, unchanged since S1). `thresholdFromUsedPct` is the only place the
// two meet. 100 is refused on purpose: at 100 % used the account is already empty, so the account would never be swapped
// before it ran dry — an error, not a preference.
//
// Stored in the plugin's own settings document (Settings → Plugins → agy accounts, or
// `<paseoHome>/plugin-settings/agy-rotator-windows/config.json`), so the screen and the daemon read the same values.

export const MIN_USED_PCT = 1;
export const MAX_USED_PCT = 99;

export const AgyAccountsSettingsSchema = z.object({
  /** Automatic switching at all. Off leaves Save / Switch / Remove working; only the plugin's own trigger stops. */
  autoSwitch: z.boolean().default(true),
  /** Switch away when the active account has USED at least this percent of its Gemini quota. 1..99; 100 is an error. */
  switchWhenUsedPct: z.number().min(MIN_USED_PCT).max(MAX_USED_PCT).default(80),
  /** Is the "How this works" section on the screen open? The owner's own preference, default closed. */
  helpOpen: z.boolean().default(false),
});

export type AgyAccountsSettings = z.output<typeof AgyAccountsSettingsSchema>;

export const agyAccountsSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: AgyAccountsSettingsSchema,
  migrate: (values) => values,
});

/** (100 − N) / 100: "switch at 80 % used" is "0.20 left" in `decide()`. */
export function thresholdFromUsedPct(usedPct: number): number {
  return Math.round((100 - usedPct) * 1000) / 100_000;
}

/** The reverse, for the screen's status line: "auto-switch at ≥ 80 % used". */
export function usedPctFromThreshold(threshold: number): number {
  return Math.round((1 - threshold) * 1000) / 10;
}

export type UsedPctValidation = { ok: true; usedPct: number; threshold: number } | { ok: false; error: string };

const BETWEEN = `Enter a number between ${MIN_USED_PCT} and ${MAX_USED_PCT}.`;

/**
 * One string from the screen's number input → the setting, or a message the owner can act on. Never coerces: `""` is not
 * 0, `"abc"` is not NaN, and 100 is not 99.
 */
export function parseUsedPct(raw: string | number): UsedPctValidation {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (text.length === 0) return { ok: false, error: `Nothing entered. ${BETWEEN}` };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `${JSON.stringify(text)} is not a number. ${BETWEEN}` };
  if (value === 100) return { ok: false, error: "100% would never switch before the account is empty - use 99 or less." };
  if (value > MAX_USED_PCT) return { ok: false, error: `${value} is above 99 - use 99 or less.` };
  if (value < MIN_USED_PCT) return { ok: false, error: `${value} is too low. ${BETWEEN} At 1% the account is switched away almost unused.` };
  return { ok: true, usedPct: value, threshold: thresholdFromUsedPct(value) };
}
