// agy-rotator-windows — the automatic switch: `decide()` plus the three things a button-press does not need.
//
// Plan §3.2/§3.3, and the two guards the plan states:
//  - DEBOUNCE. The turn-end trigger is evaluated at most once per `/usage` cache TTL (120 s). A turn end is a cheap
//    event and a chat can end several turns a minute; each evaluation without this would spawn a 10-second `agy`.
//  - PING-PONG. No automatic switch within ten minutes of the previous one. `reset_time` is a fixed-start window (F10),
//    so the intended A→B→A cycle is hours apart; two switches inside ten minutes is a pair of accounts flapping around
//    the threshold, or a reading that has not caught up with the switch that just happened. The owner's own Switch
//    button is not affected — this guards only what the plugin does on its own.
//
// The one override is `credits_exhausted`: the account is out right now (F11), so there is nothing to wait for.
//
// Pure: no Paseo, no `node:` import.

import { decide, type ActiveAccount, type SlotState, type TurnOutcome, type UsageBucket, type UsageReading } from "./decide.ts";

/** Ten minutes. Not a setting: it is a safety rail, not a preference. */
export const MIN_SWITCH_GAP_MS = 10 * 60_000;

/** The `/usage` cache TTL, which is also the turn-end debounce (plan §3.2: "debounce ≥ cache TTL"). */
export const EVALUATE_GAP_MS = 120_000;

export interface AutoInput {
  /** The plugin setting. Off means the plugin never switches on its own. */
  enabled: boolean;
  /** Fraction LEFT at which the active account is considered used up (the setting, default 0.20). */
  threshold: number;
  active: ActiveAccount;
  slots: readonly SlotState[];
  /** The turn that just ended, when this evaluation follows one. */
  outcome?: TurnOutcome;
  /** Epoch ms of the last switch (manual or automatic), or null. */
  lastSwitchAt: number | null;
  now: number;
  /** True while a switch is running — never start a second one. */
  inFlight?: boolean;
  minGapMs?: number;
  /**
   * S4 / R4-2: this evaluation is the post-switch check (the reading of the account we just moved to). It may spend the
   * ONE extra hop past the ping-pong guard; `postSwitchHops` says how many have been spent since a normal trigger.
   */
  postSwitch?: boolean;
  postSwitchHops?: number;
}

export type AutoOutcome =
  | { kind: "switch"; key: string; label: string; reason: string; triggeredBy: string[]; bypassedGuard: boolean; postSwitch: boolean }
  | { kind: "stay"; reason: string; triggeredBy: string[] };

const CREDITS_EXHAUSTED = "credits_exhausted";

/** Should the plugin switch by itself, and if not, why not — one line the tick and the screen both show. */
export function autoDecide(input: AutoInput): AutoOutcome {
  if (input.inFlight) return { kind: "stay", reason: "a switch is already in flight", triggeredBy: [] };
  if (!input.enabled) return { kind: "stay", reason: "automatic switching is off", triggeredBy: [] };
  // One extra hop per cycle of triggers. A post-switch check that finds the new account ALSO at the setpoint means the two
  // accounts are both exhausted; hopping a third time would be a page-flip between them, so it stops here.
  if (input.postSwitch === true && (input.postSwitchHops ?? 0) >= 1) {
    return { kind: "stay", reason: "post-switch hop already used - not hopping again", triggeredBy: [] };
  }

  const decision = decide(input.active, input.slots, input.threshold, input.outcome, input.now);
  if (decision.action === "stay") return { kind: "stay", reason: decision.reason, triggeredBy: decision.triggeredBy };

  const exhausted = decision.triggeredBy.includes(CREDITS_EXHAUSTED);
  const gap = input.minGapMs ?? MIN_SWITCH_GAP_MS;
  const since = input.lastSwitchAt === null ? null : input.now - input.lastSwitchAt;
  const tooSoon = since !== null && since < gap;

  const postSwitch = input.postSwitch === true;
  if (tooSoon && !exhausted && !postSwitch) {
    const minutes = Math.max(1, Math.round((gap - (since ?? 0)) / 60_000));
    return {
      kind: "stay",
      reason: `switched ${Math.round((since ?? 0) / 60_000)} min ago - not again for another ${minutes} min (${decision.reason})`,
      triggeredBy: decision.triggeredBy,
    };
  }

  return {
    kind: "switch",
    key: decision.key,
    label: decision.label,
    reason: decision.reason,
    triggeredBy: decision.triggeredBy,
    bypassedGuard: tooSoon && (exhausted || postSwitch),
    postSwitch,
  };
}

/**
 * What to record for the account we are leaving BECAUSE it ran out (F-11's `credits_exhausted`, which bypasses the
 * ping-pong guard).
 *
 * Without this the departing slot keeps saying "80 % left", so the very next failed turn on the other account would move
 * straight back — two exhausted accounts bouncing A↔B, guard bypassed both times (Gemini review F-01). Writing BOTH
 * Gemini buckets to zero makes the departing account ineligible until its own window refills: `decide()` reads a past
 * `resetsAt` as refilled (F10), so the zero lifts exactly when the quota does. The reset times are kept; when the CLI
 * reported none, a synthetic one a guard's length away is used so the zero can never be permanent. The 3p buckets are
 * left alone — they never trigger anything.
 */
export function exhaustedReading(reading: UsageReading | null, now: number, minGapMs: number = MIN_SWITCH_GAP_MS): UsageReading {
  const fallback = new Date(now + minGapMs).toISOString();
  const zero = (bucket: UsageBucket | null | undefined): UsageBucket => ({
    remaining: 0,
    resetsAt: bucket?.resetsAt ?? fallback,
  });
  return {
    gemini5h: zero(reading?.gemini5h),
    geminiWeekly: zero(reading?.geminiWeekly),
    threep5h: reading?.threep5h ?? null,
    threepWeekly: reading?.threepWeekly ?? null,
  };
}

/** The turn-end debounce. `force` is `credits_exhausted`: an account that is out must not wait for a TTL. */
export function debounceElapsed(lastAt: number | null, now: number, gapMs: number, force = false): boolean {
  if (force) return true;
  if (lastAt === null) return true;
  return now - lastAt >= gapMs;
}
