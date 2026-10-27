import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashAccountKey } from "@getpaseo/plugin/server/usage";
import { accountKey } from "../server/key.ts";
import {
  SLOT_PREFIX,
  parseSlotIndex,
  planSave,
  readBlobEmail,
  removeSlotEntry,
  slotTarget,
  upsertSlot,
  type SlotEntry,
} from "../shared/slots.ts";

// AC4 — a save is keyed by the blob's OWN `id_token_email`, so an unknown account becomes `unsaved-<key[:6]>` and
// never overwrites another slot's label. Plus the one key function (challenger T4): `hashAccountKey(email).slice(0,16)`,
// which is sha256-hex — pinned here so a change of hash can never silently move every saved slot.

const NOW = "2026-10-26T14:00:00Z";

/** A blob shaped like the one `agy` writes (F2): a token block, an auth method, and the email it belongs to. */
function blob(email: string | null, token = "tok-1"): string {
  return JSON.stringify({
    token: { access_token: `a-${token}`, token_type: "Bearer", refresh_token: `r-${token}`, expiry: "2026-10-26T18:00:00Z" },
    auth_method: "oauth",
    ...(email === null ? {} : { id_token_email: email }),
  });
}

const entry = (key: string, label: string, lastUsage: SlotEntry["lastUsage"] = null, order = 0): SlotEntry => ({
  key,
  label,
  savedAt: "2026-10-01T00:00:00Z",
  lastUsage,
  order,
});

// --- the one key function ---
test("accountKey is sha256 hex truncated to 16, identical to the SDK's hashAccountKey", () => {
  const email = "owner.two@example.com";
  const expected = createHash("sha256").update(email).digest("hex").slice(0, 16);
  assert.equal(accountKey(email), expected);
  assert.equal(accountKey(email), hashAccountKey(email).slice(0, 16));
  assert.match(accountKey(email), /^[0-9a-f]{16}$/);
});

test("one email always gives one key; two emails give two", () => {
  assert.equal(accountKey("a@example.com"), accountKey("a@example.com"));
  assert.notEqual(accountKey("a@example.com"), accountKey("b@example.com"));
});

// --- the slot target is outside the swept `gemini:` prefix (R2-1) ---
test("a slot target sits under paseo-agy-accounts: and never under gemini:", () => {
  const target = slotTarget(accountKey("a@example.com"));
  assert.equal(target, `${SLOT_PREFIX}${accountKey("a@example.com")}`);
  assert.match(target, /^paseo-agy-accounts:[0-9a-f]{16}$/);
  assert.equal(target.startsWith("gemini:"), false);
});

test("a key that could escape the namespace is refused", () => {
  for (const key of ["", "a:b", "../x", "A@B", "x".repeat(65)]) {
    assert.throws(() => slotTarget(key), /Refusing/, JSON.stringify(key));
  }
});

// --- reading the blob's own identity ---
test("readBlobEmail reads id_token_email from the blob and nothing else", () => {
  assert.equal(readBlobEmail(blob("Owner@Example.com")), "Owner@Example.com");
});

test("a blob with no usable email answers null instead of guessing", () => {
  for (const text of [blob(null), "", "not json", "[]", JSON.stringify({ id_token_email: 42 }), JSON.stringify({ id_token_email: "  " })]) {
    assert.equal(readBlobEmail(text), null, JSON.stringify(text));
  }
});

// --- AC4: an unknown account is adopted as unsaved-, a known one keeps its label ---
test("an unknown account's blob saves as unsaved-<key[:6]>", () => {
  const email = "new.account@example.com";
  const key = accountKey(email);
  const plan = planSave(blob(email), [], NOW, accountKey);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual([plan.entry.key, plan.entry.label, plan.isNew], [key, `unsaved-${key.slice(0, 6)}`, true]);
  assert.equal(plan.target, `paseo-agy-accounts:${key}`);
});

