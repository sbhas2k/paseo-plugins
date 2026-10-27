import assert from "node:assert/strict";
import { after, test } from "node:test";
import { credDelete, credRead, credWrite, writeLive } from "../server/cred.ts";
import { readIndex, renameSlot, saveSlot, setSlotUsage } from "../server/store.ts";
import { pendingFold, emptyPending, type PendingState } from "../shared/pending.ts";
import { emptySwitchState, switchAccount, type SwitchAgent, type SwitchOptions } from "../server/switch.ts";
import { autoDecide } from "../shared/auto.ts";
import { SingleFlight } from "../server/single-flight.ts";
import { keyOf, sweepFixtures, syntheticBlob, testEmail, testLiveTarget, trackFixture, withTempPaseoHome } from "../testutil/support.ts";

// AC11: whatever this file creates is swept even when a test throws before its own `finally` (see testutil/support.ts).
after(sweepFixtures);

// S2 — the switch sequence of plan §3.4, run in order against throwaway credentials through the REAL powershell helper.
// Only the two things that reach a running system are stubbed: the CLI reload and the timeline note (the dispatch's
// "with reload stubbed"). Everything else — the live entry, the slots, the own-email save, the read-back — is real.
//
// Order under test, because order is the rule (R2-4): save the live blob to the slot of ITS OWN email, write the
// target blob to the live entry, record the expected account BEFORE any further await, read the entry back once,
// reload the idle agents, queue the busy ones, note on every affected agent.

const idleAgent = (id: string): SwitchAgent => ({ id, provider: "antigravity-cli", status: "idle", activeTurn: null, archivedAt: null, title: id });
const busyAgent = (id: string): SwitchAgent => ({ id, provider: "antigravity-cli", status: "running", activeTurn: { id: "t1" }, archivedAt: null, title: id });

interface Harness {
  live: string;
  keyA: string;
  keyB: string;
  blobA: Buffer;
  blobB: Buffer;
  created: string[];
}

/** Two saved accounts (A saved from the live entry, B saved from its own blob) and a throwaway live target. */
async function setup(): Promise<Harness> {
  const live = testLiveTarget();
  const emailA = testEmail("account-a");
  const emailB = testEmail("account-b");
  const blobA = syntheticBlob(emailA);
  const blobB = syntheticBlob(emailB);
  const keyA = keyOf(emailA);
  const keyB = keyOf(emailB);
  // AC11: registered BEFORE anything is written, so a throw between the write and the caller's `finally` is still swept.
  trackFixture(live);
  trackFixture(`paseo-agy-accounts:${keyA}`);
  trackFixture(`paseo-agy-accounts:${keyB}`);
  // A is the account currently signed in: save it from the live entry, the way "Save current account" does.
  await writeLive(live, blobA);
  const savedA = await saveSlot(blobA);
  assert.equal(savedA.key, keyA);
  await renameSlot(keyA, "Account A");
  await credWrite(`paseo-agy-accounts:${keyB}`, blobB);
  const savedB = await saveSlot(blobB);
  assert.equal(savedB.key, keyB);
  await renameSlot(keyB, "Account B");
  return { live, keyA, keyB, blobA, blobB, created: [`paseo-agy-accounts:${keyA}`, `paseo-agy-accounts:${keyB}`, live] };
}

/** The real sequence with the two side-effecting dependencies recorded instead of performed. */
function deps(
  agents: SwitchAgent[],
  options: { failReloadFor?: string; notesAvailable?: boolean; corruptWrite?: boolean; reloadMs?: number } = {},
) {
  const reloaded: string[] = [];
  const notes: Array<{ agentId: string; text: string }> = [];
  // S3: reloads are dispatched in parallel, so a test can see how many were in flight at once.
  let active = 0;
  let maxActive = 0;
  return {
    reloaded,
    notes,
    stats: () => ({ maxActive }),
    deps: {
      listAgents: async () => agents,
      reload: async (agentId: string) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (options.reloadMs) await new Promise((resolve) => setTimeout(resolve, options.reloadMs));
          if (options.failReloadFor === agentId) return "CLI did not answer in time";
          reloaded.push(agentId);
          return null;
        } finally {
          active -= 1;
        }
      },
      note: async (agentId: string, text: string) => {
        if (options.notesAvailable === false) return false;
        notes.push({ agentId, text });
        return true;
      },
      writeLive: async (target: string, blob: Buffer) => {
        // A write that "succeeds" but lands different bytes is what the read-back step exists to catch: flip one byte
        // in the middle, so the length matches and only the content differs.
        const landed = Buffer.from(blob);
        if (options.corruptWrite) landed[Math.floor(landed.length / 2)] ^= 0xff;
        await writeLive(target, landed);
      },
    },
  };
}

