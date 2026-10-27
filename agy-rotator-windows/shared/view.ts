// agy-rotator-windows — the one payload the sidebar screen and the RPCs are built from (AC7).
//
// Assembled here, once, so the screen cannot leak what it was never handed: labels, keys, percentages, timestamps. No
// email, no blob, no token field — a slot's figures are numbers and RFC3339 text, nothing else.
//
// The active account's figures come from the LIVE reading (`/usage` for the signed-in account only, plan §3.2); an
// inactive slot shows the reading stored with it (F10: past its `reset_time` it counts as refilled, and S3's rule
// already reads it that way).

import { decide, DEFAULT_THRESHOLD, type Decision } from "./decide.ts";
import type { SlotEntry } from "./slots.ts";
import type { UsageBucket, UsageReading } from "./usage.ts";
import type { PolledReading } from "./polled.ts";

/** One bucket, display-ready: percent LEFT (rounded), and the reset time as the CLI printed it. */
export interface BucketView {
  remainingPct: number;
  resetsAt: string | null;
}

export interface UsageView {
  gemini5h: BucketView | null;
  geminiWeekly: BucketView | null;
  threep5h: BucketView | null;
  threepWeekly: BucketView | null;
}

export interface SlotView {
  key: string;
  label: string;
  savedAt: string;
  /** Position in the owner's sequence, 1-based ("1", "2", … on the card). */
  position: number;
  active: boolean;
  usage: UsageView | null;
  /** When `usage` was taken (RFC3339), or null when this slot has never been read. */
  usageAt: string | null;
  /** `live` = read just now from the signed-in account; `stored` = its last `/usage`; `polled` = the live 5-hour poll. */
  source: "live" | "stored" | "polled" | null;
  /** S4: when the live 5-hour poll last answered for this slot (RFC3339), or null. */
  polledAt: string | null;
  /** S4 (R4-6): this slot's grant is dead — sign in with the CLI and save again. */
  needsSignIn: boolean;
}

/** A switch in flight, so the screen can count "n of m agents restarted" (S3, the owner's "it takes time" note). */
export interface SwitchProgressView {
  key: string;
  label: string;
  total: number;
  done: number;
  failed: number;
  /** RFC3339. */
  startedAt: string;
  /** Milliseconds once finished, null while running. */
  ms: number | null;
  finished: boolean;
}

export interface StatePayload {
  /** In the owner's sequence order; `position` is its 1-based place. */
  slots: SlotView[];
  active: { key: string; label: string } | null;
  /** The live entry is missing (an owner's `/logout`, or a fresh machine). */
  signedOut: boolean;
  /** When the plugin last read the live entry, RFC3339. */
  lastCheckAt: string | null;
  /** When the next automatic check is due, RFC3339 — "next check HH:MM". */
  nextCheckAt: string | null;
  /** The owner's setting: "switch when used ≥ N %". */
  switchWhenUsedPct: number;
  /** The same setting in REMAINING terms (what the rule compares). */
  threshold: number;
  /** The plugin setting that lets the owner stop automatic switching. */
  autoEnabled: boolean;
  /** When the plugin last switched, manual or automatic (RFC3339). */
  lastSwitchAt: string | null;
  /** What the rule would do now, and why. */
  decision: { action: "switch" | "stay"; reason: string } | null;
  switching: SwitchProgressView | null;
  /** Owner terminals started before the switch that still hold the old account (F8). */
  staleTerminals: { count: number; fromLabel: string | null } | null;
  /** S4: the live poll's state, with a note when it cannot run. */
  livePolling: { state: "unknown" | "locked" | "unresolved" | "unavailable" | "refused"; note: string };
  /** S4 (AC11): the Clean up label, when a census has been taken. */
  cleanup: { count: number; label: string } | null;
  /** S4: when the poller last finished a cycle, RFC3339. */
  lastPollAt: string | null;
}

export interface UsageLike {
  at: number;
  kind: string;
  reading: UsageReading | null;
  message?: string;
}

