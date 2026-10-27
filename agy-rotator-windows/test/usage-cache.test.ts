import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgyCensus } from "../shared/census.ts";
import { UsageCache, type UsageSnapshot } from "../server/usage-cache.ts";

// S2 — the two pieces of plumbing the usage source and the tick sit on: the `agy.exe` census parser, and the 120 s
// `/usage` cache (plan §3.2, R2-6). Paseo calls `fetch` on its own cadence; the cache is what stops that cadence from
// spawning a 10-second `agy` process, so its behaviour is a gate, not a convenience.

const ok = (at: number): UsageSnapshot => ({
  at,
  kind: "ok",
  reading: { gemini5h: { remaining: 0.5, resetsAt: null }, geminiWeekly: null, threep5h: null, threepWeekly: null },
});

/** A reader that counts and lets the test choose what it answers. */
function fakeReader() {
  const calls: number[] = [];
  let answer: () => Promise<UsageSnapshot> = async () => ok(0);
  return {
    calls,
    set(fn: () => Promise<UsageSnapshot>) {
      answer = fn;
    },
    read: async () => {
      calls.push(calls.length);
      return answer();
    },
  };
}

test("the census parses an array, a single object, and refuses anything else", () => {
  assert.deepEqual(parseAgyCensus(JSON.stringify([{ ProcessId: 10, CreationDate: "2026-10-26T12:00:00Z", ParentName: "WindowsTerminal" }])), [
    { pid: 10, creationDate: "2026-10-26T12:00:00Z", parentName: "WindowsTerminal" },
  ]);
  assert.deepEqual(parseAgyCensus(JSON.stringify({ ProcessId: 11, CreationDate: "2026-10-26T12:00:00Z", ParentName: null })), [
    { pid: 11, creationDate: "2026-10-26T12:00:00Z", parentName: null },
  ]);
  assert.deepEqual(parseAgyCensus(""), []);
  assert.deepEqual(parseAgyCensus("not json"), []);
  assert.deepEqual(parseAgyCensus(JSON.stringify([{ CreationDate: "x" }, null, 5])), []);
});

test("a fresh reading is reused inside the TTL", async () => {
  const reader = fakeReader();
  let clock = 1_000;
  const cache = new UsageCache(reader.read, 120_000, () => clock);
  const first = await cache.get();
  clock += 60_000;
  const second = await cache.get();
  assert.equal(reader.calls.length, 1);
  assert.equal(first, second);
});

test("a stale reading is read again", async () => {
  const reader = fakeReader();
  let clock = 0;
  const cache = new UsageCache(reader.read, 120_000, () => clock);
  await cache.get();
  clock += 121_000;
  await cache.get();
  assert.equal(reader.calls.length, 2);
});

test("refresh reads again even inside the TTL", async () => {
  const reader = fakeReader();
  const cache = new UsageCache(reader.read, 120_000, () => 5);
  await cache.get();
  await cache.get({ refresh: true });
  assert.equal(reader.calls.length, 2);
});

test("concurrent callers join one read instead of spawning two agy processes", async () => {
  const reader = fakeReader();
  let release: (snapshot: UsageSnapshot) => void = () => {};
  reader.set(() => new Promise<UsageSnapshot>((resolve) => (release = resolve)));
  const cache = new UsageCache(reader.read, 120_000, () => 0);
  const a = cache.get();
  const b = cache.get();
  const c = cache.get({ refresh: true });
  release(ok(7));
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(reader.calls.length, 1);
  assert.deepEqual([ra.at, rb.at, rc.at], [7, 7, 7]);
});

test("peek answers the last reading and never reads", async () => {
  const reader = fakeReader();
  const cache = new UsageCache(reader.read, 120_000, () => 0);
  assert.equal(cache.peek(), null);
  await cache.get();
  assert.equal(cache.peek()?.kind, "ok");
  assert.equal(reader.calls.length, 1);
});

test("joinInFlight answers the running read and never starts one (Paseo's cadence must not spawn /usage)", async () => {
  const reader = fakeReader();
  let release: (snapshot: UsageSnapshot) => void = () => {};
  reader.set(() => new Promise<UsageSnapshot>((resolve) => (release = resolve)));
  const cache = new UsageCache(reader.read, 120_000, () => 0);
  // Nothing running, nothing cached: no spawn.
  assert.equal(await cache.joinInFlight(), null);
  assert.equal(reader.calls.length, 0);
  const running = cache.get();
  const joined = cache.joinInFlight();
  release(ok(9));
  await running;
  assert.equal((await joined)?.at, 9);
  assert.equal(reader.calls.length, 1);
});

test("a failure is not cached for the full TTL, so a signed-out CLI is retried soon", async () => {
  const reader = fakeReader();
  let clock = 0;
  const cache = new UsageCache(reader.read, 120_000, () => clock, 15_000);
  reader.set(async () => ({ at: clock, kind: "signed-out", reading: null }));
  await cache.get();
  clock += 10_000;
  await cache.get();
  assert.equal(reader.calls.length, 1);
  clock += 10_000;
  await cache.get();
  assert.equal(reader.calls.length, 2);
});

test("a reader that throws becomes an error reading, not a broken tick", async () => {
  const reader = fakeReader();
  reader.set(async () => {
    throw new Error("spawn agy ENOENT");
  });
  const cache = new UsageCache(reader.read, 120_000, () => 0);
  const snapshot = await cache.get();
  assert.equal(snapshot.kind, "error");
  assert.match(snapshot.message ?? "", /ENOENT/);
});

test("the cache reports every reading with its own timestamp", async () => {
  const reader = fakeReader();
  let clock = 100;
  const cache = new UsageCache(reader.read, 120_000, () => clock);
  reader.set(async () => ok(clock));
  const first = await cache.get();
  clock = 200;
  const second = await cache.get({ refresh: true });
  assert.deepEqual([first.at, second.at], [100, 200]);
});
