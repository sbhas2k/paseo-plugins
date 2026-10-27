import assert from "node:assert/strict";
import { after, test } from "node:test";
import { credDelete, credRead, writeLive } from "../server/cred.ts";
import { readIndex, renameSlot, saveSlot } from "../server/store.ts";
import { reassert, type ReassertDeps } from "../server/reassert.ts";
import { emptySwitchState } from "../server/switch.ts";
import { keyOf, sweepFixtures, syntheticBlob, testEmail, testLiveTarget, trackFixture, withTempPaseoHome } from "../testutil/support.ts";

// AC11: swept even when a test throws before its own `finally`.
after(sweepFixtures);

// S2 — the re-assert (plan §3.5) with the three r3 implementer notes:
//   (i)   an adoption is NOT a switch: it reloads nothing. `reassert.ts` has no reload dependency at all, which is the
//         structural version of that rule — and its note says the rule will re-evaluate, not that the owner acted.
//   (ii)  a missing live entry is the signed-out state: no write, no adoption, nothing reverted into the logout→login gap.
//   (iii) the caller re-reads a pending agent's status before reloading (that is `server/switch.ts`; nothing here reloads).
//
// And the discriminator that keeps the plugin from fighting the owner (r2 R2-2): a known account that is not the
// expected one is only written back when an `agy.exe` older than our last `CredWrite` could have written it there.

interface Wire {
  expected: string;
  live: Buffer;
  liveTarget: string;
  created: string[];
}

/** Two saved accounts and a throwaway live entry currently holding A. */
async function setup(): Promise<Wire> {
  const liveTarget = testLiveTarget();
  const emailA = testEmail("reassert-a");
  const emailB = testEmail("reassert-b");
  const blobA = syntheticBlob(emailA);
  const blobB = syntheticBlob(emailB);
  const keyA = keyOf(emailA);
  const keyB = keyOf(emailB);
  // AC11: registered before the first write (see the other setup()).
  trackFixture(liveTarget);
  trackFixture(`paseo-agy-accounts:${keyA}`);
  trackFixture(`paseo-agy-accounts:${keyB}`);
  await writeLive(liveTarget, blobA);
  await saveSlot(blobA);
  await renameSlot(keyA, "Account A");
  await saveSlot(blobB);
  await renameSlot(keyB, "Account B");
  return { expected: keyB, live: blobA, liveTarget, created: [`paseo-agy-accounts:${keyA}`, `paseo-agy-accounts:${keyB}`, liveTarget] };
}

/** Real credential/store calls; only the side effects that reach Paseo are stubbed. */
function deps(options: { staleWriter?: boolean; agents?: string[]; notesAvailable?: boolean } = {}) {
  const notes: Array<{ agentId: string; text: string }> = [];
  const writes: string[] = [];
  const d: Partial<ReassertDeps> = {
    census: async () =>
      options.staleWriter ? [{ pid: 4242, creationDate: "2026-10-26T10:00:00Z" }] : [],
    listAgents: async () => (options.agents ?? []).map((id) => ({ id, provider: "antigravity-cli", status: "idle", activeTurn: null, archivedAt: null, title: id })),
    note: async (agentId: string, text: string) => {
      if (options.notesAvailable === false) return false;
      notes.push({ agentId, text });
      return true;
    },
  };
  return { notes, writes, deps: d };
}

