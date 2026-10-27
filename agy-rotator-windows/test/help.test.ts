import assert from "node:assert/strict";
import { test } from "node:test";
import { helpSections, helpText, withHelpToggled } from "../shared/help.ts";
import { AgyAccountsSettingsSchema, MAX_USED_PCT, MIN_USED_PCT } from "../shared/settings.ts";

// S3 (owner 2026-10-26): *"Quota left also fine but use should have a drop down which tells how to use it. Quota, sequence
// etc."* — a collapsed help section at the top of the screen, six groups, every number rendered from live settings.
//
// The rule that matters: nothing in this text may be a hardcoded copy of a setting. The 80 % default must not appear in
// the source of the help at all, so a test with N=37 proves the interpolation is real. And every bullet has to describe
// what the code actually does — an invented promise in help text is worse than no help text.

const SECTIONS = helpSections({ usedPct: 37, threshold: 0.63 });

test("there are the six groups the owner asked for, in the order a new owner needs them", () => {
  assert.deepEqual(
    SECTIONS.map((section) => section.title),
    ["Add an account", "Usage bars", "Auto-switch", "Sequence", "What a switch does", "Manual control"],
  );
  for (const section of SECTIONS) assert.equal(section.lines.length > 0, true, section.title);
});

test("the setpoint is rendered from the setting, not written into the text", () => {
  const text = helpText({ usedPct: 37, threshold: 0.63 });
  assert.match(text, /37 %/);
  assert.equal(/\b80\b/.test(text), false, "the default must not be a literal in the help");
});

test("a different setting changes every mention of it", () => {
  const text = helpText({ usedPct: 92, threshold: 0.08 });
  assert.match(text, /92 %/);
  assert.equal(/\b37\b/.test(text), false);
});

test("the range in the help is the range the validator enforces", () => {
  const text = helpText({ usedPct: 80, threshold: 0.2 });
  assert.match(text, new RegExp(`from ${MIN_USED_PCT} to ${MAX_USED_PCT}`));
  assert.match(text, /100/);
});

test("the bullets match the code: no invented behaviour", () => {
  const text = helpText({ usedPct: 80, threshold: 0.2 });
  // 2: how often it refreshes, and that reading costs no quota (plan F3).
  assert.match(text, /every 10 min/i);
  assert.match(text, /costs no quota/i);
  // 3: either Gemini bucket.
  assert.match(text, /either/i);
  // 4: wrapping and the reset exemption and the warning.
  assert.match(text, /wraps|wrapping/i);
  assert.match(text, /reset/i);
  assert.match(text, /warning/i);
  assert.match(text, /never switches by itself|never switches/i);
  // 5: idle reload, busy waits, an owner terminal keeps the old account (F8).
  assert.match(text, /idle/i);
  assert.match(text, /turn ends|turn end/i);
  assert.match(text, /terminal/i);
  // 6: manual switch ignores order; an owner sign-in is adopted (R2-2).
  assert.match(text, /any account/i);
  assert.match(text, /ignoring the order/i);
  assert.match(text, /adopt/i);
});

test("the help is closed by default and remembers being opened", () => {
  assert.equal(AgyAccountsSettingsSchema.parse({}).helpOpen, false);
  assert.equal(withHelpToggled({ helpOpen: false }), true);
  assert.equal(withHelpToggled({ helpOpen: true }), false);
});
