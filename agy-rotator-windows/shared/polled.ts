// agy-rotator-windows — the polled 5-hour reading (plan §3.7 "Stored shape", R4-7).
//
// `v1internal:retrieveUserQuota` returns the 5-hour bucket and the two 3p buckets per model, and **no weekly**: four REST
// endpoints were tried and none returns `gemini-weekly` (spike Q1.5, `FetchQuotaStatus` over gRPC answers
// `Method not found`). So a poll cannot replace a `/usage` reading — it merges beside it:
//
//   lastUsage = { at, reading: UsageReading, polled: { at, gemini5h, threep5h, threepWeekly } | null }
//
// Everything here is pure: parsing (a malformed record is rejected WHOLE — a half-trusted reading is worse than none),
// merging (an absent bucket never erases a known one), and the one question the rule asks — which 5-hour figure is the
// fresher of the two.

import type { UsageBucket, UsageReading } from "./usage.ts";

/** The buckets a poll can return. Deliberately no `geminiWeekly`: no endpoint provides one. */
export interface PolledBuckets {
  gemini5h: UsageBucket | null;
  threep5h: UsageBucket | null;
  threepWeekly: UsageBucket | null;
}

export interface PolledReading extends PolledBuckets {
  /** RFC3339, when the poll was answered. This is the freshness that competes with `reading.at`. */
  at: string;
}

export interface SlotUsageLike {
  at: string;
  /** A polled-only slot has no `/usage` reading at all. */
  reading: UsageReading | null;
}

export interface SlotUsageWithPolled {
  polled: PolledReading | null;
}

/** A poll's answer → one bucket, or null when the field is missing or unusable. */
export function parseBucket(value: unknown): UsageBucket | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const remaining = record.remaining;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const resetsAt = record.resetsAt;
  if (resetsAt !== null && typeof resetsAt !== "string") return null;
  return { remaining, resetsAt: resetsAt === null ? null : (resetsAt as string) };
}

/**
 * A stored `polled` record, or null. All-or-nothing: a record whose `at` is unreadable, or whose 5-hour bucket is not a
 * bucket, is rejected entirely rather than trusted in part.
 */
export function parsePolled(value: unknown): PolledReading | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) return null;
  const five = parseBucket(record.gemini5h);
  if (five === null) return null;
  const threep5h = record.threep5h === null || record.threep5h === undefined ? null : parseBucket(record.threep5h);
  const threepWeekly = record.threepWeekly === null || record.threepWeekly === undefined ? null : parseBucket(record.threepWeekly);
  if (record.threep5h !== null && record.threep5h !== undefined && threep5h === null) return null;
  if (record.threepWeekly !== null && record.threepWeekly !== undefined && threepWeekly === null) return null;
  return { at: record.at, gemini5h: five, threep5h, threepWeekly };
}

/** The winner of a poll and the slot's own last reading, by timestamp: the fresher 5-hour figure. */
export function freshestFiveHour(slot: { usage: SlotUsageLike | null; polled: PolledReading | null }): UsageBucket | null {
  const usageAt = slot.usage === null ? Number.NEGATIVE_INFINITY : Date.parse(slot.usage.at);
  const polledAt = slot.polled === null ? Number.NEGATIVE_INFINITY : Date.parse(slot.polled.at);
  const fromUsage = slot.usage?.reading?.gemini5h ?? null;
  const fromPolled = slot.polled?.gemini5h ?? null;
  if (fromPolled === null) return fromUsage;
  if (fromUsage === null) return fromPolled;
  // Equal timestamps keep `/usage`, which is the CLI's own answer.
  return polledAt > usageAt ? fromPolled : fromUsage;
}

/**
 * Merge a poll into an existing `polled`: the new buckets win where present, an absent one keeps the previous value (so a
 * response that omitted a bucket cannot erase it), and the timestamp always advances.
 */
export function mergePolled<T extends SlotUsageLike & SlotUsageWithPolled>(slot: T, poll: PolledReading): Omit<T, "polled"> & { polled: PolledReading } {
  const previous = slot.polled;
  return {
    ...slot,
    polled: {
      at: poll.at,
      gemini5h: poll.gemini5h ?? previous?.gemini5h ?? null,
      threep5h: poll.threep5h ?? previous?.threep5h ?? null,
      threepWeekly: poll.threepWeekly ?? previous?.threepWeekly ?? null,
    },
  };
}
