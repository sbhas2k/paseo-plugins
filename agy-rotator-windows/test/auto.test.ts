import assert from "node:assert/strict";
import { test } from "node:test";
import { autoDecide, debounceElapsed, exhaustedReading, MIN_SWITCH_GAP_MS, type AutoInput } from "../shared/auto.ts";
import type { SlotState, UsageReading } from "../shared/decide.ts";

// S3 — the automatic switch (plan §3.2/§3.3): the SAME `decide()` the screen shows, plus the three things a human
// clicking a button does not need: a setting, a debounce, and a ping-pong guard.
//
// Why the guard: `reset_time` is a fixed-start window (F10), so A→B at A's 5h ≤ 0.20 and "back to B when B trips and A
// has reset" is bounded by the 5h window. Two switches inside ten minutes cannot be that pattern — it would be a pair
// of accounts both near the threshold flapping, or a reading that has not caught up yet. `credits_exhausted` is the one
// thing that overrides it: the account is out, there is nothing to wait for (F11).

const NOW = Date.parse("2026-10-26T14:00:00Z");
const LATER = "2026-10-26T18:13:01Z";

const reading = (five: number | null, weekly: number | null): UsageReading => ({
  gemini5h: five === null ? null : { remaining: five, resetsAt: LATER },
  geminiWeekly: weekly === null ? null : { remaining: weekly, resetsAt: LATER },
  threep5h: null,
  threepWeekly: null,
});

const active = (five: number | null, weekly: number | null) => ({ key: "key-a", label: "A", reading: reading(five, weekly) });
const slot = (key: string, five: number | null, weekly: number | null): SlotState => ({ key, label: key.toUpperCase(), reading: reading(five, weekly) });

const base = (over: Partial<AutoInput> = {}): AutoInput => ({
  enabled: true,
  threshold: 0.2,
  active: active(0.1, 0.9),
  slots: [slot("key-b", 0.9, 0.9)],
  lastSwitchAt: null,
  now: NOW,
  ...over,
});

const creditsExhausted = { kind: "failed" as const, error: { message: "out of credits", code: "credits_exhausted" } };

// --- the rule itself, delegated to decide() ---
test("a depleted active account with a healthy slot switches to it", () => {
  const result = autoDecide(base());
  assert.equal(result.kind, "switch");
  if (result.kind !== "switch") return;
  assert.equal(result.key, "key-b");
  assert.equal(result.bypassedGuard, false);
});

test("an account with room is left alone", () => {
  assert.equal(autoDecide(base({ active: active(0.9, 0.9) })).kind, "stay");
});

test("no qualifying slot is a stay, not a switch to the same account", () => {
  assert.equal(autoDecide(base({ slots: [slot("key-b", 0.1, 0.9)] })).kind, "stay");
});

test("the setting's threshold is the one used", () => {
  assert.equal(autoDecide(base({ active: active(0.5, 0.9), threshold: 0.6 })).kind, "switch");
  assert.equal(autoDecide(base({ active: active(0.5, 0.9), threshold: 0.4 })).kind, "stay");
});

test("disabled means no automatic switch, whatever the readings say", () => {
  const result = autoDecide(base({ enabled: false }));
  assert.equal(result.kind, "stay");
  assert.match(result.reason, /off/i);
});

test("a switch already in flight is never doubled", () => {
  const result = autoDecide(base({ inFlight: true }));
  assert.equal(result.kind, "stay");
  assert.match(result.reason, /in flight/i);
});

// --- the ping-pong guard ---
test("no automatic switch within ten minutes of the previous one", () => {
  const result = autoDecide(base({ lastSwitchAt: NOW - 60_000 }));
  assert.equal(result.kind, "stay");
  assert.match(result.reason, /switch/i);
});

test("just past the ten minutes the rule may act again", () => {
  assert.equal(autoDecide(base({ lastSwitchAt: NOW - MIN_SWITCH_GAP_MS - 1 })).kind, "switch");
});

test("the guard measures from the last switch, not from the last check", () => {
  assert.equal(autoDecide(base({ lastSwitchAt: NOW - MIN_SWITCH_GAP_MS / 2 })).kind, "stay");
  assert.equal(autoDecide({ ...base(), lastSwitchAt: null }).kind, "switch");
});

// --- the one override ---
test("credits_exhausted bypasses the guard and says so", () => {
  const result = autoDecide(base({ active: active(0.9, 0.9), lastSwitchAt: NOW - 60_000, outcome: creditsExhausted }));
  assert.equal(result.kind, "switch");
  if (result.kind !== "switch") return;
  assert.equal(result.bypassedGuard, true);
  assert.deepEqual(result.triggeredBy, ["credits_exhausted"]);
});

test("credits_exhausted still needs a candidate account", () => {
  const result = autoDecide(base({ active: active(0.9, 0.9), outcome: creditsExhausted, slots: [slot("key-b", 0.1, 0.1)] }));
  assert.equal(result.kind, "stay");
});

test("credits_exhausted with the switch disabled is not an automatic switch either", () => {
  assert.equal(autoDecide(base({ active: active(0.9, 0.9), outcome: creditsExhausted, enabled: false })).kind, "stay");
});

// --- the debounce the turn-end trigger rides on ---
test("the turn-end trigger fires at most once per cache TTL", () => {
  assert.equal(debounceElapsed(null, NOW, 120_000), true);
  assert.equal(debounceElapsed(NOW - 60_000, NOW, 120_000), false);
  assert.equal(debounceElapsed(NOW - 120_000, NOW, 120_000), true);
  assert.equal(debounceElapsed(NOW - 200_000, NOW, 120_000), true);
});

