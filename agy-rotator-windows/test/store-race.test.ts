import assert from "node:assert/strict";
import { after, test } from "node:test";
import { credDelete } from "../server/cred.ts";
import { accountKey } from "../server/key.ts";
import { readIndex, reorderSlot, renameSlot, saveSlot, setSlotUsage } from "../server/store.ts";
import { sweepFixtures, syntheticBlob, testEmail, trackFixture, withTempPaseoHome } from "../testutil/support.ts";

// AC11: swept even when a test throws before its own `finally`.
after(sweepFixtures);

// F-03 (Gemini review, 9da9e943): every slot writer does read-modify-write on `index.json` (read, change one entry,
// rewrite the whole file). Two of them interleaving lose one update: both read the same file, both write, the last writer
// wins — an account saved while a reorder was in flight simply vanishes from the index (its credential stays, orphaned).
//
// The writers now go through one promise queue in `server/store.ts`. These tests fire them concurrently and demand that
// every update survives: with the queue gone, the index would keep only the last writer's view.

const keysOf = async () => (await readIndex()).map((entry) => entry.key);

test("six concurrent saves all survive: no update is lost to a racing read-modify-write", async () => {
  await withTempPaseoHome(async () => {
    const emails = Array.from({ length: 6 }, (_, index) => testEmail(`race-save-${index}`));
    const keys = emails.map(accountKey);
    try {
      await Promise.all(emails.map((email) => saveSlot(syntheticBlob(email))));
      assert.deepEqual((await keysOf()).sort(), [...keys].sort());
    } finally {
      for (const key of keys) await credDelete(`paseo-agy-accounts:${key}`).catch(() => false);
    }
  });
});

test("a reorder racing a save keeps both: the move and the new account", async () => {
  await withTempPaseoHome(async () => {
    const emailA = testEmail("race-a");
    const emailB = testEmail("race-b");
    const emailC = testEmail("race-c");
    const keyA = accountKey(emailA);
    const keyB = accountKey(emailB);
    const keyC = accountKey(emailC);
    try {
      await saveSlot(syntheticBlob(emailA));
      await saveSlot(syntheticBlob(emailB));
      // A moved down (so B is first) while C is being saved.
      await Promise.all([reorderSlot(keyA, "down"), saveSlot(syntheticBlob(emailC))]);
      const index = await readIndex();
      const order = index.map((entry) => entry.key);
      assert.equal(order.includes(keyC), true, `the concurrent save was lost: ${JSON.stringify(order)}`);
      assert.equal(order.indexOf(keyB) < order.indexOf(keyA), true, `the reorder was lost: ${JSON.stringify(order)}`);
    } finally {
      for (const key of [keyA, keyB, keyC]) await credDelete(`paseo-agy-accounts:${key}`).catch(() => false);
    }
  });
});

test("a rename and a reading write to the same slot both land", async () => {
  await withTempPaseoHome(async () => {
    const email = testEmail("race-rename");
    const key = accountKey(email);
    try {
      await saveSlot(syntheticBlob(email));
      const reading = { at: "2026-10-26T14:00:00Z", reading: { gemini5h: { remaining: 0.5, resetsAt: null }, geminiWeekly: null, threep5h: null, threepWeekly: null } };
      await Promise.all([renameSlot(key, "Renamed"), setSlotUsage(key, reading)]);
      const entry = (await readIndex()).find((candidate) => candidate.key === key);
      assert.equal(entry?.label, "Renamed");
      assert.deepEqual(entry?.lastUsage?.reading, reading.reading);
      assert.equal(entry?.lastUsage?.at, reading.at);
      // A `/usage` write never touches the live-poll half.
      assert.equal(entry?.lastUsage?.polled, null);
    } finally {
      await credDelete(`paseo-agy-accounts:${key}`).catch(() => false);
    }
  });
});

test("a failing writer does not wedge the queue for the next one", async () => {
  await withTempPaseoHome(async () => {
    const email = testEmail("race-fail");
    const key = accountKey(email);
    let secondKey: string | null = null;
    try {
      await saveSlot(syntheticBlob(email));
      // Renaming a slot that does not exist throws; the next save must still work.
      await assert.rejects(() => renameSlot(accountKey(testEmail("race-missing")), "Nope"));
      const second = testEmail("race-after");
      secondKey = accountKey(second);
      await saveSlot(syntheticBlob(second));
      assert.deepEqual((await keysOf()).sort(), [key, secondKey].sort());
    } finally {
      for (const k of [key, secondKey]) if (k !== null) await credDelete(`paseo-agy-accounts:${k}`).catch(() => false);
    }
  });
});
