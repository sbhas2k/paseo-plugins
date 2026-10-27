// agy-rotator-windows — the "How this works" text (S3, owner 2026-10-26: *"Quota left also fine but use should have a drop down
// which tells how to use it. Quota, sequence etc."*).
//
// Kept out of the component and free of any literal setting value: the setpoint, the range and the timings are rendered
// from the live settings and from the constants the code actually obeys. A help text that hardcodes "80" would keep
// saying 80 after the owner changed it — the small version of this project's dominant defect.
//
// Every bullet below is checked against the code it describes:
//   1 — Save reads the live entry and stores it under the blob's own email (`server/store.ts` saveSlot).
//   2 — /usage costs no quota and writes nothing (plan F3); the tick is 10 minutes, and a turn end refreshes too.
//   3 — `decide()` triggers on EITHER Gemini bucket (the 3p group never triggers).
//   4 — S3's sequence walk: after the active account, wrapping, first qualifying; past `resetsAt` counts as refilled;
//       nothing qualifies → stay with a warning; `moveSlot` rewrites only the index.
//   5 — idle agents reload now, busy ones at their own turn end (pending set); a hand-started `agy` keeps its token in
//       memory (plan F8, settled by AC5) — so it is a warning, never a kill.
//   6 — a manual Switch ignores the sequence; a CLI sign-in is adopted, never reverted (R2-2).

import { MAX_USED_PCT, MIN_USED_PCT } from "./settings.ts";

export interface HelpSection {
  title: string;
  lines: string[];
}

export interface HelpNumbers {
  /** "Switch when used ≥ N %" — the live setting. */
  usedPct: number;
  /** The same setting in REMAINING terms, which is what `decide()` compares. */
  threshold: number;
}

/** The six groups, in the order a new owner needs them. Every number is interpolated. */
export function helpSections(numbers: HelpNumbers): HelpSection[] {
  const used = numbers.usedPct;
  return [
    {
      title: "Add an account",
      lines: [
        "Sign in with the agy CLI in a terminal (run agy, then its login), come back here, press Save and type a name.",
        "Repeat for each account. Saved sign-ins stay in Windows Credential Manager — nothing is shown or copied out.",
      ],
    },
    {
      title: "Usage bars",
      lines: [
        "Gemini 5-hour and weekly quota LEFT for each account, with how long until it resets.",
        "Refreshed every 10 minutes while an agy chat exists, and after an agy turn ends. Reading it costs no quota.",
        "An account that is not active gets its 5-hour figure live: every few minutes the plugin asks Google directly for it (no quota is spent), so both cards show a current 5-hour bar.",
        "The weekly figure only comes from agy itself, so an account that has never been active shows \"weekly unknown\" until it is.",
        "If an account needs a sign-in, its card says so - sign in with the CLI and press Save account.",
      ],
    },
    {
      title: "Auto-switch",
      lines: [
        `When the active account has used ${used} % or more of either Gemini bucket, this plugin moves to the next account.`,
        `Change that number in the setting below: anything from ${MIN_USED_PCT} to ${MAX_USED_PCT} % (decimals allowed). 100 % is refused, because it would only switch once the account was already empty.`,
        "At most one automatic switch every 10 minutes, so two accounts near the limit cannot flap back and forth. A turn that runs an account out of credits skips that wait.",
      ],
    },
    {
      title: "Sequence",
      lines: [
        "Accounts are tried in the numbered order, starting after the active one and wrapping around to the top.",
        "An account that is still at or past the limit is skipped — unless its reset time has passed, which means it has refilled.",
        "If no account qualifies they all stay put and a warning says so.",
        "Use ▲ / ▼ to reorder at any time. Reordering never switches anything by itself; the new order applies to the next switch.",
      ],
    },
    {
      title: "What a switch does",
      lines: [
        "Idle agy agents in Paseo reload and keep their conversation.",
        "A busy agent switches when its current turn ends.",
        "An agy you started yourself in a terminal keeps the old account until you restart it — this plugin never kills your processes.",
      ],
    },
    {
      title: "Manual control",
      lines: [
        "The Switch button on any account switches to it right now, ignoring the order.",
        "If you sign in to another account yourself at the CLI, this plugin adopts it rather than reverting you.",
      ],
    },
  ];
}

/** Everything as one string — for the tests that sweep the whole text. */
export function helpText(numbers: HelpNumbers): string {
  return helpSections(numbers)
    .map((section) => `${section.title}\n${section.lines.map((line) => `- ${line}`).join("\n")}`)
    .join("\n\n");
}

/** The screen's one preference: is the help open? Persisted in the plugin's settings document. */
export function withHelpToggled(settings: { helpOpen: boolean }): boolean {
  return !settings.helpOpen;
}
