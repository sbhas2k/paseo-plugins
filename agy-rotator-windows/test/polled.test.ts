import assert from "node:assert/strict";
import { test } from "node:test";
import { freshestFiveHour, mergePolled, parsePolled } from "../shared/polled.ts";
import type { UsageReading } from "../shared/usage.ts";

// S4 (plan §3.7 "Stored shape", R4-7): the live 5-hour poll adds a `polled` reading beside the `/usage` one.
//
// Two facts shape everything here:
//  - a poll returns the 5-hour bucket and the two 3p buckets, and NEVER the weekly (no REST endpoint returns
//    `gemini-weekly`, spike Q1.5) — so a poll must MERGE, or it would erase the weekly the screen and the rule still use;
//  - only the 5-hour figure may be replaced by a poll, and only when the poll is the fresher of the two.

const bucket = (remaining: number, resetsAt: string | null = "2026-10-27T04:13:01Z") => ({ remaining, resetsAt });

const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  gemini5h: bucket(0.5),
  geminiWeekly: bucket(0.8, "2026-11-02T13:13:01Z"),
  threep5h: bucket(1),
  threepWeekly: bucket(1),
  ...over,
});

test("a poll merges into polled: the 5h and 3p buckets update, the weekly reading survives", () => {
  const merged = mergePolled(
    { at: "2026-10-27T00:00:00Z", reading: null, polled: null },
    { at: "2026-10-27T01:00:00Z", gemini5h: bucket(0.93), threep5h: bucket(0.9), threepWeekly: bucket(0.7) },
  );
  assert.equal(merged.polled?.gemini5h?.remaining, 0.93);
  assert.equal(merged.polled?.threep5h?.remaining, 0.9);
  assert.equal(merged.polled?.threepWeekly?.remaining, 0.7);
  // A polled record never carries a weekly — the shape has no such field.
  assert.equal("geminiWeekly" in (merged.polled ?? {}), false);
});

test("merging keeps the previous polled value for a bucket the new poll did not report", () => {
  const first = mergePolled(
    { at: "2026-10-27T00:00:00Z", reading: null, polled: null },
    { at: "2026-10-27T01:00:00Z", gemini5h: bucket(0.9), threep5h: bucket(0.8), threepWeekly: null },
  );
  const second = mergePolled(first, { at: "2026-10-27T01:05:00Z", gemini5h: bucket(0.85), threep5h: null, threepWeekly: null });
  assert.equal(second.polled?.gemini5h?.remaining, 0.85);
  assert.equal(second.polled?.at, "2026-10-27T01:05:00Z");
  assert.equal(second.polled?.threep5h?.remaining, 0.8, "an absent bucket must not erase the known one");
});

test("the fresher of polled and /usage wins for the 5-hour figure", () => {
  const usage = { at: "2026-10-27T01:00:00Z", reading: reading({ gemini5h: bucket(0.4) }) };
  const polled = { at: "2026-10-27T01:05:00Z", gemini5h: bucket(0.9), threep5h: null, threepWeekly: null };
  assert.equal(freshestFiveHour({ usage, polled })?.remaining, 0.9);
  // ... and the older side wins when the poll is the older one.
  const older = { at: "2026-10-27T00:55:00Z", gemini5h: bucket(0.9), threep5h: null, threepWeekly: null };
  assert.equal(freshestFiveHour({ usage, polled: older })?.remaining, 0.4);
});

test("no polled reading falls back to /usage; no reading at all is null", () => {
  const usage = { at: "2026-10-27T01:00:00Z", reading: reading({ gemini5h: bucket(0.4) }) };
  assert.equal(freshestFiveHour({ usage, polled: null })?.remaining, 0.4);
  assert.equal(freshestFiveHour({ usage: null, polled: null }), null);
  const polledOnly = { at: "2026-10-27T01:00:00Z", gemini5h: bucket(0.6), threep5h: null, threepWeekly: null };
  assert.equal(freshestFiveHour({ usage: null, polled: polledOnly })?.remaining, 0.6);
});

test("a malformed polled is rejected whole — never partially accepted", () => {
  const good = { at: "2026-10-27T01:00:00Z", gemini5h: bucket(0.9), threep5h: bucket(1), threepWeekly: null };
  assert.notEqual(parsePolled(good), null);
  for (const bad of [
    null,
    "x",
    42,
    {},
    { at: "not a date", gemini5h: bucket(0.9) },
    { at: "2026-10-27T01:00:00Z" },
    { at: "2026-10-27T01:00:00Z", gemini5h: { remaining: "0.9", resetsAt: null } },
    { at: "2026-10-27T01:00:00Z", gemini5h: { remaining: 0.9, resetsAt: 5 } },
    { at: "2026-10-27T01:00:00Z", gemini5h: bucket(0.9), threep5h: { remaining: Number.NaN, resetsAt: null } },
  ]) {
    assert.equal(parsePolled(bad), null, JSON.stringify(bad));
  }
});

test("a zero fraction survives parsing (0 % left is a reading, not a missing one)", () => {
  const parsed = parsePolled({ at: "2026-10-27T01:00:00Z", gemini5h: bucket(0), threep5h: null, threepWeekly: null });
  assert.equal(parsed?.gemini5h?.remaining, 0);
});
