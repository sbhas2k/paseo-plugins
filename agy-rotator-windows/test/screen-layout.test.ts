import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Owner screenshot review of the agy accounts screen (after 6c8f07bb), three changes. There is no renderer in this suite
// (`react-native` is Flow-typed), so these are STRUCTURAL guards on `client/screen.tsx`:
//
//   what they can see   — which component owns a handler, whether a row exists at all, which style a line uses, the order
//                         of two statements inside a function;
//   what they cannot see — layout, spacing, colour on screen, whether the host scrolls. Those are the owner's eyes (they
//                         found all three defects by looking).
//
// Each one is here because the defect that was reported would have passed a test asserting anything looser.

const SOURCE = readFileSync(new URL("../client/screen.tsx", import.meta.url), "utf8");

/**
 * The same source with comments removed, for the "this must not appear" assertions: a comment explaining the defect must
 * not be mistaken for the defect (this repository has been burned by a text sweep that could not tell a mention from a
 * use). The file has no `//` inside a string, so a line-based strip is safe here.
 */
const CODE = SOURCE.split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** The text of one function body, from its declaration to the matching brace at column 0. */
function bodyOf(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} is gone from client/screen.tsx`);
  const rest = SOURCE.slice(start);
  const end = rest.indexOf("\n  };");
  assert.notEqual(end, -1, `${name} has no end`);
  return rest.slice(0, end);
}

test("the whole top area is built from View/Text, not padded settings rows", () => {
  // `SettingsSection`'s `info` is the ⓘ tooltip slot: the help toggle lived there and did nothing. Nothing in this screen
  // uses a settings row any more — the account cards already showed the density the owner wants.
  assert.equal(CODE.includes("SettingsSection"), false, "the top area went back to a settings row (see the help info-slot defect)");
  assert.equal(CODE.includes("SettingsAction"), false, "the setpoint's Save must be in its own row, not a separate settings row");
});

test("the help header is its own Pressable and toggles local state first (change 1)", () => {
  assert.match(SOURCE, /accessibilityLabel="How this works"/);
  assert.match(SOURCE, /accessibilityState=\{\{ expanded: helpOpen \}\}/);
  assert.match(SOURCE, /onPress=\{toggleHelp\}/);
  const toggle = bodyOf("toggleHelp");
  const local = toggle.indexOf("setHelpOpen(next)");
  const persisted = toggle.indexOf("settings.save(");
  assert.notEqual(local, -1, "the toggle must set local state");
  assert.notEqual(persisted, -1, "the toggle should still remember the preference");
  assert.equal(local < persisted, true, "local state must flip BEFORE the (possibly failing) save");
});

test("the help content is rendered only when open, directly under the header (no blank band)", () => {
  assert.match(SOURCE, /\{helpOpen \? \(/);
  assert.match(SOURCE, /helpSections\(\{ usedPct: setpoint/);
});

test("the setpoint is one row: label, input and Save together, error in the row in red (change 2)", () => {
  // The input and the Save button are siblings inside the same `styles.row`.
  const row = SOURCE.slice(SOURCE.indexOf("{/* the setpoint: label, input and Save on ONE row"));
  const setpointRow = row.slice(0, row.indexOf("{/* the switch and a manual check"));
  assert.match(setpointRow, /<TextInput/);
  assert.match(setpointRow, /accessibilityLabel="Save the setpoint"/);
  assert.match(setpointRow, /value=\{pctText\}/);
  // The error line is the same line as the hint, in the danger colour.
  assert.match(setpointRow, /style=\{pctError === null \? styles\.hint : styles\.error\}/);
  assert.match(SOURCE, /error: \{ color: theme\.colors\.statusDanger/);
  // ... and there is no separate "Save the setpoint" row left behind.
  assert.equal(CODE.includes("SettingsAction"), false);
});

test("a validation error is produced by the validator and keeps the stored value (change 2)", async () => {
  // The row hands the typed text to the same validator the settings schema uses; 100 is its named error.
  const { parseUsedPct } = await import("../shared/settings.ts");
  const bad = parseUsedPct("100");
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  // The row shows `parsed.error` verbatim: assert the message the user will see in red.
  assert.match(bad.error, /100% would never switch before the account is empty - use 99 or less\./);
  // Nothing is written on the error path: `applySetpoint` returns before `settings.save`.
  const apply = bodyOf("applySetpoint");
  assert.equal(apply.indexOf("setPctError(parsed.error)") < apply.indexOf("settings.save("), true);
});

test("name + Save are one row, and the rule is one line (change 3)", () => {
  const nameRow = SOURCE.slice(SOURCE.indexOf("{/* name + save, one row */}"));
  assert.match(nameRow, /placeholder="Name \(optional\)"/);
  assert.match(nameRow, /accessibilityLabel="Save current account"/);
  // The rule status is a single Text (no separate title line, no section header above it).
  assert.match(SOURCE, /<Text style=\{styles\.label\} numberOfLines=\{2\}>\s*\{ruleLine\}/);
  // ... and it is built from the active card's own figures.
  assert.match(SOURCE, /Staying on \$\{who\}/);
});

test("layout: one card style, one horizontal inset, one control height (owner review of c34b2a34)", () => {
  // "Put the top controls in a CARD styled exactly like the account cards" — one function builds both.
  assert.match(SOURCE, /function cardStyle\(theme: PluginScreenProps\["theme"\], active = false\)/);
  const cards = SOURCE.match(/cardStyle\(theme/g) ?? [];
  assert.equal(cards.length >= 2, true, "the top block and the account cards must share the card style");
  // "One consistent horizontal padding for the whole screen" — set once, on the scroll content.
  assert.match(SOURCE, /paddingHorizontal: PAD/);
  assert.match(SOURCE, /const PAD = 12;/);
  // Inputs and buttons share one height and are centred against their labels.
  assert.match(SOURCE, /const CONTROL_HEIGHT = 32;/);
  assert.match(SOURCE, /height: CONTROL_HEIGHT/);
  // Spacing between rows is the middle ground the owner asked for, not the cramped 4 or the old 16.
  assert.match(SOURCE, /content: \{ gap: 10, paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 20 \}/);
  assert.match(SOURCE, /paddingVertical: 10,\s*\n\s*paddingHorizontal: 12/);
});

test("the chevron sits immediately after the help title, not at the far edge", () => {
  const header = SOURCE.slice(SOURCE.indexOf('accessibilityLabel="How this works"'));
  const row = header.slice(0, header.indexOf("</Pressable>"));
  const titleAt = row.indexOf("How this works</Text>");
  const chevronAt = row.indexOf("{helpOpen ?");
  assert.equal(titleAt >= 0 && chevronAt > titleAt, true, "the chevron must follow the title text");
  // ... and it is not pushed to the right with a space-between row any more.
  assert.equal(row.includes("justifyContent: \"space-between\""), false);
});

test("an account with no reading says it in one muted line and never prints an em-dash pair", () => {
  // Owner review: `"No reading yet." + "last seen — — refreshes when active"` became one line.
  assert.equal(CODE.includes("No reading yet."), false);
  assert.match(CODE, /No usage reading yet · it updates while this account is active/);
  assert.equal(/—\s*—/.test(CODE), false, "an em-dash pair must never be rendered");
});

test("the Clean up label carries its explanatory line, with the count still interpolated", () => {
  // Owner, 2026-10-27: "Clean up 7 leftover entries" alone made the owner ask what it was.
  const block = SOURCE.slice(SOURCE.indexOf("{cleanupLabelText !== null ? ("));
  const cleanup = block.slice(0, block.indexOf(") : null}"));
  // The label (count and all) is the button's own accessibility label, and the explanation sits under it in the same block.
  assert.match(cleanup, /accessibilityLabel=\{cleanupLabelText\}/);
  assert.match(cleanup, /Saved sign-ins under this plugin's name that no account card uses \(e\.g\. from test runs\)\. Your accounts above are never touched\./);
  // The count is never a literal: it comes from the payload's cleanup.label.
  assert.match(SOURCE, /const cleanupLabelText = state\?\.cleanup/);
  assert.equal(/Clean up 7 leftover/.test(SOURCE), false, "the count must not be hardcoded");
  // The line uses the muted style, not the error one.
  assert.equal(/statusDanger[^;]*Saved sign-ins/.test(cleanup), false);
});
