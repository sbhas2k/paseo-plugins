import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStatePayload } from "../shared/view.ts";
import type { SlotEntry } from "../shared/slots.ts";
import type { UsageSnapshot } from "../server/usage-cache.ts";

// S2 — the ONE payload the sidebar screen sees (AC7). It is assembled here, once, and carries labels, keys, percentages
// and timestamps: never an email, never a blob, never a token field. The screen cannot leak what it was not handed.

const reading = (five: number, weekly: number) => ({
  gemini5h: { remaining: five, resetsAt: "2026-10-26T18:13:01Z" },
  geminiWeekly: { remaining: weekly, resetsAt: "2026-11-02T13:13:01Z" },
  threep5h: { remaining: 0.5, resetsAt: null },
  threepWeekly: { remaining: 1, resetsAt: null },
});

const entry = (key: string, label: string, lastUsage: SlotEntry["lastUsage"] = null, order = 0): SlotEntry => ({
  key,
  label,
  savedAt: "2026-10-26T12:00:00Z",
  lastUsage,
  order,
});

const live: UsageSnapshot = { at: 1_760_000_000_000, kind: "ok", reading: reading(0.18, 0.9) };

// The rule reads REFILLED once a bucket's `resetsAt` has passed (F10), so every payload below is evaluated at a fixed
// instant BEFORE the fixtures' reset times. Without this the suite's verdict flips at 18:13Z on 2026-10-26 — a clock
// time bomb, found by the S3 verification rerun.
const NOW = Date.parse("2026-10-26T14:00:00Z");

test("the active account's figures come from the live reading, the others from their stored one", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work", { at: "2026-10-26T11:00:00Z", reading: reading(0.7, 0.8) }), entry("k2", "Personal")],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: 1_760_000_000_000,
    threshold: 0.2,
    live,
  });
  const work = payload.slots.find((slot) => slot.key === "k1");
  const personal = payload.slots.find((slot) => slot.key === "k2");
  assert.equal(work?.active, true);
  assert.equal(work?.source, "live");
  assert.equal(work?.usage?.gemini5h?.remainingPct, 18);
  assert.equal(work?.usage?.geminiWeekly?.remainingPct, 90);
  assert.equal(work?.usageAt, new Date(1_760_000_000_000).toISOString());
  // k2 has never been read: no figures, and it says so rather than showing 0%.
  assert.equal(personal?.usage, null);
  assert.equal(personal?.source, null);
  assert.equal(personal?.active, false);
});

test("an inactive slot keeps its last reading and the time it was taken", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work"), entry("k2", "Personal", { at: "2026-10-26T11:00:00Z", reading: reading(0.42, 0.66) })],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.2,
    live,
  });
  const personal = payload.slots.find((slot) => slot.key === "k2");
  assert.equal(personal?.source, "stored");
  assert.equal(personal?.usage?.gemini5h?.remainingPct, 42);
  assert.equal(personal?.usageAt, "2026-10-26T11:00:00Z");
});

test("a signed-out state is visible, and no slot is marked active", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work")],
    expected: null,
    signedOut: true,
    lastCheckAt: null,
    threshold: 0.2,
    live: { at: 5, kind: "signed-out", reading: null },
  });
  assert.equal(payload.signedOut, true);
  assert.equal(payload.active, null);
  assert.equal(payload.slots[0].active, false);
  assert.equal(payload.slots[0].usage, null);
});

test("the payload carries no email, no blob and no token field (AC7)", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("0123456789abcdef", "Work", { at: "2026-10-26T11:00:00Z", reading: reading(0.7, 0.8) }), entry("fedcba9876543210", "Personal")],
    expected: { key: "0123456789abcdef", label: "Work" },
    signedOut: false,
    lastCheckAt: 1_760_000_000_000,
    threshold: 0.2,
    live,
  });
  const text = JSON.stringify(payload);
  for (const forbidden of ["@", "access_token", "refresh_token", "Bearer", "id_token", "blob", "credential"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  // The keys are the full 16 hex characters: Paseo's own UsageAccount.key format, never an email.
  assert.deepEqual(payload.slots.map((slot) => slot.key), ["0123456789abcdef", "fedcba9876543210"]);
});

test("the decide() verdict is shown, never acted on in this slice", () => {
  const stay = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work")],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.2,
    live: { at: 1, kind: "ok", reading: reading(0.9, 0.9) },
  });
  assert.equal(stay.decision?.action, "stay");
  const would = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work"), entry("k2", "Personal", { at: "2026-10-26T11:00:00Z", reading: reading(0.9, 0.9) })],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.2,
    live: { at: 1, kind: "ok", reading: reading(0.18, 0.9) },
  });
  assert.equal(would.decision?.action, "switch");
  assert.deepEqual(would.decision?.reason.includes("Personal"), true);
});

test("a percentage is rounded for display, never shown as a long float", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work")],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.2,
    live: { at: 1, kind: "ok", reading: { ...reading(0.183_9, 1), threep5h: { remaining: 0.333_33, resetsAt: null } } },
  });
  assert.equal(payload.slots[0].usage?.gemini5h?.remainingPct, 18);
  assert.equal(payload.slots[0].usage?.threep5h?.remainingPct, 33);
});

// --- S3 additions ---

test("the cards arrive in sequence order with a 1-based position on each", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k3", "Third", null, 2), entry("k1", "First", null, 0), entry("k2", "Second", null, 1)],
    expected: { key: "k1", label: "First" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.2,
    live,
  });
  assert.deepEqual(payload.slots.map((slot) => [slot.label, slot.position]), [
    ["First", 1],
    ["Second", 2],
    ["Third", 3],
  ]);
});

test("the setpoint is shown in the owner's units, and the rule reads the same number", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work"), entry("k2", "Personal", { at: "2026-10-26T11:00:00Z", reading: reading(0.9, 0.9) })],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: null,
    threshold: 0.63,
    switchWhenUsedPct: 37,
    live: { at: 1, kind: "ok", reading: reading(0.5, 0.9) },
  });
  assert.equal(payload.switchWhenUsedPct, 37);
  assert.equal(payload.threshold, 0.63);
  // 50 % left is 50 % used, which is at or past 37 % used: the rule agrees with the number on the screen.
  assert.equal(payload.decision?.action, "switch");
});

test("a switch in flight and a stale-terminal warning both reach the screen", () => {
  const payload = buildStatePayload({
    now: NOW,
    index: [entry("k1", "Work")],
    expected: { key: "k1", label: "Work" },
    signedOut: false,
    lastCheckAt: 1_760_000_000_000,
    threshold: 0.2,
    live,
    nextCheckAt: 1_760_000_600_000,
    switching: { key: "k2", label: "Personal", total: 3, done: 1, failed: 0, startedAt: new Date(1_760_000_000_000).toISOString(), ms: null, finished: false },
    staleTerminals: { count: 2, fromLabel: "Work" },
    lastSwitchAt: new Date(1_760_000_000_000).toISOString(),
  });
  assert.equal(payload.switching?.done, 1);
  assert.equal(payload.switching?.total, 3);
  assert.equal(payload.staleTerminals?.count, 2);
  assert.equal(payload.staleTerminals?.fromLabel, "Work");
  assert.equal(payload.nextCheckAt, new Date(1_760_000_600_000).toISOString());
  assert.equal(payload.lastSwitchAt, new Date(1_760_000_000_000).toISOString());
  // Still no secret anywhere in the bigger payload.
  const text = JSON.stringify(payload);
  for (const forbidden of ["@", "access_token", "refresh_token"]) assert.equal(text.includes(forbidden), false, forbidden);
});
