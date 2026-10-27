import assert from "node:assert/strict";
import { test } from "node:test";
import { AgyAccountsSettingsSchema, parseUsedPct, thresholdFromUsedPct, usedPctFromThreshold } from "../shared/settings.ts";

// S3 — the owner's addition (2026-10-26): *"Also 80 % auto switch should be configurable. We should let use put any
// values that want. 100 should give error"*.
//
// So the setting is what the owner reads on the screen — "Switch when used ≥ N %" — and the rule keeps working in
// REMAINING terms internally (`remaining <= threshold`, `decide()` unchanged). This file is the one place the two meet,
// which is why it is a pure validator with its own messages: "100" must not be silently coerced to 99, and an invalid
// value must never reach the settings file.

test("the ordinary values are accepted, decimals included", () => {
  for (const [input, expected] of [
    ["1", 1],
    [80, 80],
    ["85.5", 85.5],
    ["99", 99],
    [" 85 ", 85],
  ] as const) {
    const result = parseUsedPct(input);
    assert.equal(result.ok, true, String(input));
    if (!result.ok) continue;
    assert.equal(result.usedPct, expected, String(input));
  }
});

test("100 is the error the owner named, in words that say why", () => {
  const result = parseUsedPct("100");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /100/);
  assert.match(result.error, /99 or less/i);
});

test("above 100 is refused too, and says so", () => {
  for (const value of ["150", 101, 1000]) {
    const result = parseUsedPct(value);
    assert.equal(result.ok, false, String(value));
    if (result.ok) continue;
    assert.match(result.error, /99 or less|between 1 and 99/i, String(value));
  }
});

test("zero and negatives are refused", () => {
  for (const value of ["0", 0, "-5", -0.5]) {
    const result = parseUsedPct(value);
    assert.equal(result.ok, false, String(value));
    if (result.ok) continue;
    assert.match(result.error, /between 1 and 99/i, String(value));
  }
});

test("empty and non-numbers are refused with a usable message, not NaN", () => {
  for (const value of ["", "   ", "abc", "8o", "NaN", Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = parseUsedPct(value as string | number);
    assert.equal(result.ok, false, String(value));
    if (result.ok) continue;
    // The message quotes what was typed ("abc" is not a number) and always names the usable range.
    assert.match(result.error, /between 1 and 99|not a number/i, String(value));
    assert.equal(result.error.includes("undefined"), false, String(value));
  }
});

test("the internal threshold is what is LEFT: 80 used is 0.20 in decide()", () => {
  assert.equal(thresholdFromUsedPct(80), 0.2);
  assert.equal(thresholdFromUsedPct(99), 0.01);
  assert.equal(thresholdFromUsedPct(1), 0.99);
  assert.equal(thresholdFromUsedPct(85.5), 0.145);
  assert.equal(thresholdFromUsedPct(50), 0.5);
});

test("the round trip is exact for every whole percent the setting allows", () => {
  for (let pct = 1; pct <= 99; pct++) {
    assert.equal(usedPctFromThreshold(thresholdFromUsedPct(pct)), pct, String(pct));
  }
});

test("the stored setting is bounded by the same rule, so a hand-edited file cannot store 100", () => {
  assert.equal(AgyAccountsSettingsSchema.safeParse({ switchWhenUsedPct: 100 }).success, false);
  assert.equal(AgyAccountsSettingsSchema.safeParse({ switchWhenUsedPct: 0 }).success, false);
  assert.equal(AgyAccountsSettingsSchema.safeParse({ switchWhenUsedPct: 85.5 }).success, true);
  const defaults = AgyAccountsSettingsSchema.parse({});
  assert.equal(defaults.switchWhenUsedPct, 80);
  assert.equal(defaults.autoSwitch, true);
});
