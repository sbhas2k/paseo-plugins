import assert from "node:assert/strict";
import { test } from "node:test";
import { usageReport, usedPct } from "../server/usage-report.ts";
import type { UsageReading } from "../shared/usage.ts";

// S2 — the usage source's answer. Paseo's summary renders `UsageWindow`; `/usage` reports REMAINING, so the conversion
// and the "nothing to show" path are the two things worth pinning. A wrong sign here would show a full account as
// empty, which is exactly the kind of silently-wrong figure this project keeps finding.

const reading = (over: Partial<UsageReading> = {}): UsageReading => ({
  gemini5h: { remaining: 0.18, resetsAt: "2026-10-26T18:13:01Z" },
  geminiWeekly: { remaining: 0.9952, resetsAt: "2026-11-02T13:13:01Z" },
  threep5h: { remaining: 1, resetsAt: "2026-10-26T18:27:31Z" },
  threepWeekly: { remaining: 0.5, resetsAt: null },
  ...over,
});

test("remaining becomes used, and the two Gemini windows are the summary ones", () => {
  const report = usageReport(reading());
  assert.equal(report.status, "available");
  if (report.status !== "available") return;
  const five = report.windows.find((window) => window.id === "gemini-5h");
  assert.equal(five?.usedPct, 82);
  assert.equal(five?.remainingPct, 18);
  assert.equal(five?.summary, true);
  assert.equal(five?.resetsAt, "2026-10-26T18:13:01Z");
  const weekly = report.windows.find((window) => window.id === "gemini-weekly");
  assert.equal(weekly?.usedPct, 0.5);
  assert.equal(weekly?.summary, true);
});

test("the 3p windows are shown but never in the summary", () => {
  const report = usageReport(reading());
  if (report.status !== "available") return assert.fail("expected a reading");
  const threep = report.windows.filter((window) => window.id.startsWith("3p-"));
  assert.equal(threep.length, 2);
  assert.equal(threep.every((window) => window.summary !== true), true);
});

test("a bucket the CLI did not report produces no window at all", () => {
  const report = usageReport(reading({ threep5h: null, threepWeekly: null }));
  if (report.status !== "available") return assert.fail("expected a reading");
  assert.deepEqual(report.windows.map((window) => window.id), ["gemini-5h", "gemini-weekly"]);
});

test("nothing read yet is `unavailable` with a reason, never a zero", () => {
  const report = usageReport(null);
  assert.equal(report.status, "unavailable");
  if (report.status !== "unavailable") return;
  assert.equal(report.problem.kind, "no_quota");
});

test("a reading with no Gemini buckets is unavailable rather than a made-up window", () => {
  const report = usageReport(reading({ gemini5h: null, geminiWeekly: null }));
  assert.equal(report.status, "unavailable");
});

test("an empty account reads as fully used, not as a wrapped negative", () => {
  assert.equal(usedPct(0), 100);
  assert.equal(usedPct(1), 0);
  assert.equal(usedPct(0.5), 50);
  assert.equal(usedPct(0.183_9), 81.6);
});

test("the report carries no email and no token field (AC7)", () => {
  const text = JSON.stringify(usageReport(reading()));
  for (const forbidden of ["@", "access_token", "refresh_token", "Bearer", "id_token"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});
