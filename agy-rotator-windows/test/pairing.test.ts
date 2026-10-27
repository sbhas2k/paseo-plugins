import assert from "node:assert/strict";
import { test } from "node:test";
import { findPairing, MAX_PAIRS, type RefreshRequest, type RefreshReply } from "../shared/pairing.ts";

// S4 / AC8 — functional pairing. The fixture is three ids and three secrets (the shape a real agy yields), and the fake
// token endpoint is a table: (client_id, refresh_token) → reply. Nothing here touches the network, and no value printed
// by a failure is a secret — the fixture values are invented strings in the right shape.

const ID = (n: number) => `${100000000000 + n}-${"a".repeat(28)}.apps.googleusercontent.com`;
const SECRET = (n: number) => `GOCSPX-${String(n).repeat(28).slice(0, 28)}`;

/** A fake endpoint: a rule matches on whichever of id/secret/token it names; anything unmatched is invalid_client. */
function endpoint(rules: Array<{ id?: string; secret?: string; token?: string; reply: RefreshReply }>) {
  const calls: RefreshRequest[] = [];
  return {
    calls,
    post: async (request: RefreshRequest): Promise<RefreshReply> => {
      calls.push(request);
      const rule = rules.find(
        (candidate) =>
          (candidate.id === undefined || candidate.id === request.id) &&
          (candidate.secret === undefined || candidate.secret === request.secret) &&
          (candidate.token === undefined || candidate.token === request.refreshToken),
      );
      return rule?.reply ?? { status: 400, error: "invalid_client" };
    },
  };
}

const slots = [
  { key: "slot-a", refreshToken: "rt-a" },
  { key: "slot-b", refreshToken: "rt-b" },
];

test("the pair that mints a token locks, and nothing else does", async () => {
  const fake = endpoint([{ id: ID(2), secret: SECRET(2), token: "rt-b", reply: { status: 200 } }]);
  const outcome = await findPairing({ ids: [ID(1), ID(2), ID(3)], secrets: [SECRET(1), SECRET(2), SECRET(3)], slots, post: fake.post });
  assert.equal(outcome.kind, "locked");
  if (outcome.kind !== "locked") return;
  assert.deepEqual(outcome.pair, { id: ID(2), secret: SECRET(2) });
  assert.equal(outcome.attempts, fake.calls.length);
});

test("wrong keys advance: invalid_client on every slot moves to the next pair", async () => {
  // Pair 1 (id1/sec1) is wrong for both slots; pair 2 (id1/sec2) works for slot-b only.
  const fake = endpoint([{ id: ID(1), secret: SECRET(2), token: "rt-b", reply: { status: 200 } }]);
  const outcome = await findPairing({ ids: [ID(1)], secrets: [SECRET(1), SECRET(2)], slots, post: fake.post });
  assert.equal(outcome.kind, "locked");
  if (outcome.kind !== "locked") return;
  assert.deepEqual(outcome.pair, { id: ID(1), secret: SECRET(2) });
  // slot-a was tried on both pairs before slot-b answered 200 on the second.
  assert.deepEqual(fake.calls.map((call) => `${call.secret === SECRET(1) ? "s1" : "s2"}|${call.refreshToken}`), ["s1|rt-a", "s1|rt-b", "s2|rt-a", "s2|rt-b"]);
});

test("a right client with a dead grant is NOT the pair: invalid_grant advances too", async () => {
  const fake = endpoint([
    { id: ID(1), token: "rt-a", reply: { status: 400, error: "invalid_grant" } },
    { id: ID(1), token: "rt-b", reply: { status: 400, error: "invalid_grant" } },
    { id: ID(2), secret: SECRET(1), token: "rt-a", reply: { status: 200 } },
  ]);
  const outcome = await findPairing({ ids: [ID(1), ID(2)], secrets: [SECRET(1)], slots, post: fake.post });
  assert.equal(outcome.kind, "locked");
  if (outcome.kind !== "locked") return;
  assert.equal(outcome.pair.id, ID(2));
});

test("no 200 anywhere is pairing-unresolved, never needs-sign-in", async () => {
  const fake = endpoint([{ id: ID(1), reply: { status: 400, error: "invalid_grant" } }]);
  const outcome = await findPairing({ ids: [ID(1)], secrets: [SECRET(1)], slots, post: fake.post });
  assert.equal(outcome.kind, "unresolved");
  // The outcome carries no per-slot verdict at all: that is the poller's call, once a pair is locked.
  assert.equal("needsSignIn" in outcome, false);
});

test("every pair answering invalid_client is unresolved as well", async () => {
  const fake = endpoint([]);
  assert.equal((await findPairing({ ids: [ID(1), ID(2)], secrets: [SECRET(1)], slots, post: fake.post })).kind, "unresolved");
});

test("a transient failure (500, timeout) never locks", async () => {
  const fake = endpoint([
    { id: ID(1), token: "rt-a", reply: { status: 500 } },
    { id: ID(1), token: "rt-b", reply: { status: 429 } },
  ]);
  assert.equal((await findPairing({ ids: [ID(1)], secrets: [SECRET(1)], slots, post: fake.post })).kind, "unresolved");
});

test("ids but no secret is its own state — the PKCE-only future, not a dead account", async () => {
  const outcome = await findPairing({ ids: [ID(1)], secrets: [], slots, post: async () => ({ status: 200 }) });
  assert.deepEqual(outcome, { kind: "unavailable", reason: "no-secret" });
});

test("no id at all is its own state too", async () => {
  assert.deepEqual(await findPairing({ ids: [], secrets: [SECRET(1)], slots, post: async () => ({ status: 200 }) }), {
    kind: "unavailable",
    reason: "no-id",
  });
});

test("the loop is bounded by pairs x slots, whatever the binary contains", async () => {
  const ids = Array.from({ length: 20 }, (_, index) => ID(index));
  const secrets = Array.from({ length: 5 }, (_, index) => SECRET(index));
  const fake = endpoint([]);
  const outcome = await findPairing({ ids, secrets, slots, post: fake.post });
  assert.equal(outcome.kind, "unresolved");
  assert.equal(MAX_PAIRS, 9);
  assert.equal(fake.calls.length <= MAX_PAIRS * slots.length, true, `${fake.calls.length} attempts`);
});

test("a slot with no refresh token is never tried (nothing to mint with)", async () => {
  const fake = endpoint([]);
  await findPairing({ ids: [ID(1)], secrets: [SECRET(1)], slots: [{ key: "empty", refreshToken: null }], post: fake.post });
  assert.equal(fake.calls.length, 0);
});
