import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { credDelete, credWrite } from "../server/cred.ts";
import { fixtureCensus, sweepFixtures, trackFixture } from "../testutil/support.ts";

// AC11 regression (2026-10-27): after the owner's first Clean up removed 7 orphans, the daemon removed ONE more — a fixture
// a test run had left behind. The cause is structural, not a forgotten line: cleanup lived in each test's `finally`, which
// does not run when the test throws before reaching it (or when the run is killed).
//
// Fix: every credential fixture is registered by EXACT NAME before it is written, and each test file sweeps at the end.
// These tests prove the sweep on the two shapes that matter — a throwing test, and a target it was never told about.

const run = promisify(execFile);

test("a test that throws right after writing its fixtures leaves zero targets behind", async () => {
  const before = await fixtureCensus();
  const child = path.join(process.cwd(), "testutil", "throw-fixture.ts");
  // A nested `node --test` inherits NODE_TEST_CONTEXT from THIS runner and then reports without setting an exit code, so
  // the child "passes" no matter what happened in it. Stripped, it behaves like any other test run.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // The child MUST fail: a passing child would make the census comparison below prove nothing.
  const failure = await run(process.execPath, ["--test", child], { cwd: process.cwd(), env }).then(
    () => null,
    (error: unknown) => error as { code?: number; stdout?: string },
  );
  assert.notEqual(failure, null, "the throw-fixture child did not fail, so this test would pass vacuously");
  assert.equal(failure?.code, 1);
  assert.match(String(failure?.stdout ?? ""), /deliberate: a test that dies/);
  const afterRun = await fixtureCensus();
  assert.deepEqual(afterRun.sort(), before.sort(), "the throwing run left a paseo-agy-accounts:* target behind");
});

test("the sweep deletes what this run registered, and nothing it was not told about", async () => {
  const tracked = `paseo-agy-accounts:test-swept-${randomBytes(4).toString("hex")}`;
  const untracked = `paseo-agy-accounts:${randomBytes(8).toString("hex").padEnd(16, "0").slice(0, 16)}`;
  trackFixture(tracked);
  await credWrite(tracked, Buffer.from("synthetic"));
  // A hex16 target the registry never heard of: this is what a real account card's slot looks like, and it must survive.
  await credWrite(untracked, Buffer.from("synthetic"));
  try {
    await sweepFixtures();
    const left = await fixtureCensus();
    assert.equal(left.includes(tracked), false, "a registered fixture was not swept");
    assert.equal(left.includes(untracked), true, "the sweep deleted a target it was never told about - that could be a real slot");
  } finally {
    await credDelete(untracked).catch(() => false);
  }
});

test("a stray test- target is swept even when nothing registered it", async () => {
  const stray = `paseo-agy-accounts:test-stray-${randomBytes(4).toString("hex")}`;
  await credWrite(stray, Buffer.from("synthetic"));
  await sweepFixtures();
  assert.equal((await fixtureCensus()).includes(stray), false);
});

after(sweepFixtures);
