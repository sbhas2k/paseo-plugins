import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_THRESHOLD, decide, type ActiveAccount, type SlotState, type UsageReading } from "../shared/decide.ts";

// AC2 — the switch rule (plan §3.3): the active account's gemini-5h OR gemini-weekly `remaining_fraction <= 0.20`
// (or a `credits_exhausted` turn) triggers; a candidate must have BOTH Gemini buckets `> 0.20` or be past its reset
// time; the most room wins; otherwise stay with a reason. The 3p group is shown, never a trigger.

const NOW = Date.parse("2026-10-26T14:00:00Z");
const LATER = "2026-10-26T18:13:01Z";
const PAST = "2026-10-26T13:00:00Z";

const reading = (five: number | null, weekly: number | null, over: Partial<UsageReading> = {}): UsageReading => ({
  gemini5h: five === null ? null : { remaining: five, resetsAt: LATER },
  geminiWeekly: weekly === null ? null : { remaining: weekly, resetsAt: LATER },
  threep5h: { remaining: 1, resetsAt: LATER },
  threepWeekly: { remaining: 1, resetsAt: LATER },
  ...over,
});

const active = (five: number | null, weekly: number | null): ActiveAccount => ({ key: "key-a", label: "A", reading: reading(five, weekly) });
const slot = (key: string, five: number | null, weekly: number | null, over: Partial<UsageReading> = {}): SlotState => ({
  key,
  label: key.toUpperCase(),
  reading: reading(five, weekly, over),
});

const creditsExhausted = { kind: "failed" as const, error: { message: "You have run out of credits", code: "credits_exhausted" } };