test("a forced evaluation ignores the debounce (credits_exhausted must not wait)", () => {
  assert.equal(debounceElapsed(NOW, NOW, 120_000, true), true);
});

test("the guard's own default is ten minutes", () => {
  assert.equal(MIN_SWITCH_GAP_MS, 10 * 60_000);
});

// --- F-01 (Gemini review, 9da9e943): an exhausted departure cannot be the next target ---------------------------
// When a switch is triggered by `credits_exhausted` the guard is bypassed, and the departing slot's stored reading
// still said "room left" — so two exhausted accounts could bounce A↔B on every failed turn. The departing slot is
// therefore recorded as ZERO on both Gemini buckets, keeping its own reset times, so it cannot qualify again until its
// own window has refilled (F10) — which is exactly the moment it deserves to be considered again.
test("an exhausted departure is recorded as zero on both Gemini buckets, keeping their reset times", () => {
  const zeroed = exhaustedReading(reading(0.8, 0.9), NOW);
  assert.equal(zeroed.gemini5h?.remaining, 0);
  assert.equal(zeroed.geminiWeekly?.remaining, 0);
  assert.equal(zeroed.gemini5h?.resetsAt, LATER);
  assert.equal(zeroed.geminiWeekly?.resetsAt, LATER);
});

test("a bucket with no reset time gets one the guard's length away, never a permanent zero", () => {
  const zeroed = exhaustedReading(reading(0.5, 0.5), NOW);
  const synthetic = exhaustedReading({ ...reading(0.5, 0.5), gemini5h: { remaining: 0.5, resetsAt: null } }, NOW);
  assert.equal(synthetic.gemini5h?.resetsAt, new Date(NOW + MIN_SWITCH_GAP_MS).toISOString());
  // ... and it is not "resetting now" either.
  assert.equal(Date.parse(synthetic.gemini5h?.resetsAt ?? "") > NOW, true);
  assert.equal(zeroed.gemini5h?.resetsAt, LATER);
});

test("the 3p buckets are left alone: they never trigger, so they are not part of the punishment", () => {
  const source: UsageReading = { ...reading(0.8, 0.9), threep5h: { remaining: 0.4, resetsAt: LATER }, threepWeekly: { remaining: 0.6, resetsAt: LATER } };
  const zeroed = exhaustedReading(source, NOW);
  assert.deepEqual(zeroed.threep5h, { remaining: 0.4, resetsAt: LATER });
  assert.deepEqual(zeroed.threepWeekly, { remaining: 0.6, resetsAt: LATER });
});

test("no reading at all still yields a zeroed pair to write down", () => {
  const zeroed = exhaustedReading(null, NOW);
  assert.equal(zeroed.gemini5h?.remaining, 0);
  assert.equal(zeroed.geminiWeekly?.remaining, 0);
  assert.equal(zeroed.threep5h, null);
});

test("both accounts exhausted: one switch, then stay instead of bouncing", () => {
  // A is live and out; B looked healthy, so the rule moves to B (guard bypassed, F11).
  const first = autoDecide({ ...base({ active: active(0.9, 0.9), outcome: creditsExhausted }), lastSwitchAt: null });
  assert.equal(first.kind, "switch");
  // The departure is now zeroed in the index; B's own turn fails the same way.
  const departed = { key: "key-a", label: "A", reading: exhaustedReading(reading(0.9, 0.9), NOW) };
  const second = autoDecide({
    enabled: true,
    threshold: 0.2,
    active: { key: "key-b", label: "B", reading: reading(0.9, 0.9) },
    slots: [departed],
    outcome: creditsExhausted,
    lastSwitchAt: null,
    now: NOW + 60_000,
  });
  assert.equal(second.kind, "stay");
  assert.match(second.reason, /no saved account has room/i);
});

// --- S4 / R4-2: the post-switch check gets ONE bypassing hop ------------------------------------------------
// After a switch's reloads settle the plugin reads the new account's `/usage`; if that account is already at the
// setpoint the switch accomplished nothing, so ONE more hop is allowed past the ten-minute guard — and only one.
// A third hop is how a page-flip would look, so it is refused.
test("a post-switch evaluation bypasses the guard once, and says it did", () => {
  const result = autoDecide({ ...base({ active: active(0.05, 0.9), lastSwitchAt: NOW - 60_000 }), postSwitch: true, postSwitchHops: 0 });
  assert.equal(result.kind, "switch");
  if (result.kind !== "switch") return;
  assert.equal(result.bypassedGuard, true);
  assert.equal(result.postSwitch, true);
});

test("a second post-switch hop is refused (one extra hop, never a page-flip)", () => {
  const result = autoDecide({ ...base({ active: active(0.05, 0.9), lastSwitchAt: NOW - 60_000 }), postSwitch: true, postSwitchHops: 1 });
  assert.equal(result.kind, "stay");
  assert.match(result.reason, /post-switch|hop/i);
});

test("the post-switch bypass is not a licence to ignore the readings", () => {
  const result = autoDecide({ ...base({ active: active(0.9, 0.9), lastSwitchAt: NOW - 60_000 }), postSwitch: true, postSwitchHops: 0 });
  assert.equal(result.kind, "stay");
});

test("a post-switch switch still needs a candidate", () => {
  const result = autoDecide({
    ...base({ active: active(0.05, 0.9), lastSwitchAt: NOW - 60_000, slots: [slot("key-b", 0.05, 0.9)] }),
    postSwitch: true,
    postSwitchHops: 0,
  });
  assert.equal(result.kind, "stay");
});

test("an ordinary trigger does not carry the post-switch flag", () => {
  const result = autoDecide(base({ active: active(0.05, 0.9) }));
  assert.equal(result.kind, "switch");
  if (result.kind !== "switch") return;
  assert.equal(result.postSwitch, false);
});
