import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHUNK_BYTES, KeyScout, MAX_BUFFER_BYTES, OVERLAP_BYTES, scanFile } from "../server/keyscan.ts";

// S4 / AC8 — the key scan. Everything here is synthetic: the id/secret SHAPES are real (Google's), the values are
// invented, and nothing reads the actual agy binary (that would put real key material in a test log on failure).
//
// The three things this file proves:
//   1. a match that STRADDLES a chunk boundary is found (the reason the carry exists);
//   2. the scan reads the exact path it is given and never a `.old` sibling (R4-11);
//   3. "< 32 MB peak" BY CONSTRUCTION (N2): the chunk constant is ≤ 4 MB, the largest buffer is CHUNK + OVERLAP, and this
//      module has no whole-file read path at all (the source grep below).

const ID = (n: number) => `${200000000000 + n}-${String(n).repeat(28).slice(0, 28)}.apps.googleusercontent.com`;
const SECRET = (n: number) => `GOCSPX-${String(n).repeat(28).slice(0, 28)}`;

/**
 * A buffer of `size` bytes with `needles` written at exact offsets. The padding is NUL, like the inside of a real
 * executable: the id pattern is bounded by ``, and a letter as padding would (correctly) refuse to see a boundary.
 */
function synthetic(size: number, needles: Array<{ at: number; text: string }>): Buffer {
  const buffer = Buffer.alloc(size, 0x00);
  for (const needle of needles) buffer.write(needle.text, needle.at, "latin1");
  return buffer;
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agy-keyscan-"));
}

test("a match straddling a chunk boundary is found, exactly once", async () => {
  const dir = await tempDir();
  try {
    const id = ID(1);
    // The id starts 10 bytes before the first chunk ends, so it is split across the boundary.
    const at = CHUNK_BYTES - 10;
    const file = path.join(dir, "agy.exe");
    await writeFile(file, synthetic(CHUNK_BYTES + 4096, [{ at, text: id }]));
    const keys = await scanFile(file);
    assert.deepEqual(keys.ids, [id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("three ids and three secrets spread across chunks are all found, in order, without duplicates", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "agy.exe");
    const spread = 665 * 1024; // the measured gap between ids and secrets in the real binary
    const needles = [] as Array<{ at: number; text: string }>;
    for (let index = 1; index <= 3; index++) {
      needles.push({ at: 1024 + index * spread, text: ID(index) });
      needles.push({ at: 1024 + index * spread + 2048, text: SECRET(index) });
    }
    // A fourth pair, deliberately straddling the 4 MB boundary. The two are placed apart so writing one cannot clobber
    // the other — an id and a secret overlapping would test nothing but the fixture.
    needles.push({ at: CHUNK_BYTES - 60, text: ID(4) });
    needles.push({ at: CHUNK_BYTES + 200, text: SECRET(4) });
    // Big enough for both the spread needles and the pair that straddles the 4 MB chunk boundary.
    await writeFile(file, synthetic(Math.max(3 * spread + 4096, CHUNK_BYTES + 4096), needles));
    const keys = await scanFile(file);
    assert.deepEqual(keys.ids.sort(), [ID(1), ID(2), ID(3), ID(4)].sort());
    assert.deepEqual(keys.secrets.sort(), [SECRET(1), SECRET(2), SECRET(3), SECRET(4)].sort());
    assert.equal(new Set(keys.ids).size, keys.ids.length, "an id was reported twice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an id is found even when the bytes around it are letters (the real binary's shape)", async () => {
  // Measured on this box: three ids are present in agy.exe and ZERO were found while the pattern required a word boundary
  // — the strings sit inside a blob of other string data, so the byte before an id is usually a letter or a digit. The
  // daemon log ("no app key found") is what caught it; this fixture is what stops it coming back.
  const dir = await tempDir();
  try {
    const file = path.join(dir, "agy.exe");
    const buffer = Buffer.alloc(4096, 0x41); // 'A' — a word character on both sides of the id
    buffer.write(ID(1), 200, "latin1");
    await writeFile(file, buffer);
    const keys = await scanFile(file);
    assert.deepEqual(keys.ids, [ID(1)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the scan reads exactly the path it is given — a `.old` sibling is never opened", async () => {
  const dir = await tempDir();
  try {
    const live = path.join(dir, "agy.exe");
    const old = path.join(dir, "agy.exe.old");
    await writeFile(live, synthetic(2048, [{ at: 100, text: ID(1) }]));
    await writeFile(old, synthetic(2048, [{ at: 100, text: ID(9) }]));
    const keys = await scanFile(live);
    assert.deepEqual(keys.ids, [ID(1)]);
    assert.equal(keys.ids.includes(ID(9)), false, "a stale .old sibling's key was picked up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a binary with no id, or no secret, is reported as such rather than guessed at", async () => {
  const dir = await tempDir();
  try {
    const none = path.join(dir, "none.exe");
    await writeFile(none, synthetic(2048, []));
    assert.deepEqual(await scanFile(none), { ids: [], secrets: [] });
    const idsOnly = path.join(dir, "ids.exe");
    await writeFile(idsOnly, synthetic(2048, [{ at: 10, text: ID(1) }]));
    const keys = await scanFile(idsOnly);
    assert.equal(keys.ids.length, 1);
    assert.equal(keys.secrets.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a re-scan happens only when the executable changes, and says so (R4-11)", async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, "agy.exe");
    await writeFile(file, synthetic(2048, [{ at: 10, text: ID(1) }]));
    const scout = new KeyScout();
    const first = await scout.keys(file);
    assert.deepEqual([first.scanned, first.changed], [true, false]);
    const second = await scout.keys(file);
    assert.deepEqual([second.scanned, second.changed], [false, false]);
    assert.deepEqual(second.ids, [ID(1)]);
    // A new build, in place: different size, so a new scan and `changed` for the pairing layer to drop its pair.
    const before = await stat(file);
    await writeFile(file, synthetic(4096, [{ at: 10, text: ID(2) }]));
    assert.notEqual((await stat(file)).size, before.size);
    const third = await scout.keys(file);
    assert.deepEqual([third.scanned, third.changed], [true, true]);
    assert.deepEqual(third.ids, [ID(2)]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("peak memory is bounded BY CONSTRUCTION: a 4 MB chunk, one carry, and no whole-file read path (N2)", async () => {
  assert.equal(CHUNK_BYTES, 4 * 1024 * 1024);
  assert.equal(OVERLAP_BYTES >= 128, true, "the overlap must cover the longest pattern (~72 bytes)");
  assert.equal(MAX_BUFFER_BYTES, CHUNK_BYTES + OVERLAP_BYTES);
  assert.equal(MAX_BUFFER_BYTES < 32 * 1024 * 1024, true);
  // The module has no whole-file read: only a read stream and a stat.
  const source = await readFile(new URL("../server/keyscan.ts", import.meta.url), "utf8");
  assert.equal(/readFile(Sync)?\s*\(/.test(source), false, "keyscan.ts must not read a whole file");
  assert.match(source, /createReadStream\(binaryPath, \{ highWaterMark: CHUNK_BYTES \}\)/);
});
