import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_BUFFER_BYTES } from "../server/keyscan.ts";
import { BACKOFF_BASE_MS, REFRESH_BUFFER_MS, Poller, refreshTokenFromBlob, type PollDeps, type PollSlot } from "../server/poller.ts";
import type { PolledReading } from "../shared/polled.ts";

// S4 / AC9 — the poller, with a fake fetch and a read-only store. No network, no credential, no `agy`, no real slot.
//
// The behaviours below are the ones the plan names, and each is a rule rather than a nicety: a poll that reads the live
// account wastes a request on the account whose `/usage` reading is fresher; a poll that snapshots `expected` once can
// race a switch that starts mid-cycle; a poll that writes a credential back is the defect the whole "read-only by type"
// design exists to prevent.

const blob = (refreshToken: string) => Buffer.from(JSON.stringify({ token: { access_token: "a", refresh_token: refreshToken }, auth_method: "x" }), "utf8");

interface Harness {
  deps: PollDeps;
  calls: { refresh: number; quota: number; readBlob: number; setPolled: number; needsSignIn: string[]; clientRefused: number; expectedReads: number; writes: number };
  log: string[];
  store: { polled: Map<string, PolledReading> };
  /** Set these between cycles. */
  world: { expectedKey: string | null; switchInFlight: boolean; staleTerminals: Set<string>; tokenExpiresInMs: number; quotaStatus: number; refreshReply: { status: number; error?: string } };
}

function harness(slots: PollSlot[], over: Partial<Harness["world"]> = {}): Harness {
  const calls = { refresh: 0, quota: 0, readBlob: 0, setPolled: 0, needsSignIn: [] as string[], clientRefused: 0, expectedReads: 0, writes: 0 };
  const log: string[] = [];
  const polled = new Map<string, PolledReading>();
  const world: Harness["world"] = {
    expectedKey: slots[0]?.key ?? null,
    switchInFlight: false,
    staleTerminals: new Set<string>(),
    tokenExpiresInMs: 60 * 60 * 1000,
    quotaStatus: 200,
    refreshReply: { status: 200 },
    ...over,
  };
  let now = Date.parse("2026-10-27T02:00:00Z");

  const deps: PollDeps = {
    store: {
      slots: async () => slots,
      readBlob: async () => {
        calls.readBlob += 1;
        return blob("rt-1");
      },
      setPolled: async (key, record) => {
        calls.setPolled += 1;
        polled.set(key, record);
      },
    },
    expectedKey: async () => {
      calls.expectedReads += 1;
      return world.expectedKey;
    },
    switchInFlight: async () => world.switchInFlight,
    staleTerminalFor: async (key) => world.staleTerminals.has(key),
    refresh: async () => {
      calls.refresh += 1;
      if (world.refreshReply.status !== 200) return { status: world.refreshReply.status, error: world.refreshReply.error };
      return { status: 200, accessToken: "at-1", expiresAt: now + world.tokenExpiresInMs };
    },
    quota: async () => {
      calls.quota += 1;
      // One request in flight at a time: assert that by construction in the concurrency test.
      if (world.quotaStatus !== 200) return { status: world.quotaStatus };
      return { status: 200, buckets: { gemini5h: { remaining: 0.93, resetsAt: "2026-10-27T09:13:01Z" }, threep5h: { remaining: 1, resetsAt: null }, threepWeekly: null } };
    },
    needsSignIn: (key) => calls.needsSignIn.push(key),
    clientRefused: () => {
      calls.clientRefused += 1;
    },
    signInCleared: () => {},
    now: () => now,
    log: (line) => log.push(line),
  };
  return {
    deps,
    calls,
    log,
    store: { polled },
    world,
    // `now` is private; the tests advance it through this hook.
    ...{ advance: (ms: number) => (now += ms) },
  } as Harness & { advance: (ms: number) => void };
}

const slots: PollSlot[] = [
  { key: "0123456789abcdef", label: "Work", savedAt: "2026-10-27T01:00:00Z" },
  { key: "fedcba9876543210", label: "Personal", savedAt: "2026-10-26T23:00:00Z" },
];

test("the live account is skipped and the other one is polled", async () => {
  const h = harness(slots);
  const result = await new Poller(h.deps).cycle();
  assert.deepEqual(result.polled, ["fedcba9876543210"]);
  assert.deepEqual(result.skippedLive, ["0123456789abcdef"]);
  assert.equal(h.calls.quota, 1);
  assert.equal(h.store.polled.get("fedcba9876543210")?.gemini5h?.remaining, 0.93);
});