// --- trigger boundary: 0.20 triggers, 0.21 does not (< vs <= is the mutant AC2 names) ---
test("exactly 0.20 left on gemini-5h triggers a switch", () => {
  const decision = decide(active(0.2, 0.9), [slot("key-b", 0.9, 0.9)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "switch");
});

test("exactly 0.20 left on gemini-weekly triggers a switch", () => {
  const decision = decide(active(0.9, 0.2), [slot("key-b", 0.9, 0.9)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "switch");
});

test("0.21 left on both Gemini buckets does not trigger", () => {
  const decision = decide(active(0.21, 0.21), [slot("key-b", 0.99, 0.99)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "stay");
});

test("0.21 on one bucket while the other is comfortable does not trigger", () => {
  assert.equal(decide(active(0.21, 0.9), [slot("key-b", 0.99, 0.99)], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
  assert.equal(decide(active(0.9, 0.21), [slot("key-b", 0.99, 0.99)], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

test("a spent 3p bucket never triggers on its own", () => {
  const reading3p: UsageReading = { ...reading(0.9, 0.9), threep5h: { remaining: 0, resetsAt: LATER } };
  const decision = decide({ key: "key-a", label: "A", reading: reading3p }, [slot("key-b", 0.99, 0.99)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "stay");
});

test("a custom threshold moves the boundary", () => {
  assert.equal(decide(active(0.5, 0.9), [slot("key-b", 0.99, 0.99)], 0.5, undefined, NOW).action, "switch");
  assert.equal(decide(active(0.51, 0.9), [slot("key-b", 0.99, 0.99)], 0.5, undefined, NOW).action, "stay");
});

// --- the credits_exhausted outcome triggers regardless of the fractions ---
test("a credits_exhausted turn triggers a switch even with 90% left", () => {
  const decision = decide(active(0.9, 0.9), [slot("key-b", 0.8, 0.8)], DEFAULT_THRESHOLD, creditsExhausted, NOW);
  assert.deepEqual([decision.action, decision.action === "switch" ? decision.key : null], ["switch", "key-b"]);
});

test("a completed or otherwise failed turn is not a trigger", () => {
  for (const outcome of [
    { kind: "completed" as const },
    { kind: "failed" as const, error: { message: "boom" } },
    { kind: "failed" as const, error: { message: "boom", code: "rate_limited" } },
    { kind: "canceled" as const, reason: "user" },
  ]) {
    assert.equal(decide(active(0.9, 0.9), [slot("key-b", 0.9, 0.9)], DEFAULT_THRESHOLD, outcome, NOW).action, "stay", JSON.stringify(outcome));
  }
});

// --- candidate qualification ---
test("a candidate with one Gemini bucket at the threshold is not eligible (both must be above)", () => {
  assert.equal(decide(active(0.1, 0.9), [slot("key-b", 0.9, 0.2)], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
  assert.equal(decide(active(0.1, 0.9), [slot("key-b", 0.2, 0.9)], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

test("a slot whose bucket is past its reset time counts as refilled and qualifies", () => {
  const refilled: UsageReading = {
    gemini5h: { remaining: 0.02, resetsAt: PAST },
    geminiWeekly: { remaining: 0.01, resetsAt: PAST },
    threep5h: null,
    threepWeekly: null,
  };
  const decision = decide(active(0.05, 0.9), [{ key: "key-b", label: "B", reading: refilled }], DEFAULT_THRESHOLD, undefined, NOW);
  assert.deepEqual([decision.action, decision.action === "switch" ? decision.key : null], ["switch", "key-b"]);
});

test("a slot with no reading at all never qualifies", () => {
  assert.equal(decide(active(0.05, 0.9), [{ key: "key-b", label: "B", reading: null }], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

// S4 / plan R4-1: an UNKNOWN weekly no longer disqualifies a candidate — the live poll can only read the 5-hour bucket, so
// "weekly unknown" is the normal state of an account that has never been the active one (e.g. a freshly saved second account). The candidate
// qualifies on 5 hours alone and the reason says what is missing. (This deliberately flips the S1 assertion that a
// missing bucket never qualifies — stated in the plan, §47.)
test("a candidate with a polled 5-hour and an unknown weekly qualifies, and the reason names the gap", () => {
  const unknownWeekly: UsageReading = { gemini5h: { remaining: 0.9, resetsAt: LATER }, geminiWeekly: null, threep5h: null, threepWeekly: null };
  const decision = decide(active(0.05, 0.9), [{ key: "key-b", label: "B", reading: unknownWeekly }], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "switch");
  if (decision.action !== "switch") return;
  assert.equal(decision.key, "key-b");
  assert.match(decision.reason, /weekly unknown/i);
  assert.match(decision.reason, /post-switch check/i);
  assert.equal(decision.weeklyUnknown, true);
});

test("a candidate with no 5-hour figure at all never qualifies, whatever the weekly says", () => {
  const noFive: UsageReading = { gemini5h: null, geminiWeekly: { remaining: 0.9, resetsAt: LATER }, threep5h: null, threepWeekly: null };
  assert.equal(decide(active(0.05, 0.9), [{ key: "key-b", label: "B", reading: noFive }], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

test("a needs-sign-in slot is never a candidate, even with room to spare", () => {
  const decision = decide(
    active(0.05, 0.9),
    [{ key: "key-b", label: "B", reading: reading(0.9, 0.9), needsSignIn: true }],
    DEFAULT_THRESHOLD,
    undefined,
    NOW,
  );
  assert.equal(decision.action, "stay");
  assert.match(decision.reason, /sign in|no saved account/i);
});

test("the fresher of the polled and the /usage 5-hour figure is the one the rule reads", () => {
  // /usage is old and generous; the poll is new and low: the poll must decide.
  const stale: UsageReading = { gemini5h: { remaining: 0.9, resetsAt: LATER }, geminiWeekly: { remaining: 0.9, resetsAt: LATER }, threep5h: null, threepWeekly: null };
  const decision = decide(
    active(0.05, 0.9),
    [
      {
        key: "key-b",
        label: "B",
        reading: stale,
        readingAt: "2026-10-27T00:00:00Z",
        polled: { at: "2026-10-27T01:00:00Z", gemini5h: { remaining: 0.1, resetsAt: LATER }, threep5h: null, threepWeekly: null },
      },
    ],
    DEFAULT_THRESHOLD,
    undefined,
    NOW,
  );
  assert.equal(decision.action, "stay", "a fresh poll at 0.10 must not be shadowed by a stale /usage at 0.90");
});

test("the active account is never its own candidate", () => {
  assert.equal(decide(active(0.05, 0.05), [slot("key-a", 1, 1)], DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

test("the active account's own past-reset bucket reads as refilled, so it does not trigger", () => {
  const refilled = reading(0.01, 0.01, {
    gemini5h: { remaining: 0.01, resetsAt: PAST },
    geminiWeekly: { remaining: 0.01, resetsAt: PAST },
  });
  const decision = decide({ key: "key-a", label: "A", reading: refilled }, [slot("key-b", 1, 1)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "stay");
});

// --- the owner's sequence (S3, 2026-10-26): accounts are used IN ORDER, not by most room ---------------------------
// Verbatim: "1st one. But we should let user move the account up n down. So they can arrange any time as needed."
// The list arrives in the owner's order; a switch starts AFTER the active account and wraps to the top.
test("the next qualifying account in sequence order wins, not the one with the most room", () => {
  const decision = decide(
    active(0.05, 0.9),
    [slot("key-b", 0.30, 0.95), slot("key-c", 0.80, 0.85)],
    DEFAULT_THRESHOLD,
    undefined,
    NOW,
  );
  assert.deepEqual([decision.action, decision.action === "switch" ? decision.key : null], ["switch", "key-b"]);
});

test("the walk skips an account that does not qualify and takes the next one", () => {
  const decision = decide(
    active(0.05, 0.9),
    [slot("key-b", 0.9, 0.2), slot("key-c", 0.9, 0.9)],
    DEFAULT_THRESHOLD,
    undefined,
    NOW,
  );
  assert.deepEqual([decision.action, decision.action === "switch" ? decision.key : null], ["switch", "key-c"]);
});

test("the walk wraps: an active account at the end of the list goes back to the top", () => {
  const decision = decide(
    active(0.05, 0.9),
    [slot("key-b", 0.9, 0.9), slot("key-c", 0.1, 0.9), slot("key-d", 0.9, 0.9), slot("key-a", 0.05, 0.9)],
    DEFAULT_THRESHOLD,
    undefined,
    NOW,
  );
  assert.deepEqual([decision.action, decision.action === "switch" ? decision.key : null], ["switch", "key-b"]);
});

test("four accounts: the first qualifying one after the active position, in order", () => {
  const slots = [slot("key-b", 0.1, 0.9), slot("key-c", 0.9, 0.9), slot("key-d", 0.95, 0.95)];
  const decision = decide(active(0.05, 0.9), slots, DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action === "switch" ? decision.key : null, "key-c");
});

test("the active account is skipped even if it sits mid-list", () => {
  const slots = [slot("key-b", 0.1, 0.9), slot("key-a", 0.9, 0.9), slot("key-c", 0.8, 0.8)];
  const decision = decide(active(0.05, 0.9), slots, DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action === "switch" ? decision.key : null, "key-c");
});

test("an active account that is not in the saved list starts the walk at the top", () => {
  const slots = [slot("key-b", 0.9, 0.9), slot("key-c", 0.1, 0.9)];
  const decision = decide({ key: "key-unsaved", label: "unsaved", reading: reading(0.05, 0.9) }, slots, DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action === "switch" ? decision.key : null, "key-b");
});

test("every account below the threshold is a stay, however many there are", () => {
  const slots = [slot("key-b", 0.1, 0.9), slot("key-c", 0.2, 0.2), slot("key-d", 0.05, 0.05)];
  assert.equal(decide(active(0.05, 0.9), slots, DEFAULT_THRESHOLD, undefined, NOW).action, "stay");
});

test("the switch names the position it walked to, so the note can say why that account", () => {
  const decision = decide(active(0.05, 0.9), [slot("key-b", 0.1, 0.9), slot("key-c", 0.9, 0.9)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "switch");
  if (decision.action !== "switch") return;
  assert.match(decision.reason, /position 2/);
});

test("no qualifying slot keeps the active account and says why", () => {
  const decision = decide(active(0.05, 0.9), [slot("key-b", 0.1, 0.9)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "stay");
  assert.match(decision.reason, /no saved account/i);
});

test("the switch names the label, never an email", () => {
  const decision = decide(active(0.05, 0.9), [slot("key-b", 0.9, 0.9)], DEFAULT_THRESHOLD, undefined, NOW);
  assert.equal(decision.action, "switch");
  if (decision.action !== "switch") return;
  assert.equal(decision.label, "KEY-B");
  assert.doesNotMatch(decision.reason, /@/);
});
