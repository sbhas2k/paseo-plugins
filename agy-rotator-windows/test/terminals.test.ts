import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalStale } from "../shared/terminals.ts";

// S3 — the owner-terminal reminder (fact F8, settled by AC5: a running `agy` holds its sign-in IN MEMORY).
//
// A switch writes the credential and reloads every Paseo agent, so those move. A terminal the owner started by hand
// keeps spending the OLD account until it is restarted, and the plugin must say so rather than pretend — and must never
// kill it (§4 of the plan).

const SWITCH_AT = "2026-10-26T14:00:00Z";
const before = "2026-10-26T13:00:00Z";
const after = "2026-10-26T15:00:00Z";

const proc = (pid: number, creationDate: string | null, parentName: string | null) => ({ pid, creationDate, parentName });

test("a hand-started agy from before the switch is counted", () => {
  assert.equal(terminalStale([proc(1, before, "WindowsTerminal"), proc(2, before, null)], SWITCH_AT), 2);
});

test("the agents the plugin just reloaded are not terminal reminders", () => {
  assert.equal(terminalStale([proc(1, before, "Paseo"), proc(2, before, "paseo")], SWITCH_AT), 0);
});

test("an agy started after the switch already reads the new sign-in", () => {
  assert.equal(terminalStale([proc(1, after, "WindowsTerminal")], SWITCH_AT), 0);
});

test("no switch yet, or no switch time, means nothing to report", () => {
  assert.equal(terminalStale([proc(1, before, "WindowsTerminal")], null), 0);
  assert.equal(terminalStale([proc(1, before, "WindowsTerminal")], "not a date"), 0);
});

test("a process with an unreadable creation date is not counted (it cannot be dated before the switch)", () => {
  assert.equal(terminalStale([proc(1, "not a date", "WindowsTerminal"), proc(2, null, "WindowsTerminal")], SWITCH_AT), 0);
});

test("a Paseo relaunch still counts as Paseo, whatever the case or the path shape", () => {
  assert.equal(terminalStale([proc(1, before, "  Paseo  "), proc(2, before, "Paseo Helper")], SWITCH_AT), 1);
});

test("nothing running is zero, not an error", () => {
  assert.equal(terminalStale([], SWITCH_AT), 0);
});