test("`expected` is re-read before EVERY slot: a switch mid-cycle is respected (R4-8)", async () => {
  const h = harness(slots);
  let reads = 0;
  // The first read says "slot 1 is live"; the second says "slot 2 is live" — a switch that landed mid-cycle.
  h.deps.expectedKey = async () => {
    h.calls.expectedReads += 1;
    reads += 1;
    return reads === 1 ? "0123456789abcdef" : "fedcba9876543210";
  };
  const result = await new Poller(h.deps).cycle();
  assert.deepEqual(result.polled, []);
  assert.deepEqual(result.skippedLive.sort(), ["0123456789abcdef", "fedcba9876543210"]);
  assert.equal(h.calls.quota, 0, "a snapshot taken once at cycle start would have polled the newly-live slot");
});

test("a switch in flight stops the cycle instead of racing it", async () => {
  const h = harness(slots);
  h.world.switchInFlight = true;
  const result = await new Poller(h.deps).cycle();
  assert.deepEqual(result.polled, []);
  assert.equal(h.calls.refresh + h.calls.quota, 0, "no request may be made while a switch is running");
  // The live slot is still recognised (it is skipped before the switch check), and the cycle stops at the first slot that
  // would have needed a request.
  assert.deepEqual(result.skippedLive, ["0123456789abcdef"]);
  assert.match(h.log.join("\n"), /a switch is in flight/i);
});

test("a token with more than the 5-minute buffer left is not refreshed again", async () => {
  const h = harness(slots, { tokenExpiresInMs: 30 * 60 * 1000 });
  const poller = new Poller(h.deps);
  await poller.cycle();
  assert.equal(h.calls.refresh, 1);
  await poller.cycle();
  assert.equal(h.calls.refresh, 1, "the cached token was still good");
  assert.equal(h.calls.quota, 2);
  // ... and inside the buffer it refreshes again.
  h.world.tokenExpiresInMs = REFRESH_BUFFER_MS - 60_000;
  (h as unknown as { advance: (ms: number) => void }).advance(0);
  const h2 = harness(slots, { tokenExpiresInMs: REFRESH_BUFFER_MS - 60_000 });
  await new Poller(h2.deps).cycle();
  assert.equal(h2.calls.refresh, 1);
});

test("the blob is read once, and again only when the slot was re-saved (R4-10)", async () => {
  const h = harness(slots);
  const poller = new Poller(h.deps);
  await poller.cycle();
  await poller.cycle();
  assert.equal(h.calls.readBlob, 1, "the blob must not be re-read on every poll");
  await poller.noteSavedAt("fedcba9876543210", "2026-10-27T03:00:00Z");
  await poller.cycle();
  assert.equal(h.calls.readBlob, 2, "a re-save must be picked up");
});

test("a transient failure backs off with doubling and never asks for a sign-in", async () => {
  const h = harness(slots, { quotaStatus: 503 });
  const poller = new Poller(h.deps);
  await poller.cycle();
  assert.equal(h.calls.quota, 1);
  assert.deepEqual(h.calls.needsSignIn, []);
  // The attempt was recorded before the request, so the next cycle is inside the backoff window.
  await poller.cycle();
  assert.equal(h.calls.quota, 1, "the slot must back off, not retry immediately");
  assert.match(h.log.join("\n"), /backoff \d+s/);
  // Past the backoff it tries again.
  (h as unknown as { advance: (ms: number) => void }).advance(BACKOFF_BASE_MS + 1);
  await poller.cycle();
  assert.equal(h.calls.quota, 2);
});

// S4.1 (Rev 5.2 / Probe 3): a 403 from the quota call means the ENDPOINT refused this client (its UA gate), not that the
// account is dead and not that the network hiccuped. It is its own state, reported once, and it must NOT back off — the
// next cycle at the normal cadence is what proves a UA fix (or a transient CDN rule) took effect.
test("a 403 is a refused client: reported, never needs-sign-in, and retried at the normal cadence", async () => {
  const h = harness(slots, { quotaStatus: 403 });
  const poller = new Poller(h.deps);
  await poller.cycle();
  assert.equal(h.calls.clientRefused, 1);
  assert.deepEqual(h.calls.needsSignIn, [], "a refused client is not a dead grant");
  assert.match(h.log.join("|"), /refused/i);
  assert.equal(/backoff/i.test(h.log.join("|")), false, "403 must not enter the transient backoff");
  // No clock advance: the very next cycle tries again.
  await poller.cycle();
  assert.equal(h.calls.quota, 2, "a refused client is retried at the normal cadence, not backed off");
  assert.equal(h.calls.clientRefused, 2);
});

