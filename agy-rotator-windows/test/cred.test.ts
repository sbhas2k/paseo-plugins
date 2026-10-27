import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CredentialNotFound, credDelete, credRead, credWrite, helperArgs } from "../server/cred.ts";
import { accountKey } from "../server/key.ts";
import { indexPath, loadSlot, pluginDataDir, readIndex, removeSlot, saveSlot } from "../server/store.ts";

// AC3 — the vault round-trip THROUGH THE REAL `powershell.exe` HELPER, with a SYNTHETIC blob: never the live
// `gemini:antigravity` entry, never a real token, never a real email. Target names live under
// `paseo-agy-accounts:test-…` (R2-7) and are deleted afterwards.
//
// The blob is exactly 560 bytes — the size `agy` itself writes (F1) — JSON-shaped, one non-ASCII byte, no trailing
// newline. Byte-exactness is the whole point: PowerShell 5.1 re-encodes text on its pipes (challenger F9), which is
// why the helper carries the blob as base64 on stdin/stdout and decodes raw bytes in Node.

/** A 560-byte synthetic blob, JSON-shaped, one non-ASCII character, no trailing newline. */
function syntheticBlob(email: string): Buffer {
  const build = (padding: number): string =>
    JSON.stringify({
      token: {
        access_token: "synthetic-access-token",
        token_type: "Bearer",
        refresh_token: "synthetic-refresh-token",
        expiry: "2026-10-26T18:13:01Z",
        expires_in: 3599,
      },
      auth_method: "synthetic",
      id_token_email: email,
      note: `é${"x".repeat(padding)}`,
    });
  let padding = 0;
  while (Buffer.byteLength(build(padding), "utf8") < 560) padding++;
  const text = build(padding);
  assert.equal(Buffer.byteLength(text, "utf8"), 560);
  assert.equal(text.endsWith("\n"), false);
  assert.match(text, /[^\x00-\x7f]/u);
  return Buffer.from(text, "utf8");
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("the helper's argv carries no blob, no email and never runs a profile", () => {
  const args = helperArgs();
  const blob = syntheticBlob("argv-check@example.invalid");
  assert.equal(args[0], "-NoProfile");
  assert.equal(args[1], "-NonInteractive");
  assert.equal(args[2], "-EncodedCommand");
  assert.equal(args.length, 4);
  const joined = args.join(" ");
  for (const secret of [blob.toString("base64"), blob.toString("base64").slice(0, 40), "argv-check@example.invalid", "synthetic-refresh-token"]) {
    assert.equal(joined.includes(secret), false, secret);
  }
});

test("a synthetic blob survives write -> read byte-identically, then deletes", async () => {
  const target = `paseo-agy-accounts:test-${randomBytes(6).toString("hex")}`;
  const blob = syntheticBlob(`round-trip-${randomBytes(4).toString("hex")}@example.invalid`);
  try {
    await credWrite(target, blob);
    const back = await credRead(target);
    assert.notEqual(back, null);
    assert.equal(back?.length, 560);
    assert.equal(sha256(back as Buffer), sha256(blob));
    assert.deepEqual(back, blob);
  } finally {
    await credDelete(target).catch(() => false);
  }
  // Deleted for real: the next read is "not found", not a stale 560 bytes in Credential Manager.
  assert.equal(await credRead(target), null);
  assert.equal(await credDelete(target), false);
});

test("the helper refuses to touch anything outside the slot prefix (the live entry is S1's hard limit)", async () => {
  await assert.rejects(() => credWrite("gemini:antigravity", syntheticBlob("never@example.invalid")), /Refusing/);
  await assert.rejects(() => credDelete("gemini:antigravity"), /Refusing/);
  await assert.rejects(() => credWrite("someone-elses-target", Buffer.from("x")), /Refusing/);
});

test("reading a target that does not exist is null (an owner's /logout is a state, not a crash)", async () => {
  const target = `paseo-agy-accounts:test-missing-${randomBytes(6).toString("hex")}`;
  assert.equal(await credRead(target), null);
});

test("a slot round-trips through the store, and index.json carries no secret", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-rotator-windows-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const email = `store-${randomBytes(4).toString("hex")}@example.invalid`;
  const blob = syntheticBlob(email);
  // Derived up front, so the cleanup in `finally` can run even if `saveSlot` throws half-way (a failed first run
  // otherwise left one throwaway credential behind).
  const key = accountKey(email);
  try {
    const saved = await saveSlot(blob);
    assert.equal(saved.key, key);
    assert.equal(saved.isNew, true);
    assert.equal(saved.entry.label, `unsaved-${saved.key.slice(0, 6)}`);
    assert.equal(pluginDataDir(), path.join(home, "plugin-data", "agy-rotator-windows"));

    // The whole plugin-data directory, as bytes: no email, no token field, no blob.
    const dir = pluginDataDir();
    for (const name of await readdir(dir)) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const forbidden of ["@", "access_token", "refresh_token", "synthetic-access-token", email]) {
        assert.equal(text.includes(forbidden), false, `${name} contains ${forbidden}`);
      }
    }
    assert.equal(path.basename(indexPath()), "index.json");
    assert.deepEqual((await readIndex()).map((entry) => entry.key), [saved.key]);

    const back = await loadSlot(saved.key);
    assert.notEqual(back, null);
    assert.equal(sha256(back as Buffer), sha256(blob));

    assert.equal(await removeSlot(saved.key), true);
    assert.deepEqual(await readIndex(), []);
    assert.equal(await credRead(`paseo-agy-accounts:${saved.key}`), null);
    // A second removal is a no-op, not an error.
    assert.equal(await removeSlot(saved.key), false);
  } finally {
    await credDelete(`paseo-agy-accounts:${key}`).catch(() => false);
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("a blob with no email is refused by the store, and writes nothing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-rotator-windows-nokey-"));
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    const blob = Buffer.from(JSON.stringify({ token: { access_token: "x" }, auth_method: "synthetic" }), "utf8");
    await assert.rejects(() => saveSlot(blob), /id_token_email/);
    assert.deepEqual(await readIndex(), []);
  } finally {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("CredentialNotFound is what a switch steps over", () => {
  assert.equal(new CredentialNotFound("x") instanceof Error, true);
});