test("the whole switch: own-email save, live write, expected recorded, read-back, idle reload, busy queued, notes", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([idleAgent("a1"), busyAgent("a2"), { id: "a3", provider: "antigravity-cli", status: "idle", activeTurn: null, archivedAt: "2026-10-01T00:00:00Z" }]);
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });

      assert.equal(result.ok, true);
      // (b) the live entry now holds B, byte for byte.
      assert.deepEqual(await credRead(harness.live), harness.blobB);
      // (a) A's own slot still holds A — the switch saved what was live before overwriting it.
      assert.deepEqual(await credRead(`paseo-agy-accounts:${harness.keyA}`), harness.blobA);
      // R2-4: the expected account is recorded, and the step order proves it happened before the read-back.
      assert.deepEqual(state.expected, { key: harness.keyB, label: "Account B" });
      const recorded = result.steps.findIndex((step) => step.startsWith("recorded expected"));
      const readBack = result.steps.findIndex((step) => step.startsWith("read back"));
      assert.equal(recorded >= 0 && readBack > recorded, true, result.steps.join(" | "));
      // Only the idle, live agents are dispatched now; the busy one waits for its own turn end.
      assert.deepEqual(result.dispatched, ["a1"]);
      assert.deepEqual(state.pending.ids, ["a2"]);
      // The RPC returns before the CLI reloads finish (S3: switching must feel immediate), so the counts arrive here.
      const done = await result.completion;
      assert.deepEqual(done.reloaded, ["a1"]);
      assert.deepEqual(done.failed, []);
      // Notes are written before the RPC answers (they are local and fast), so that flag is on the result itself.
      assert.equal(result.noteFailed, false);
      // A note on every affected idle+busy agent, by label only (AC7).
      assert.deepEqual(recorder.notes.map((note) => note.agentId).sort(), ["a1", "a2"]);
      assert.match(recorder.notes[0].text, /Account A/);
      assert.match(recorder.notes[0].text, /Account B/);
      for (const note of recorder.notes) assert.equal(note.text.includes("@"), false, note.text);
      assert.equal(done.ms >= 0, true);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a switch after the owner logged out (no live entry) still writes the slot and records the expectation", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      await credDelete(harness.live);
      const state = emptySwitchState();
      const recorder = deps([]);
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      assert.equal(result.ok, true);
      assert.deepEqual(await credRead(harness.live), harness.blobB);
      assert.deepEqual(state.expected, { key: harness.keyB, label: "Account B" });
      assert.equal(result.steps.some((step) => step.startsWith("saved the live sign-in")), false);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a slot whose credential is gone fails without touching the live entry or the expectation", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      await credDelete(`paseo-agy-accounts:${harness.keyB}`);
      const state = emptySwitchState();
      const recorder = deps([]);
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      assert.equal(result.ok, false);
      assert.equal(result.message.includes("no saved credential") || result.message.includes("no credential"), true, result.message);
      assert.deepEqual(await credRead(harness.live), harness.blobA);
      assert.equal(state.expected, null);
      assert.deepEqual(recorder.reloaded, []);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a CredWrite that landed different bytes is caught by the read-back, and the expectation still stands", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([], { corruptWrite: true });
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      assert.equal(result.ok, false);
      assert.equal(result.steps.some((step) => step.includes("BYTES DIFFER")), true, result.steps.join(" | "));
      // R2-4: the expectation is recorded regardless — a re-assert would try again on the next tick.
      assert.deepEqual(state.expected, { key: harness.keyB, label: "Account B" });
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a failed reload is reported, and the switch itself still counts as done", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([idleAgent("a1"), idleAgent("a2")], { failReloadFor: "a1" });
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      assert.equal(result.ok, true);
      const done = await result.completion;
      assert.deepEqual(done.reloaded, ["a2"]);
      assert.deepEqual(done.failed.map((entry) => entry.id), ["a1"]);
      assert.equal(result.steps.some((step) => step.includes("reload a1 failed")), true, result.steps.join(" | "));
      // A failed reload does not make the switch itself a failure: the credential is written and the agent is stuck
      // only until its next session open, which re-asserts anyway.
      assert.deepEqual(state.pending.ids, []);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("when the timeline cannot be written the switch says so instead of pretending", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([idleAgent("a1")], { notesAvailable: false });
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      assert.equal(result.ok, true);
      assert.equal(result.noteFailed, true);
      assert.equal(result.steps.some((step) => step.includes("timeline note")), true, result.steps.join(" | "));
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("the result payloads carry labels and keys only (AC7)", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: deps([]).deps });
      const text = JSON.stringify(result) + JSON.stringify(state);
      for (const forbidden of ["@", "access_token", "refresh_token", "synthetic-access-token", "example.invalid"]) {
        assert.equal(text.includes(forbidden), false, forbidden);
      }
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("reloads run in parallel: one slow CLI reload does not hold up the others", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([idleAgent("a1"), idleAgent("a2"), idleAgent("a3")], { reloadMs: 40 });
      const result = await switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: recorder.deps });
      const done = await result.completion;
      assert.deepEqual(result.dispatched, ["a1", "a2", "a3"]);
      assert.equal(recorder.stats().maxActive, 3, "all three reloads were in flight together");
      assert.deepEqual(done.reloaded.sort(), ["a1", "a2", "a3"]);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("the dispatch is announced before any reload finishes, so the screen can count them", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const seen: string[][] = [];
      const recorder = deps([idleAgent("a1"), idleAgent("a2")], { reloadMs: 30 });
      const result = await switchAccount({
        key: harness.keyB,
        liveTarget: harness.live,
        state,
        deps: recorder.deps,
        onDispatch: (ids) => seen.push([...ids]),
      });
      // The callback fired by the time the RPC answered, and the reloads were still running.
      assert.deepEqual(seen, [["a1", "a2"]]);
      assert.equal(recorder.reloaded.length, 0, "no reload had finished when the switch returned");
      await result.completion;
      assert.deepEqual(recorder.reloaded.sort(), ["a1", "a2"]);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("an exhausted departure is zeroed in its own slot, so the rule cannot bounce straight back (F-01)", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps([]);
      const NOW = Date.parse("2026-10-26T14:00:00Z");
      const reading = {
        gemini5h: { remaining: 0.9, resetsAt: "2026-10-26T18:13:01Z" },
        geminiWeekly: { remaining: 0.9, resetsAt: "2026-11-02T13:13:01Z" },
        threep5h: null,
        threepWeekly: null,
      };
      const result = await switchAccount({
        key: harness.keyB,
        liveTarget: harness.live,
        state,
        deps: recorder.deps,
        departing: { exhausted: true, reading },
      });
      assert.equal(result.ok, true);
      await result.completion;

      // A — the account we left because it ran out — is recorded as zero on both Gemini buckets, with its own resets.
      const departed = (await readIndex()).find((entry) => entry.key === harness.keyA);
      assert.equal(departed?.lastUsage?.reading?.gemini5h?.remaining, 0);
      assert.equal(departed?.lastUsage?.reading?.geminiWeekly?.remaining, 0);
      assert.equal(departed?.lastUsage?.reading?.gemini5h?.resetsAt, "2026-10-26T18:13:01Z");
      assert.equal(departed?.lastUsage?.reading?.geminiWeekly?.resetsAt, "2026-11-02T13:13:01Z");

      // B's own turn now fails the same way: with A zeroed there is nowhere to go, so the rule stays instead of
      // bouncing back (the guard is bypassed for credits_exhausted, which is exactly why the zero must exist).
      const index = await readIndex();
      const next = autoDecide({
        enabled: true,
        threshold: 0.2,
        active: { key: harness.keyB, label: "Account B", reading },
        slots: index.map((entry) => ({ key: entry.key, label: entry.label, reading: entry.lastUsage?.reading ?? null })),
        outcome: { kind: "failed", error: { message: "out of credits", code: "credits_exhausted" } },
        lastSwitchAt: null,
        now: NOW + 60_000,
      });
      assert.equal(next.kind, "stay");
      assert.match(next.reason, /no saved account has room/i);
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("two concurrent switches write the live credential exactly once (F-02)", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const flight = new SingleFlight();
      const writes: string[] = [];
      const recorder = deps([idleAgent("a1")]);
      const counted = {
        ...recorder.deps,
        writeLive: async (target: string, blob: Buffer) => {
          writes.push(target);
          await recorder.deps.writeLive(target, blob);
        },
      };
      // The same wrapper the server uses: only one of the two may reach the credential.
      const work = () => switchAccount({ key: harness.keyB, liveTarget: harness.live, state, deps: counted });
      const [first, second] = await Promise.all([flight.run(work), flight.run(work)]);
      assert.equal(writes.length, 1, "the live credential was written twice");
      assert.equal([first.ran, second.ran].filter(Boolean).length, 1);
      const winner = first.ran ? first : second;
      if (winner.ran) await winner.value.completion;
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

// S4 / N1 (r5): the reading that TRIGGERED the switch is persisted under the departing slot before the live write. A
// stale-high weekly left on the departed slot is what would let the one post-switch hop go straight back.
test("the departing account keeps the reading that triggered the switch, not a stale one (N1)", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      // A's stored reading says it has plenty of room; the live snapshot says it is nearly out.
      await setSlotUsage(harness.keyA, {
        at: "2026-10-27T00:00:00Z",
        reading: { gemini5h: { remaining: 0.9, resetsAt: "2026-10-26T18:13:01Z" }, geminiWeekly: { remaining: 0.9, resetsAt: "2026-11-02T13:13:01Z" }, threep5h: null, threepWeekly: null },
      });
      const snapshot = {
        gemini5h: { remaining: 0.05, resetsAt: "2026-10-27T04:00:00Z" },
        geminiWeekly: { remaining: 0.06, resetsAt: "2026-11-02T13:13:01Z" },
        threep5h: null,
        threepWeekly: null,
      };
      const state = emptySwitchState();
      const result = await switchAccount({
        key: harness.keyB,
        liveTarget: harness.live,
        state,
        deps: deps([]).deps,
        departing: { exhausted: false, reading: snapshot },
      });
      assert.equal(result.ok, true);
      await result.completion;
      const departed = (await readIndex()).find((entry) => entry.key === harness.keyA);
      assert.equal(departed?.lastUsage?.reading?.gemini5h?.remaining, 0.05, "the trigger snapshot was not stored under the departing slot");
      // With the true (low) reading there is nowhere to hop back to.
      const next = autoDecide({
        enabled: true,
        threshold: 0.2,
        active: { key: harness.keyB, label: "Account B", reading: { ...snapshot, gemini5h: { remaining: 0.9, resetsAt: null }, geminiWeekly: { remaining: 0.9, resetsAt: null } } },
        slots: [{ key: harness.keyA, label: "Account A", reading: snapshot }],
        lastSwitchAt: null,
        now: Date.now(),
        postSwitch: true,
        postSwitchHops: 0,
      });
      assert.equal(next.kind, "stay");
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a newer switch replaces the pending queue rather than adding to it", () => {
  const first = pendingFold(emptyPending(), { kind: "switch", idle: [], busy: ["a2", "a3"] }).state;
  const second = pendingFold(first, { kind: "switch", idle: [], busy: ["a3"] }).state;
  assert.deepEqual(second.ids, ["a3"]);
});

// F-04 (Gemini review 9da9e943): this used to be `const options: SwitchOptions | null = null; assert.equal(options, null)`
// — a tautology about a local literal that proved nothing about the switch. It is replaced by the behaviour it was
// reaching for: with no reload wired (the real dependency's default), the switch must SAY the reload failed instead of
// reporting success, because "reloaded nothing, no error" is this project's dominant defect class.
test("a switch whose reload is not wired reports the failure instead of a silent success", async () => {
  await withTempPaseoHome(async () => {
    const harness = await setup();
    try {
      const state = emptySwitchState();
      const result = await switchAccount({
        key: harness.keyB,
        liveTarget: harness.live,
        state,
        deps: { listAgents: async () => [idleAgent("a1")] },
      });
      const done = await result.completion;
      assert.equal(result.ok, true, "the credential part still succeeded");
      assert.deepEqual(result.dispatched, ["a1"]);
      assert.deepEqual(done.reloaded, []);
      assert.deepEqual(done.failed.map((entry) => entry.id), ["a1"]);
      assert.match(done.failed[0].error, /not wired/i);
      assert.equal(result.steps.some((step) => step.includes("reload a1 failed")), true, result.steps.join(" | "));
    } finally {
      for (const target of harness.created) await credDelete(target).catch(() => false);
    }
  });
});
