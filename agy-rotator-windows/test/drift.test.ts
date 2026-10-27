import assert from "node:assert/strict";
import { test } from "node:test";
import { drift, parseCimCreationDate, staleWriterExists } from "../shared/drift.ts";
import { emptyPending, pendingFold, type PendingEvent, type PendingState } from "../shared/pending.ts";

// S2 — the two rules the re-assert and the switch stand on, and the pending set that carries a busy agent to its own
// turn end. All pure: no Paseo, no credential, no clock.
//
// `drift` is plan §3.5 with the r3 implementer notes:
//   (i)  adopting must NOT reload agents — it is not a switch;
//   (ii) a missing live entry is a SIGNED-OUT state, never a drift — never write into a logout→login gap;
//   (iii) the pending agent's status is re-read right before reloading it.

const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";

// --- drift ---
test("no live entry is signed-out, whatever the expectation says (r3 note ii: never write into the gap)", () => {
  assert.equal(drift(null, A, [A, B], true), "signed-out");
  assert.equal(drift(null, A, [A, B], false), "signed-out");
  assert.equal(drift(null, null, [], false), "signed-out");
});

test("the live entry belonging to the expected account is ok", () => {
  assert.equal(drift(A, A, [A, B], false), "ok");
  assert.equal(drift(A, A, [A, B], true), "ok");
});

test("an account nobody saved is adopted as unknown, never re-asserted", () => {
  assert.equal(drift(C, A, [A, B], true), "adopt-unknown");
  assert.equal(drift(C, A, [A, B], false), "adopt-unknown");
  assert.equal(drift(C, null, [], true), "adopt-unknown");
});

test("a saved account that is not the expected one is adopted unless a stale writer explains it", () => {
  // An owner `/login` at the CLI: no stray writer, so the plugin must honour it (R2-2).
  assert.equal(drift(B, A, [A, B], false), "adopt-known");
  // A stray agy.exe older than our own last write: it refreshed A back after the switch, so re-assert (F7/F12).
  assert.equal(drift(B, A, [A, B], true), "reassert");
});

test("an unprimed expectation adopts whatever is live and writes nothing", () => {
  assert.equal(drift(B, null, [A, B], false), "adopt-known");
  assert.equal(drift(B, null, [A, B], true), "adopt-known");
  assert.equal(drift(C, null, [A, B], true), "adopt-unknown");
});

test("the rule is symmetric: expected A while B is saved and stale is a re-assert, expected B while A is live is too", () => {
  assert.equal(drift(A, B, [A, B], true), "reassert");
  assert.equal(drift(A, B, [A, B], false), "adopt-known");
});

// --- the stale-writer census ---
test("a writer older than our last CredWrite is stale; one created after it is not", () => {
  const processes = [
    { pid: 100, creationDate: "2026-10-26T12:00:00Z" },
    { pid: 200, creationDate: "2026-10-26T14:00:00Z" },
  ];
  assert.equal(staleWriterExists(processes, "2026-10-26T13:00:00Z"), true);
  assert.equal(staleWriterExists(processes, "2026-10-26T11:00:00Z"), false);
});

test("no live writer, or a plugin that has never written, is not a stale writer", () => {
  assert.equal(staleWriterExists([], "2026-10-26T13:00:00Z"), false);
  assert.equal(staleWriterExists([{ pid: 1, creationDate: "2026-10-26T12:00:00Z" }], null), false);
});

test("a process with an unparseable creation date cannot justify a re-assert", () => {
  assert.equal(staleWriterExists([{ pid: 1, creationDate: "not a date" }], "2026-10-26T13:00:00Z"), false);
});

test("CIM creation dates parse as ISO and as the PowerShell 5.1 /Date(ms)/ shape", () => {
  assert.equal(parseCimCreationDate("2026-10-26T12:00:00Z"), Date.parse("2026-10-26T12:00:00Z"));
  assert.equal(parseCimCreationDate("/Date(1761487200000)/"), 1761487200000);
  assert.equal(parseCimCreationDate(1761487200000), 1761487200000);
  assert.equal(parseCimCreationDate(""), null);
  assert.equal(parseCimCreationDate(null), null);
});

// --- the pending set ---
const idle = (id: string) => ({ id, status: "idle" });
/** Feed a list of events through the fold, keeping the last state and the reloads it asked for. */
function events(state: PendingState, list: PendingEvent[]) {
  let current = state;
  let reload: string[] = [];
  for (const event of list) {
    const outcome = pendingFold(current, event);
    current = outcome.state;
    reload = outcome.reload;
  }
  return { state: current, reload };
}

test("a switch reloads the idle agents now and queues the busy ones", () => {
  const out = pendingFold(emptyPending(), { kind: "switch", idle: ["a1", "a2"], busy: ["a3"] });
  assert.deepEqual(out.reload, ["a1", "a2"]);
  assert.deepEqual(out.state.ids, ["a3"]);
});

test("a newer switch replaces the queue instead of adding to it (R2-5)", () => {
  const first = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a3", "a4"] });
  const second = pendingFold(first.state, { kind: "switch", idle: ["a5"], busy: ["a4"] });
  assert.deepEqual(second.reload, ["a5"]);
  assert.deepEqual(second.state.ids, ["a4"]);
});

test("a pending agent is reloaded at its own turn end, once, and only while idle", () => {
  const queued = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a3"] }).state;
  const running = pendingFold(queued, { kind: "turn_end", agent: { id: "a3", status: "running" } });
  assert.deepEqual(running.reload, []);
  assert.deepEqual(running.state.ids, ["a3"]);

  const idleEnd = pendingFold(running.state, { kind: "turn_end", agent: idle("a3") });
  assert.deepEqual(idleEnd.reload, ["a3"]);
  assert.deepEqual(idleEnd.state.ids, []);

  const again = pendingFold(idleEnd.state, { kind: "turn_end", agent: idle("a3") });
  assert.deepEqual(again.reload, []);
});

test("a turn end of an agent that is not pending reloads nothing", () => {
  const out = pendingFold(emptyPending(), { kind: "turn_end", agent: idle("a9") });
  assert.deepEqual(out.reload, []);
  assert.deepEqual(out.state.ids, []);
});

test("an archived or closed agent leaves the pending set", () => {
  const queued = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a3", "a4"] }).state;
  assert.deepEqual(pendingFold(queued, { kind: "archived", agentId: "a3" }).state.ids, ["a4"]);
  assert.deepEqual(pendingFold(queued, { kind: "closed", agentId: "a4" }).state.ids, ["a3"]);
});

test("the fold never mutates the state it is given", () => {
  const start = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a3"] }).state;
  const before = [...start.ids];
  pendingFold(start, { kind: "archived", agentId: "a3" });
  pendingFold(start, { kind: "switch", idle: ["a1"], busy: [] });
  assert.deepEqual(start.ids, before);
});

test("a switch that finds every agent busy queues all of them", () => {
  const out = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a1", "a2", "a3"] });
  assert.deepEqual(out.reload, []);
  assert.deepEqual(out.state.ids, ["a1", "a2", "a3"]);
});

test("the same agent is queued once however often it is reported busy", () => {
  const out = events(emptyPending(), [
    { kind: "switch", idle: [], busy: ["a1", "a1"] },
    { kind: "switch", idle: [], busy: ["a1"] },
  ]);
  assert.deepEqual(out.state.ids, ["a1"]);
});
