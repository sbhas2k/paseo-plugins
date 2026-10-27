import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, test } from "node:test";
import { moveSlot, planSave, parseSlotIndex, type SlotEntry } from "../shared/slots.ts";
import { credDelete } from "../server/cred.ts";
import { accountKey } from "../server/key.ts";
import { indexPath, pluginDataDir, readIndex, reorderSlot, saveSlot } from "../server/store.ts";
import { mkdir } from "node:fs/promises";
import { sweepFixtures, syntheticBlob, testEmail, trackFixture, withTempPaseoHome } from "../testutil/support.ts";

// AC11: swept even when a test throws before its own `finally`.
after(sweepFixtures);

// S3 (owner 2026-10-26): *"1st one. But we should let user move the account up n down. So they can arrange any time as
// needed."* — every saved account carries an explicit position, a new save joins the end, and ▲/▼ rewrites the sequence.
//
// The sequence lives in `index.json`, which is a bare `{key,label,savedAt,lastUsage}[]` written before S3: those files
// have no `order`, and the read assigns one from `savedAt` so an owner upgrading does not lose their arrangement to a
// default.

const entry = (key: string, label: string, order = 0, savedAt = "2026-10-01T00:00:00Z"): SlotEntry => ({
  key,
  label,
  savedAt,
  lastUsage: null,
  order,
});

const labels = (index: readonly SlotEntry[]) => index.map((slot) => slot.label);

test("a new account joins the end of the sequence", () => {
  const index = [entry("k1", "One", 0), entry("k2", "Two", 1)];
  const plan = planSave(JSON.stringify({ id_token_email: "third@example.invalid" }), index, "2026-10-26T12:00:00Z", accountKey);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.entry.order, 2);
});

test("re-saving an account keeps its position", () => {
  const index = [entry("k1", "One", 0), entry("k2", "Two", 1)];
  const plan = planSave(JSON.stringify({ id_token_email: "second@example.invalid" }), index, "2026-10-26T12:00:00Z", (email) =>
    email === "second@example.invalid" ? "k2" : accountKey(email),
  );
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.entry.order, 1);
  assert.equal(plan.entry.label, "Two");
});

test("moving up and down swaps neighbours and renumbers contiguously", () => {
  const index = [entry("k1", "One", 0), entry("k2", "Two", 1), entry("k3", "Three", 2)];
  const up = moveSlot(index, "k3", "up");
  assert.equal(up.moved, true);
  assert.deepEqual(labels(up.index), ["One", "Three", "Two"]);
  assert.deepEqual(up.index.map((slot) => slot.order), [0, 1, 2]);

  const down = moveSlot(index, "k1", "down");
  assert.equal(down.moved, true);
  assert.deepEqual(labels(down.index), ["Two", "One", "Three"]);
});

test("moving at either end does nothing at all", () => {
  const index = [entry("k1", "One", 0), entry("k2", "Two", 1)];
  const top = moveSlot(index, "k1", "up");
  const bottom = moveSlot(index, "k2", "down");
  assert.equal(top.moved, false);
  assert.equal(bottom.moved, false);
  assert.deepEqual(labels(top.index), ["One", "Two"]);
  assert.deepEqual(labels(bottom.index), ["One", "Two"]);
});

test("moving an account that does not exist changes nothing", () => {
  const index = [entry("k1", "One", 0)];
  assert.equal(moveSlot(index, "nope", "down").moved, false);
});

test("an index written before S3 is ordered by savedAt and renumbered on read", () => {
  const legacy = JSON.stringify([
    { key: "k3", label: "Three", savedAt: "2026-10-03T00:00:00Z", lastUsage: null },
    { key: "k1", label: "One", savedAt: "2026-10-01T00:00:00Z", lastUsage: null },
    { key: "k2", label: "Two", savedAt: "2026-10-02T00:00:00Z", lastUsage: null },
  ]);
  assert.deepEqual(labels(parseSlotIndex(legacy)), ["One", "Two", "Three"]);
  assert.deepEqual(parseSlotIndex(legacy).map((slot) => slot.order), [0, 1, 2]);
});

test("a stored order that is out of range or duplicated is normalised, not obeyed", () => {
  const text = JSON.stringify([
    { key: "k1", label: "One", savedAt: "2026-10-01T00:00:00Z", order: 9 },
    { key: "k2", label: "Two", savedAt: "2026-10-02T00:00:00Z", order: 9 },
    { key: "k3", label: "Three", savedAt: "2026-10-03T00:00:00Z", order: -1 },
  ]);
  const parsed = parseSlotIndex(text);
  assert.deepEqual(parsed.map((slot) => slot.order), [0, 1, 2]);
  assert.deepEqual(labels(parsed), ["One", "Two", "Three"]);
});

test("a reorder survives the disk and takes effect for the next switch", async () => {
  await withTempPaseoHome(async () => {
    const emails = [testEmail("order-a"), testEmail("order-b"), testEmail("order-c")];
    const keys = emails.map(accountKey);
    const created = keys.map((key) => `paseo-agy-accounts:${key}`);
    try {
      for (const [position, email] of emails.entries()) {
        await saveSlot(syntheticBlob(email));
        await reorderSlot(keys[position], "down"); // no-op on the last one, harmless
      }
      // Three slots, appended in order: positions 0,1,2.
      assert.deepEqual((await readIndex()).map((slot) => slot.key), keys);

      // ▲ on the third: it becomes second, and the file says so.
      const moved = await reorderSlot(keys[2], "up");
      assert.equal(moved.moved, true);
      assert.deepEqual((await readIndex()).map((slot) => slot.key), [keys[0], keys[2], keys[1]]);
      assert.deepEqual((await readIndex()).map((slot) => slot.order), [0, 1, 2]);

      // The reverse direction is the same file, read back.
      await reorderSlot(keys[2], "up");
      assert.deepEqual((await readIndex()).map((slot) => slot.key), [keys[2], keys[0], keys[1]]);
      // ... and at the top it stops.
      assert.equal((await reorderSlot(keys[2], "up")).moved, false);
      assert.deepEqual((await readIndex()).map((slot) => slot.key), [keys[2], keys[0], keys[1]]);
    } finally {
      for (const target of created) await credDelete(target).catch(() => false);
    }
  });
});

test("a hand-written index with no order is read in savedAt order by the store too", async () => {
  await withTempPaseoHome(async () => {
    await mkdir(pluginDataDir(), { recursive: true });
    await writeFile(
      indexPath(),
      JSON.stringify([
        { key: "kb", label: "B", savedAt: "2026-10-02T00:00:00Z", lastUsage: null },
        { key: "ka", label: "A", savedAt: "2026-10-01T00:00:00Z", lastUsage: null },
      ]),
      "utf8",
    );
    const index = await readIndex();
    assert.deepEqual(labels(index), ["A", "B"]);
    assert.deepEqual(index.map((slot) => slot.order), [0, 1]);
  });
});