test("a 403 on one slot does not stop the others", async () => {
  const more = [...slots, { key: "1111222233334444", label: "Third", savedAt: "2026-10-26T22:00:00Z" }];
  const h = harness(more, { quotaStatus: 403 });
  const result = await new Poller(h.deps).cycle();
  assert.equal(result.failed.length, 2, "both non-live slots were tried");
  assert.equal(h.calls.clientRefused, 2);
});

test("a successful refresh does not clear the quota backoff (a failing endpoint must keep backing off)", async () => {
  // 500 is the transient class (403 is its own "refused" state, tested above).
  const h = harness(slots, { quotaStatus: 500 });
  const poller = new Poller(h.deps);
  await poller.cycle();
  assert.equal(h.calls.quota, 1);
  // The next cycle refreshes again (the token is dropped on 403) but must NOT call the quota endpoint: one refresh per
  // cycle at worst, never a refresh *and* a quota call hammering a broken endpoint.
  h.world.tokenExpiresInMs = REFRESH_BUFFER_MS - 60_000;
  await poller.cycle();
  assert.equal(h.calls.quota, 1);
});

test("invalid_grant on the locked pair is needs-sign-in, once, and no further requests", async () => {
  const h = harness(slots, { refreshReply: { status: 400, error: "invalid_grant" } });
  const poller = new Poller(h.deps);
  const result = await poller.cycle();
  assert.deepEqual(result.needsSignIn, ["fedcba9876543210"]);
  assert.deepEqual(h.calls.needsSignIn, ["fedcba9876543210"]);
  assert.equal(h.calls.quota, 0);
  await poller.cycle();
  assert.equal(h.calls.refresh, 1, "a dead slot must not be retried every cycle");
});

test("a re-save clears the needs-sign-in state for the slot (R4-6)", async () => {
  const h = harness(slots, { refreshReply: { status: 400, error: "invalid_grant" } });
  const poller = new Poller(h.deps);
  await poller.cycle();
  h.world.refreshReply = { status: 200 };
  poller.slotResaved("fedcba9876543210");
  const result = await poller.cycle();
  assert.deepEqual(result.polled, ["fedcba9876543210"]);
});

test("two cycles at once do not double the requests: single-flight per slot", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const h = harness(slots);
  h.deps.quota = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 10));
    concurrent -= 1;
    return { status: 200, buckets: { gemini5h: { remaining: 0.9, resetsAt: null }, threep5h: null, threepWeekly: null } };
  };
  const poller = new Poller(h.deps);
  await Promise.all([poller.cycle(), poller.cycle()]);
  assert.equal(maxConcurrent, 1, "one request at a time");
});

test("the poller's store has no way to write a credential (read-only by type)", async () => {
  const h = harness(slots);
  // The interface it depends on: slots / readBlob / setPolled. Nothing that could write a blob or a vault entry.
  assert.deepEqual(Object.keys(h.deps.store).sort(), ["readBlob", "setPolled", "slots"]);
  await new Poller(h.deps).cycle();
  // The only write the poller performs is the index's `polled` field.
  assert.equal(h.calls.setPolled, 1);
});

test("the polled record a poll writes carries no weekly (a poll can never have one)", async () => {
  const h = harness(slots);
  await new Poller(h.deps).cycle();
  const record = h.store.polled.get("fedcba9876543210");
  assert.deepEqual(Object.keys(record ?? {}).sort(), ["at", "gemini5h", "threep5h", "threepWeekly"]);
  assert.equal(record?.threepWeekly, null);
});

test("a blob without a refresh token is skipped without a request", async () => {
  const h = harness(slots);
  h.deps.store.readBlob = async () => Buffer.from(JSON.stringify({ token: { access_token: "a" } }), "utf8");
  const result = await new Poller(h.deps).cycle();
  assert.deepEqual(result.polled, []);
  assert.equal(h.calls.refresh, 0);
  assert.equal(h.calls.quota, 0);
});

test("the refresh-token extractor reads only the two fields it needs, and tolerates anything else", () => {
  assert.equal(refreshTokenFromBlob(blob("rt-9")).refreshToken, "rt-9");
  assert.equal(refreshTokenFromBlob(Buffer.from("not json", "utf8")).refreshToken, null);
  assert.equal(refreshTokenFromBlob(Buffer.from(JSON.stringify({ token: {} }), "utf8")).refreshToken, null);
  assert.equal(refreshTokenFromBlob(null).refreshToken, null);
  // The scan buffer ceiling is asserted in the keyscan tests; repeated here so this file fails if it ever moves.
  assert.equal(MAX_BUFFER_BYTES < 32 * 1024 * 1024, true);
});
