import assert from "node:assert/strict";
import { test } from "node:test";
import { SingleFlight } from "../server/single-flight.ts";

// F-02 (Gemini review, 9da9e943): nothing stopped two switches from running at once. The auto path checked a flag that
// is set only after several awaits, and the manual RPC checked nothing — so two overlapping `credits_exhausted` turns,
// or a tick landing on a click, could write the live credential twice in a row with the two orders interleaved.
//
// The guard has to be SYNCHRONOUS (set before the first await) and it has to survive the work throwing, or the plugin
// would be stuck "in flight" forever after one failed switch.

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

test("the second concurrent call is refused rather than started", async () => {
  const flight = new SingleFlight();
  const gate = deferred();
  let started = 0;
  const work = async () => {
    started += 1;
    await gate.promise;
    return "done";
  };
  const first = flight.run(work);
  const second = flight.run(work);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(started, 1);
  assert.deepEqual([a.ran, b.ran], [true, false]);
  assert.equal(a.ran ? a.value : null, "done");
});

test("the guard is already closed synchronously, before any await", () => {
  const flight = new SingleFlight();
  void flight.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  // No await between the two lines: a guard set after an await would still read false here.
  assert.equal(flight.inFlight, true);
});

test("a finished call reopens the guard, and a failed one does too", async () => {
  const flight = new SingleFlight();
  const ok = await flight.run(async () => "fine");
  assert.equal(ok.ran, true);
  assert.equal(flight.inFlight, false);
  await assert.rejects(() => flight.run(async () => {
    throw new Error("credential helper refused");
  }));
  assert.equal(flight.inFlight, false);
  const after = await flight.run(async () => "again");
  assert.deepEqual([after.ran, after.ran ? after.value : null], [true, "again"]);
});

test("a refused call does not disturb the one that is running", async () => {
  const flight = new SingleFlight();
  const gate = deferred();
  const running = flight.run(async () => {
    await gate.promise;
    return 7;
  });
  const refused = await flight.run(async () => 8);
  assert.deepEqual(refused.ran, false);
  gate.resolve();
  const done = await running;
  assert.equal(done.ran ? done.value : null, 7);
});

test("a caller can tell a refusal from a result without guessing", async () => {
  const flight = new SingleFlight();
  const gate = deferred();
  const running = flight.run(async () => {
    await gate.promise;
  });
  const refused = await flight.run(async () => {});
  assert.equal(refused.ran, false);
  assert.equal("value" in refused, false);
  gate.resolve();
  await running;
});
