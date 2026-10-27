import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCheckedAt, formatResetsIn, percentLeft } from "../client/quota-format.ts";

// S3 — the bar row's text, kept out of the component so it can be tested (the same split antigravity-cli's own
// `quota-format.ts` uses; a component cannot be imported by `node --test` because `react-native` is Flow-typed).
//
// "resets in 6d 19h" / "resets in 49m" — the owner asked for the other screen's bars, and this is the line under them.

const NOW = Date.parse("2026-10-26T14:00:00Z");
const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

test("minutes, hours and days, dropping a zero lower unit", () => {
  assert.equal(formatResetsIn(inMinutes(49), NOW), "resets in 49m");
  assert.equal(formatResetsIn(inMinutes(60), NOW), "resets in 1h");
  assert.equal(formatResetsIn(inMinutes(6 * 60 + 19), NOW), "resets in 6h 19m");
  assert.equal(formatResetsIn(inMinutes(24 * 60), NOW), "resets in 1d");
  assert.equal(formatResetsIn(inMinutes(6 * 24 * 60 + 19 * 60), NOW), "resets in 6d 19h");
});

test("a reset under a minute away never reads as zero", () => {
  assert.equal(formatResetsIn(inMinutes(0.2), NOW), "resets in 1m");
});

test("a reset in the past says so, because a cached reading outlives it", () => {
  assert.equal(formatResetsIn(inMinutes(-5), NOW), "resetting now");
});

test("no reset time, or one that cannot be read, shows nothing at all", () => {
  for (const value of [null, "", "   ", "not a date"]) assert.equal(formatResetsIn(value, NOW), "", String(value));
});

test("the percentage is the remaining fraction rounded and clamped to the track", () => {
  assert.equal(percentLeft(0.1832), 18);
  assert.equal(percentLeft(0.9952), 100);
  assert.equal(percentLeft(0), 0);
  assert.equal(percentLeft(-0.5), 0);
  assert.equal(percentLeft(1.2), 100);
  assert.equal(percentLeft(Number.NaN), 0);
});

test("the checked time is the local clock, zero-padded", () => {
  const at = new Date(2026, 9, 26, 9, 5).getTime();
  assert.equal(formatCheckedAt(at), "09:05");
  assert.equal(formatCheckedAt(Number.NaN), "");
});
