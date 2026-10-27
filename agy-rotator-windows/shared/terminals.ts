// agy-rotator-windows — the owner-terminal reminder (fact F8, settled by AC5: a running `agy` holds its sign-in IN MEMORY).
//
// A switch writes the credential, and the plugin reloads every Paseo agent, so those move to the new account. A terminal
// the owner started by hand keeps spending the OLD account until it is restarted — measured in AC5: after the switch the
// terminal's `/usage` still showed the first account, and only a fresh `agy` showed the second.
//
// The plugin says so and does nothing else. §4 of the plan: it never kills a process it does not own.
//
// Pure: no Paseo, no `node:` import.

import type { AgyProcess } from "./census.ts";
import { parseCimCreationDate } from "./drift.ts";

/**
 * The one parent that means "Paseo spawned this agy, and the switch just reloaded it": the app executable itself.
 * `Get-Process` drops the `.exe`. A Paseo *helper* is deliberately not in here — a helper does not own an agent, so an
 * agy under one is not something a reload moved.
 */
const PASEO = /^paseo$/i;

/**
 * How many `agy.exe` processes are still holding the account from before `switchAt`: started before the switch, and not
 * a child of Paseo (whose agents were reloaded). An unreadable creation date cannot be dated before the switch, so it is
 * not counted — a reminder that guesses is worse than one that stays quiet.
 */
export function terminalStale(processes: readonly AgyProcess[], switchAt: string | null): number {
  if (switchAt === null) return 0;
  const switched = Date.parse(switchAt);
  if (!Number.isFinite(switched)) return 0;
  return processes.filter((process) => {
    const created = parseCimCreationDate(process.creationDate);
    if (created === null || created >= switched) return false;
    const parent = (process.parentName ?? "").trim();
    return !PASEO.test(parent);
  }).length;
}
