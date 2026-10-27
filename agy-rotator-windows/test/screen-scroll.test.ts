import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Owner, AC6 (2026-10-26): *"I couldnt scroll down. I have 2 account n i can see only one as it is not scrollable."*
//
// The screen rendered its body in a plain `View`, so anything past the viewport was clipped — with two accounts the
// second card was unreachable. There is no renderer in this suite (`react-native` is Flow-typed), so the check is
// structural: the ROOT element `AccountsSurface` returns must be a `ScrollView` carrying a style that fills the pane
// (`flex: 1`), with the spacing on its `contentContainerStyle`.
//
// What this cannot see: whether the host renders it as expected, or whether the content is tall enough to scroll. Those
// are the owner's eyes — this only stops the container silently going back to a non-scrolling one, which is the defect
// that was actually reported.

const SOURCE = readFileSync(new URL("../client/screen.tsx", import.meta.url), "utf8");

/**
 * The JSX tag the component's `return (` opens with. The regex wants a `return (` whose next non-blank line starts with a
 * tag — the component also contains `return () => {` (a cleanup function), which must not be mistaken for the body.
 */
function rootTagOf(source: string, component: string): string | null {
  const start = source.indexOf(`export function ${component}(`);
  assert.notEqual(start, -1, `${component} is gone from client/screen.tsx`);
  const match = /return \(\s*\n\s*<([A-Za-z][A-Za-z0-9.]*)/.exec(source.slice(start));
  assert.notEqual(match, null, `${component} has no JSX return`);
  return match?.[1] ?? null;
}

test("the accounts screen is a ScrollView at its root, not a plain View", () => {
  assert.equal(rootTagOf(SOURCE, "AccountsSurface"), "ScrollView");
});

test("ScrollView comes from the plugin UI module (the host's own scrolling)", () => {
  const ui = /import \{([^}]*)\} from "@getpaseo\/plugin\/client\/ui";/.exec(SOURCE);
  assert.notEqual(ui, null, "client/screen.tsx must import its UI primitives from @getpaseo/plugin/client/ui");
  assert.match(ui?.[1] ?? "", /\bScrollView\b/);
});

test("the scroll fills the pane and the spacing lives on the content container", () => {
  // `flex: 1` on the scroll is what makes it fill the screen height; without it the ScrollView collapses to its content
  // and nothing scrolls.
  assert.match(SOURCE, /scroll:\s*\{[^}]*flex:\s*1/);
  const root = /<ScrollView\s+style=\{([A-Za-z0-9_.]+)\}\s+contentContainerStyle=\{([A-Za-z0-9_.]+)\}/.exec(SOURCE);
  assert.notEqual(root, null, "the root ScrollView must carry a style and a contentContainerStyle");
  assert.equal(root?.[1], "styles.scroll");
  assert.equal(root?.[2], "styles.content");
});