test("a known account keeps its owner-given label and its last reading", () => {
  const email = "alpha@example.com";
  const key = accountKey(email);
  const reading = { gemini5h: { remaining: 0.5, resetsAt: null }, geminiWeekly: null, threep5h: null, threepWeekly: null };
  const existing = entry(key, "Work account", { at: "2026-10-26T13:00:00Z", reading });
  const plan = planSave(blob(email), [existing], NOW, accountKey);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual([plan.entry.label, plan.isNew, plan.entry.savedAt], ["Work account", false, NOW]);
  assert.deepEqual(plan.entry.lastUsage, { at: "2026-10-26T13:00:00Z", reading });
});

test("saving an unknown account never overwrites an existing slot", () => {
  const alpha = accountKey("alpha@example.com");
  const beta = accountKey("beta@example.com");
  const index = upsertSlot([], entry(alpha, "Alpha"));
  const plan = planSave(blob("beta@example.com"), index, NOW, accountKey);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const merged = upsertSlot(index, plan.entry);
  assert.deepEqual(merged.map((e) => e.key), [alpha, beta]);
  assert.equal(merged[0].label, "Alpha");
  assert.equal(merged[0].savedAt, "2026-10-01T00:00:00Z");
});

test("a re-save of a slot does not duplicate its index entry", () => {
  const email = "alpha@example.com";
  const key = accountKey(email);
  const once = planSave(blob(email, "tok-1"), [], NOW, accountKey);
  assert.equal(once.ok, true);
  if (!once.ok) return;
  const twice = planSave(blob(email, "tok-2"), [once.entry], "2026-10-26T15:00:00Z", accountKey);
  assert.equal(twice.ok, true);
  if (!twice.ok) return;
  const merged = upsertSlot([once.entry], twice.entry);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].savedAt, "2026-10-26T15:00:00Z");
  assert.equal(merged[0].label, once.entry.label);
});

test("the index entry carries no email and no token material (AC3's on-disk half)", () => {
  const plan = planSave(blob("secret.person@example.com"), [], NOW, accountKey);
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  const text = JSON.stringify(upsertSlot([], plan.entry));
  for (const forbidden of ["@", "access_token", "refresh_token", "Bearer", "secret.person"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test("removing a slot leaves the other entries as they were", () => {
  const alpha = accountKey("alpha@example.com");
  const beta = accountKey("beta@example.com");
  const index = [entry(alpha, "Alpha"), entry(beta, "Beta")];
  assert.deepEqual(removeSlotEntry(index, alpha).map((e) => e.key), [beta]);
  assert.deepEqual(removeSlotEntry(index, accountKey("nobody@example.com")), index);
});

// Supporting code, written after `parseSlotIndex` (not an AC gate): a corrupt index must never stop the daemon, and a
// single bad line must not take the good ones with it.
test("a missing, corrupt or non-array index reads as empty", () => {
  for (const text of ["", "   ", "not json", "{}", "[]", JSON.stringify({ slots: "nope" })]) {
    assert.deepEqual(parseSlotIndex(text), [], JSON.stringify(text));
  }
});

test("one bad index line is dropped and the good lines survive", () => {
  const good = entry(accountKey("alpha@example.com"), "Alpha");
  const text = JSON.stringify([good, { key: "NOT A KEY", label: "x", savedAt: "x" }, { key: "abc", label: "  ", savedAt: "x" }, 42, null]);
  const parsed = parseSlotIndex(text);
  assert.deepEqual(parsed, [good]);
});

test("a lastUsage of the wrong shape is dropped, not carried", () => {
  const key = accountKey("alpha@example.com");
  const text = JSON.stringify([{ key, label: "Alpha", savedAt: NOW, lastUsage: { at: 5 } }]);
  assert.deepEqual(parseSlotIndex(text), [{ key, label: "Alpha", savedAt: NOW, lastUsage: null, order: 0 }]);
});
