// agy-rotator-windows — a test-only preload that PINS the process clock.
//
// Why it exists: the S3 verification rerun went red at 18:13Z on 2026-10-26 because a fixture's `resetsAt` had passed,
// and `decide()` counts a bucket past its reset time as refilled (F10) — so the suite's verdict changed with the wall
// clock. The fix is that every test names its instant; this file is the proof that nothing else is left reading the
// clock, by running the whole suite with the clock nailed to an instant the caller chooses:
//
//   FAKE_NOW=2026-12-31T00:00:00Z node --import ./testutil/fake-clock.ts --test test/view.test.ts …
//
// Not part of `npm test`: it is loaded only by `--import`, so it can never silently change a normal run. Both `Date.now()`
// and `new Date()` (no arguments) are pinned; `new Date(x)` behaves exactly as before, which is what every fixture uses.
const requested = process.env.FAKE_NOW?.trim();
const fixed = requested ? Date.parse(requested) : Number.NaN;

if (Number.isFinite(fixed)) {
  const RealDate = Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class PinnedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(fixed);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      else super(...(args as [any]));
    }
    static now(): number {
      return fixed;
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
  console.log(`[fake-clock] Date.now() pinned to ${new RealDate(fixed).toISOString()}`);
} else if (requested) {
  throw new Error(`FAKE_NOW=${requested} is not a date this preload can pin.`);
}
