import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupLabel, planCleanup, type CleanupInput } from "../server/cleanup-plan.ts";

// S4 / AC11 — the Clean up planner. Pure, so every refusal is testable without a vault: the three mutants the plan names
// ("corrupt index", "dropped row", "census between credential write and index line") are each one input here.

const key = (suffix: string) => `${suffix}`;
const target = (suffix: string) => `paseo-agy-accounts:${suffix}`;

const base = (over: Partial<CleanupInput> = {}): CleanupInput => ({
  census: [target("aaaaaaaaaaaaaaaa"), target("bbbbbbbbbbbbbbbb")],
  indexKeys: [key("aaaaaaaaaaaaaaaa"), key("bbbbbbbbbbbbbbbb")],
  health: { lossless: true, detail: "2 rows" },
  protectedKeys: [],
  ...over,
});

test("a target the index knows is kept; one it does not is deletable", () => {
  const plan = planCleanup(
    base({ census: [target("aaaaaaaaaaaaaaaa"), target("cccccccccccccccc")], indexKeys: [key("aaaaaaaaaaaaaaaa")] }),
  );
  assert.deepEqual(plan.deletable, [target("cccccccccccccccc")]);
  assert.deepEqual(plan.kept, [target("aaaaaaaaaaaaaaaa")]);
  assert.equal(plan.refuseReason, null);
  assert.equal(cleanupLabel(plan), "Clean up 1 leftover entries");
});

test("nothing to do is stated plainly, not offered as a button", () => {
  const plan = planCleanup(base());
  assert.deepEqual(plan.deletable, []);
  assert.equal(cleanupLabel(plan), "No leftover entries");
});

test("a corrupt index hides the button (mutant: 'corrupt index')", () => {
  const plan = planCleanup(base({ census: [target("dddddddddddddddd")], indexKeys: [], health: { lossless: false, detail: "not json" } }));
  assert.deepEqual(plan.deletable, []);
  assert.match(plan.refuseReason ?? "", /without loss/);
  assert.match(cleanupLabel(plan), /unavailable/);
});

test("a dropped row hides the button too: 'not in the index' must not mean 'lost' (mutant: 'dropped row')", () => {
  // The parser kept 1 of 2 rows: `health.lossless` is false for exactly this reason, and the surviving row is not enough.
  const plan = planCleanup(
    base({ census: [target("aaaaaaaaaaaaaaaa"), target("eeeeeeeeeeeeeeee")], indexKeys: [key("aaaaaaaaaaaaaaaa")], health: { lossless: false, detail: "1 of 2 rows kept" } }),
  );
  assert.deepEqual(plan.deletable, []);
});

test("the expected account and the last switch target are never deletable, whatever the index says", () => {
  const plan = planCleanup(
    base({
      census: [target("aaaaaaaaaaaaaaaa"), target("bbbbbbbbbbbbbbbb"), target("ffffffffffffffff")],
      indexKeys: [],
      protectedKeys: ["aaaaaaaaaaaaaaaa", null, undefined, "bbbbbbbbbbbbbbbb"],
    }),
  );
  assert.deepEqual(plan.deletable, [target("ffffffffffffffff")]);
  assert.equal(plan.kept.includes(target("aaaaaaaaaaaaaaaa")), true);
});

test("a target outside the prefix is never deletable, even if the census somehow carried one", () => {
  const plan = planCleanup(base({ census: ["gemini:antigravity", "someone-else", target("9999999999999999")] }));
  assert.deepEqual(plan.deletable, [target("9999999999999999")]);
  assert.deepEqual(plan.kept.sort(), ["gemini:antigravity", "someone-else"]);
});

test("a census taken between a credential write and its index line (mutant: the race) does not delete the live save", () => {
  // The window R4-3 names: `saveSlot` writes the credential, then the index. A census *inside* that window sees a target
  // the index does not know yet. The protected-keys guard and the serialised queue are what make this safe; the plan
  // models the outcome: the just-saved account is the expected one, so it is kept.
  const plan = planCleanup(base({ census: [target("7777777777777777")], indexKeys: [], protectedKeys: ["7777777777777777"] }));
  assert.deepEqual(plan.deletable, []);
});

test("the label counts what it will delete, and never includes a value", () => {
  const plan = planCleanup(base({ census: [target("1"), target("2"), target("3")], indexKeys: [], protectedKeys: [] }));
  assert.equal(cleanupLabel(plan), "Clean up 3 leftover entries");
  assert.equal(/@|GOCSPX|refresh/.test(cleanupLabel(plan)), false);
});