export interface StateInput {
  index: readonly SlotEntry[];
  expected: { key: string; label: string } | null;
  signedOut: boolean;
  /** Milliseconds since the epoch, or null when nothing has been read yet. */
  lastCheckAt: number | null;
  threshold?: number;
  /** The active account's reading, if it has been read. */
  live: UsageLike | null;
  /** The turn that just ended, when this payload follows one. */
  outcome?: Parameters<typeof decide>[3];
  /** S3: the setting in the owner's own units, if the caller knows it (defaults from `threshold`). */
  switchWhenUsedPct?: number;
  /** S3: automatic switching enabled (the setting). */
  autoEnabled?: boolean;
  /** S3: when the next automatic check is due, epoch ms. */
  nextCheckAt?: number | null;
  /** S3: the switch running right now, if any. */
  switching?: SwitchProgressView | null;
  /** S3: owner terminals that still hold the previous account. */
  staleTerminals?: { count: number; fromLabel: string | null } | null;
  /** S3: when the plugin last switched, RFC3339. */
  lastSwitchAt?: string | null;
  /** S4: keys whose grant is dead (in memory in the daemon). */
  needsSignIn?: readonly string[];
  /** S4: the live poll per key, which may be fresher than the slot's `/usage` reading. */
  polled?: Readonly<Record<string, PolledReading | null>>;
  /** S4: the live poll's state. */
  livePolling?: { state: "unknown" | "locked" | "unresolved" | "unavailable" | "refused"; note: string };
  /** S4: the Clean up label. */
  cleanup?: { count: number; label: string } | null;
  /** S4: when the poller last ran, epoch ms. */
  lastPollAt?: number | null;
  /**
   * The instant the rule is evaluated at. Production omits it (the real clock); a test MUST pass one, because a
   * fixture's `resetsAt` in the past counts as refilled (F10) and would silently flip the verdict once wall time passes
   * it.
   */
  now?: number;
}

const pct = (bucket: UsageBucket | null): BucketView | null =>
  bucket === null ? null : { remainingPct: Math.round(bucket.remaining * 100), resetsAt: bucket.resetsAt };

const view = (reading: UsageReading | null): UsageView | null =>
  reading === null
    ? null
    : {
        gemini5h: pct(reading.gemini5h),
        geminiWeekly: pct(reading.geminiWeekly),
        threep5h: pct(reading.threep5h),
        threepWeekly: pct(reading.threepWeekly),
      };

export function buildStatePayload(input: StateInput): StatePayload {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const liveReading = input.live?.reading ?? null;
  const liveAt = input.live?.reading ? new Date(input.live.at).toISOString() : null;
  const activeKey = input.expected?.key ?? null;

  // The index arrives in sequence order (parseSlotIndex sorts and renumbers); `position` is that place, 1-based.
  const slots: SlotView[] = [...input.index]
    .sort((a, b) => a.order - b.order)
    .map((entry, index) => {
      const active = activeKey !== null && entry.key === activeKey;
      const position = index + 1;
      const polledAt = entry.lastUsage?.polled?.at ?? null;
      const polled5h = entry.lastUsage?.polled?.gemini5h ?? null;
      if (active && liveReading !== null) {
        // The active account's figures are `/usage`'s own: fresher than any poll and it always carries the weekly.
        return {
          key: entry.key,
          label: entry.label,
          savedAt: entry.savedAt,
          position,
          active,
          usage: view(liveReading),
          usageAt: liveAt,
          source: "live",
          polledAt,
          needsSignIn: false,
        };
      }
      const stored = entry.lastUsage?.reading ?? null;
      // S4: the 5-hour figure may come from the live poll while the weekly can only come from `/usage` (or be unknown).
      const usage = view(stored) ?? (polled5h === null ? null : { gemini5h: pct(polled5h), geminiWeekly: null, threep5h: null, threepWeekly: null });
      if (usage !== null && polled5h !== null) usage.gemini5h = pct(polled5h);
      const source: SlotView["source"] = stored !== null ? "stored" : polled5h !== null ? "polled" : null;
      return {
        key: entry.key,
        label: entry.label,
        savedAt: entry.savedAt,
        position,
        active,
        usage,
        usageAt: entry.lastUsage?.at ?? polledAt,
        source,
        polledAt,
        needsSignIn: (input.needsSignIn ?? []).includes(entry.key),
      };
    });

  const decision: Decision | null =
    liveReading === null
      ? null
      : decide(
          { key: activeKey, label: input.expected?.label ?? null, reading: liveReading },
          input.index.map((entry) => ({ key: entry.key, label: entry.label, reading: entry.lastUsage?.reading ?? null })),
          threshold,
          input.outcome,
          input.now,
        );

  const usedPct = input.switchWhenUsedPct ?? Math.round((1 - threshold) * 1000) / 10;
  return {
    slots,
    active: input.expected,
    signedOut: input.signedOut,
    lastCheckAt: input.lastCheckAt === null ? null : new Date(input.lastCheckAt).toISOString(),
    nextCheckAt: input.nextCheckAt === undefined || input.nextCheckAt === null ? null : new Date(input.nextCheckAt).toISOString(),
    switchWhenUsedPct: usedPct,
    threshold,
    autoEnabled: input.autoEnabled ?? true,
    lastSwitchAt: input.lastSwitchAt ?? null,
    decision: decision === null ? null : { action: decision.action, reason: decision.reason },
    switching: input.switching ?? null,
    staleTerminals: input.staleTerminals ?? null,
    livePolling: input.livePolling ?? { state: "unknown", note: "" },
    cleanup: input.cleanup ?? null,
    lastPollAt: input.lastPollAt === undefined || input.lastPollAt === null ? null : new Date(input.lastPollAt).toISOString(),
  };
}