test("no live entry is signed-out: nothing is written and the expectation is left alone (r3 note ii)", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      await credDelete(wire.liveTarget);
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" } };
      const recorder = deps({ staleWriter: true });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps });
      assert.equal(result.kind, "signed-out");
      assert.equal(result.acted, "none");
      assert.deepEqual(state.expected, { key: wire.expected, label: "Account B" });
      assert.equal(state.signedOut, true);
      assert.equal(await credRead(wire.liveTarget), null);
      assert.deepEqual(recorder.notes, []);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("the live entry already being the expected account is ok and does nothing", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = { ...emptySwitchState(), expected: { key: keyOf("x@example.invalid"), label: "x" } };
      // Point the expectation at whichever account A is: re-read the index so the label matches reality.
      const index = await readIndex();
      const a = index.find((entry) => entry.label === "Account A");
      assert.notEqual(a, undefined);
      state.expected = { key: a!.key, label: a!.label };
      const recorder = deps({});
      const before = await credRead(wire.liveTarget);
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps });
      assert.equal(result.kind, "ok");
      assert.equal(result.acted, "none");
      assert.deepEqual(await credRead(wire.liveTarget), before);
      assert.deepEqual(recorder.notes, []);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a live account nobody saved is adopted as unknown: a new slot, no write-back, no reload", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const emailC = testEmail("reassert-c");
      const keyC = keyOf(emailC);
      wire.created.push(`paseo-agy-accounts:${keyC}`);
      const blobC = syntheticBlob(emailC);
      await writeLive(wire.liveTarget, blobC);
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" } };
      const recorder = deps({ staleWriter: true }); // a stale writer cannot justify reverting an UNSAVED account
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "adopt-unknown");
      assert.equal(result.acted, "adopted");
      // The slot exists, keyed by the blob's own email, under the unsaved- label.
      assert.deepEqual(await credRead(`paseo-agy-accounts:${keyC}`), blobC);
      assert.match(state.expected?.label ?? "", /^unsaved-/);
      assert.equal(state.expected?.key, keyC);
      // No write-back: the live entry is untouched.
      assert.deepEqual(await credRead(wire.liveTarget), blobC);
      // One note, about a re-evaluation, naming a label — never "signed in by hand" for an unsaved account.
      assert.equal(recorder.notes.length, 1);
      assert.match(recorder.notes[0].text, /re-evaluate/);
      assert.equal(recorder.notes[0].text.includes("@"), false);
      // Adoption is not a switch: the pending set is untouched.
      assert.deepEqual(state.pending.ids, []);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a known account with no stale writer is adopted as an owner sign-in and never reverted", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" } };
      const recorder = deps({ staleWriter: false });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "adopt-known");
      assert.equal(result.acted, "adopted");
      assert.equal(state.expected?.label, "Account A");
      assert.deepEqual(await credRead(wire.liveTarget), wire.live);
      assert.equal(recorder.notes.length, 1);
      assert.match(recorder.notes[0].text, /signed in by hand/);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a known account with an older agy.exe still running is re-asserted back to the expected one", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" }, lastCredWriteAt: "2026-10-26T12:00:00Z" };
      const recorder = deps({ staleWriter: true });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "reassert");
      assert.equal(result.acted, "reasserted");
      // B's blob is back in the live entry, byte for byte.
      const index = await readIndex();
      const b = index.find((entry) => entry.label === "Account B");
      assert.notEqual(b, undefined);
      const bBlob = await credRead(`paseo-agy-accounts:${b!.key}`);
      assert.notEqual(bBlob, null);
      assert.deepEqual(await credRead(wire.liveTarget), bBlob);
      assert.match(recorder.notes[0].text, /Account B/);
      assert.equal(recorder.notes[0].text.includes("@"), false);
      assert.equal(state.lastCredWriteAt === "2026-10-26T12:00:00Z", false, "lastCredWriteAt must advance");
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a re-assert whose expected slot is gone adopts the live account instead of writing nonsense", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" }, lastCredWriteAt: "2026-10-26T12:00:00Z" };
      await credDelete(`paseo-agy-accounts:${wire.expected}`);
      const recorder = deps({ staleWriter: true });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "adopt-known");
      assert.deepEqual(await credRead(wire.liveTarget), wire.live);
      assert.equal(state.expected?.label, "Account A");
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("a live blob with no id_token_email is reported unreadable, never adopted and never written", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const noEmail = Buffer.from(JSON.stringify({ token: { access_token: "x" }, auth_method: "synthetic" }), "utf8");
      await writeLive(wire.liveTarget, noEmail);
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" } };
      const recorder = deps({ staleWriter: true });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "unreadable");
      assert.equal(result.acted, "none");
      assert.deepEqual(await credRead(wire.liveTarget), noEmail);
      assert.equal(state.expected?.label, "Account B");
      assert.deepEqual(recorder.notes, []);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("an unprimed expectation adopts the live account with a plain note, not a claim about the owner", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = emptySwitchState();
      const recorder = deps({});
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      assert.equal(result.kind, "adopt-known");
      assert.equal(state.expected?.label, "Account A");
      assert.equal(result.acted, "adopted");
      assert.equal(/signed in by hand/.test(recorder.notes[0]?.text ?? ""), false, recorder.notes[0]?.text);
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});

test("the re-assert's payloads carry labels and keys only (AC7)", async () => {
  await withTempPaseoHome(async () => {
    const wire = await setup();
    try {
      const state = { ...emptySwitchState(), expected: { key: wire.expected, label: "Account B" } };
      const recorder = deps({ staleWriter: true });
      const result = await reassert({ liveTarget: wire.liveTarget, state, deps: recorder.deps, agentId: "a1" });
      const text = JSON.stringify(result) + JSON.stringify(state) + JSON.stringify(recorder.notes);
      for (const forbidden of ["@", "access_token", "refresh_token", "synthetic-access-token", "example.invalid"]) {
        assert.equal(text.includes(forbidden), false, forbidden);
      }
    } finally {
      for (const target of wire.created) await credDelete(target).catch(() => false);
    }
  });
});
