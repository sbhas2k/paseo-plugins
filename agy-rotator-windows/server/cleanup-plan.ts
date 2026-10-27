// agy-rotator-windows — "Clean up N leftover entries" (plan §3.7 "Slot hygiene", R4-3/R4-12; AC11).
//
// The suite can leave slot-shaped credentials behind (a fixture whose test failed before its `finally`), and the spike
// found 7. The clean-up is an owner's press, never automatic, and it is deliberately narrow:
//
//   * only targets under `paseo-agy-accounts:` — never `gemini:*`, never anything else in the vault;
//   * only targets ABSENT from a **lossless** index — if the index could not be read without loss, the button is hidden,
//     because "not in the index" would then mean "lost", not "orphan";
//   * NEVER the account the plugin expects (`state.expected`) or the one it switched to last (`lastSwitch.toKey`),
//     whatever the index says.
//
// Pure planning here; the deletion is one `credDelete` per planned target inside the store's serialised queue, so a
// save/remove can never interleave between the census and the index line it compares against.

export const SLOT_PREFIX = "paseo-agy-accounts:";

export interface IndexHealth {
  /** False when the file exists but could not be parsed, or rows were dropped by the parser. */
  lossless: boolean;
  detail: string;
}

export interface CleanupInput {
  /** Every target the vault reports under the prefix (names only — the census never reads a blob). */
  census: readonly string[];
  /** Keys currently in `index.json`. */
  indexKeys: readonly string[];
  health: IndexHealth;
  /** `state.expected.key` and `state.json`'s `lastSwitch.toKey` — never deletable. */
  protectedKeys: ReadonlyArray<string | null | undefined>;
}

export interface CleanupPlan {
  deletable: string[];
  kept: string[];
  /** Set when nothing may be deleted; the screen shows this instead of a button. */
  refuseReason: string | null;
}

export function planCleanup(input: CleanupInput): CleanupPlan {
  if (!input.health.lossless) {
    return { deletable: [], kept: [...input.census], refuseReason: `the account index could not be read without loss (${input.health.detail})` };
  }
  const indexed = new Set(input.indexKeys);
  const protectedKeys = new Set(input.protectedKeys.filter((key): key is string => typeof key === "string" && key.length > 0));
  const deletable: string[] = [];
  const kept: string[] = [];
  for (const target of input.census) {
    // Belt and braces: the census is already filtered, but nothing outside the prefix may ever be deleted.
    if (!target.startsWith(SLOT_PREFIX)) {
      kept.push(target);
      continue;
    }
    const key = target.slice(SLOT_PREFIX.length);
    if (indexed.has(key) || protectedKeys.has(key)) kept.push(target);
    else deletable.push(target);
  }
  return { deletable, kept, refuseReason: null };
}

/** One line for the screen: "3 leftover entries" / "No leftovers". */
export function cleanupLabel(plan: CleanupPlan): string {
  if (plan.refuseReason !== null) return `Clean up unavailable - ${plan.refuseReason}`;
  return plan.deletable.length === 0 ? "No leftover entries" : `Clean up ${plan.deletable.length} leftover entries`;
}
