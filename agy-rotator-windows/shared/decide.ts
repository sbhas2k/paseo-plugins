// agy-rotator-windows — the switch rule, pure (no Paseo, no filesystem, no clock of its own: `now` is a parameter), so the
// daemon and the tests decide from one function.
//
// Plan §3.3 / AC2, and the evidence behind it:
//  - `remaining_fraction` is REMAINING, so the owner's "switch at 80% used" is `<= 0.20` (challenger F8);
//  - trigger on EITHER Gemini bucket, 5h or weekly; the 3p group is shown, never a trigger (F5);
//  - a turn that ends `failed` with `code "credits_exhausted"` triggers whatever the fractions say (F11);
//  - `reset_time` is a fixed-start window anchored at first use, so a bucket past its reset time counts as refilled —
//    that is what makes an inactive saved account usable again (F10);
//  - the candidate must be better on BOTH Gemini buckets (asymmetric on purpose: it is cheap to be strict when we are
//    about to spend the owner's other account);
//  - S3 (owner 2026-10-26: *"1st one. But we should let user move the account up n down"*): accounts are used IN
//    SEQUENCE. Walk the owner's order starting AFTER the active account and wrap to the top; the first account that
//    qualifies wins. "Most room" is gone — with four accounts the owner wants a predictable rotation, not a fitness
//    contest, and the ▲/▼ buttons are how they change it.

import type { UsageBucket, UsageReading } from "./usage.ts";
import { freshestFiveHour, type PolledReading } from "./polled.ts";

export type { UsageBucket, UsageReading } from "./usage.ts";

export const DEFAULT_THRESHOLD = 0.2;

export interface ActiveAccount {
  /** null when the live entry is unknown (an unsaved sign-in); decide() then only acts on an outcome. */
  key: string | null;
  label: string | null;
  reading: UsageReading | null;
}

export interface SlotState {
  key: string;
  label: string;
  /** The slot's last `/usage` reading, or null if it has never been read. */
  reading: UsageReading | null;
  /** When that reading was taken — it competes with `polled.at` for the 5-hour figure (S4, R4-1). */
  readingAt?: string | null;
  /** The live 5-hour poll (S4): the fresher 5-hour figure wins, and a poll never carries a weekly. */
  polled?: PolledReading | null;
  /** Set when the poller's locked pair answered `invalid_grant`: shown, skipped by the rule, refused by Switch. */
  needsSignIn?: boolean;
}

/** The SDK's `PluginTurnOutcome` (lifecycle.d.ts), narrowed to what the rule reads. */
export type TurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export type Decision =
  | { action: "switch"; key: string; label: string; reason: string; triggeredBy: string[]; weeklyUnknown?: boolean }
  | { action: "stay"; reason: string; triggeredBy: string[] };

/** A bucket's fraction now: past its reset time it is refilled (F10); unknown stays unknown. */
function effective(bucket: UsageBucket | null, now: number): number | null {
  if (!bucket) return null;
  if (bucket.resetsAt !== null) {
    const reset = Date.parse(bucket.resetsAt);
    if (Number.isFinite(reset) && reset <= now) return 1;
  }
  return Number.isFinite(bucket.remaining) ? bucket.remaining : null;
}

/** The room a reading shows: its tighter Gemini bucket, or null when either is unknown. */
function room(reading: UsageReading | null, now: number): number | null {
  if (!reading) return null;
  const five = effective(reading.gemini5h, now);
  const weekly = effective(reading.geminiWeekly, now);
  if (five === null || weekly === null) return null;
  return Math.min(five, weekly);
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

/**
 * Should the plugin move to another saved account?
 *
 * `threshold` is the fraction LEFT at which the active account is considered used up (0.20 = switch at 80% used).
 * `outcome` is the turn that just ended, when there was one. `now` defaults to the clock; the tests pass a fixed one.
 */
export function decide(
  active: ActiveAccount,
  slots: readonly SlotState[],
  threshold: number = DEFAULT_THRESHOLD,
  outcome?: TurnOutcome,
  now: number = Date.now(),
): Decision {
  const triggeredBy: string[] = [];
  if (outcome?.kind === "failed" && outcome.error.code === "credits_exhausted") {
    triggeredBy.push("credits_exhausted");
  }

  const five = effective(active.reading?.gemini5h ?? null, now);
  const weekly = effective(active.reading?.geminiWeekly ?? null, now);
  if (five !== null && five <= threshold) triggeredBy.push(`gemini-5h has ${pct(five)} left`);
  if (weekly !== null && weekly <= threshold) triggeredBy.push(`gemini-weekly has ${pct(weekly)} left`);

  const activeLabel = active.label ?? "the active account";
  if (triggeredBy.length === 0) {
    const shown = [five === null ? null : `gemini-5h ${pct(five)} left`, weekly === null ? null : `gemini-weekly ${pct(weekly)} left`]
      .filter((text): text is string => text !== null)
      .join(", ");
    return { action: "stay", reason: `staying on ${activeLabel}${shown ? ` (${shown})` : " (no quota reading)"}`, triggeredBy };
  }

  // S3: walk the owner's sequence. `slots` arrives in order (index.json's `order`); start AFTER the active account and
  // wrap to the top, so 1→2→3→4→1 and a 4th account's switch goes back to the 1st. The active account is never a target.
  //
  // S4 (R4-1): a candidate's 5-hour figure is the FRESHER of its live poll and its last `/usage` reading, because a poll
  // cannot return the weekly (spike Q1.5). A **known** weekly still needs both buckets above the threshold; an **unknown**
  // weekly — an account that has never been active — qualifies on 5 hours alone, and the reason says so, because the
  // post-switch check is what will confirm it. A slot that needs a sign-in is never a candidate (R4-6).
  const start = slots.findIndex((slot) => slot.key === active.key);
  const walk: Array<{ slot: SlotState; room: number; position: number; weeklyUnknown: boolean }> = [];
  for (let step = 1; step <= slots.length; step++) {
    // A fresh unsaved account is not in the list: its walk starts at the top.
    const index = start === -1 ? step - 1 : (start + step) % slots.length;
    const slot = slots[index];
    if (!slot || slot.key === active.key) continue;
    if (slot.needsSignIn) continue;
    const five = effective(freshestFiveHour({ usage: slot.reading === null ? null : { at: slot.readingAt ?? "", reading: slot.reading }, polled: slot.polled ?? null }), now);
    if (five === null || five <= threshold) continue;
    const weekly = effective(slot.reading?.geminiWeekly ?? null, now);
    const weeklyUnknown = weekly === null;
    if (!weeklyUnknown && weekly <= threshold) continue;
    walk.push({ slot, room: weeklyUnknown ? five : Math.min(five, weekly ?? 0), position: index + 1, weeklyUnknown });
  }
  const candidates = walk;

  const best = candidates[0];
  if (!best) {
    return {
      action: "stay",
      reason: `no saved account has room in the sequence (${triggeredBy.join("; ")})`,
      triggeredBy,
    };
  }
  const gap = best.weeklyUnknown ? " · weekly unknown - post-switch check will confirm" : "";
  return {
    action: "switch",
    key: best.slot.key,
    label: best.slot.label,
    reason: `${triggeredBy.join("; ")} - next in sequence is ${best.slot.label} (position ${best.position}, ${pct(best.room)} left)${gap}`,
    triggeredBy,
    weeklyUnknown: best.weeklyUnknown,
  };
}
