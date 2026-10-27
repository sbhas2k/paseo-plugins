import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { LIVE_TARGET, liveReadable, slotWritable } from "../shared/targets.ts";
import { credDelete, credMeta, credRead, credWrite, writeLive } from "../server/cred.ts";
import { sweepFixtures } from "../testutil/support.ts";

// S2 — the live entry's guardrails, and the metadata probe the gate and S3 both need.
//
// S1 refused `gemini:antigravity` outright. S2 lifts that refusal for exactly two things: READING it (save current,
// re-assert check) and WRITING it from the switch/re-assert path only (`writeLive`). It is never deleted — `agy`'s own
// `/logout` is the only thing that deletes it, and a plugin delete would sign the owner out.
//
// The tests below never touch the real entry: they assert what the GUARDS permit (pure) and exercise the helper on
// throwaway `paseo-agy-accounts:test-*` targets.

const synthetic = (size = 40) => Buffer.from(JSON.stringify({ note: "synthetic", pad: "x".repeat(size) }), "utf8");

test("the live entry is readable, a slot is readable, and nothing else is", () => {
  assert.equal(liveReadable(LIVE_TARGET), true);
  assert.equal(liveReadable("paseo-agy-accounts:0123456789abcdef"), true);
  assert.equal(liveReadable("someone-else"), false);
  assert.equal(liveReadable("gemini:other"), false);
});

test("only slot targets are writable through the ordinary path; the live entry needs writeLive", () => {
  assert.equal(slotWritable("paseo-agy-accounts:0123456789abcdef"), true);
  assert.equal(slotWritable(LIVE_TARGET), false);
  assert.equal(slotWritable("paseo-agy-accounts:"), false);
  assert.equal(slotWritable("gemini:antigravity.slot.x"), false);
});

test("writeLive accepts the live target and a slot-shaped stand-in, and nothing else", async () => {
  const bad = ["someone-else", "gemini:antigravity.slot.x", ""];
  for (const target of bad) await assert.rejects(() => writeLive(target, synthetic()), /Refusing/, target);
});

test("the ordinary write and delete still refuse the live entry", async () => {
  await assert.rejects(() => credWrite(LIVE_TARGET, synthetic()), /Refusing/);
  await assert.rejects(() => credDelete(LIVE_TARGET), /Refusing/);
});

test("metadata is read without the blob: type, persist, user, LastWritten, size", async () => {
  const target = `paseo-agy-accounts:test-meta-${randomBytes(6).toString("hex")}`;
  const blob = synthetic(120);
  try {
    assert.equal(await credMeta(target), null);
    await credWrite(target, blob);
    const meta = await credMeta(target);
    assert.notEqual(meta, null);
    assert.equal(meta?.type, 1);
    assert.equal(meta?.persist, 2);
    assert.equal(meta?.user, "antigravity");
    // The Comment is how "who wrote this entry" is provable from metadata alone: this plugin stamps its own, so an
    // empty Comment on `gemini:antigravity` is `agy`'s own token refresh (plan F7) rather than a plugin write.
    assert.equal(meta?.comment, "paseo-agy-accounts slot");
    assert.equal(meta?.size, blob.length);
    assert.match(String(meta?.lastWritten), /^\d{4}-\d{2}-\d{2}T/);
    // A write through writeLive lands as the same shape — this is the path a switch takes.
    const liveish = `paseo-agy-accounts:test-live-${randomBytes(6).toString("hex")}`;
    try {
      await writeLive(liveish, blob);
      assert.equal((await credMeta(liveish))?.size, blob.length);
      assert.deepEqual(await credRead(liveish), blob);
    } finally {
      await credDelete(liveish).catch(() => false);
    }
  } finally {
    await credDelete(target).catch(() => false);
  }
  assert.equal(await credMeta(target), null);
});

// AC11: the file-level sweep, so a throwing test cannot leave a target behind.
after(sweepFixtures);
