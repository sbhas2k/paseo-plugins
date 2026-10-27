// agy-rotator-windows — the `/usage` cache (plan §3.2, R2-6).
//
// Two different cadences meet here. The plugin's own watch asks for a reading when a turn ends or on its tick, which may
// spawn `agy -p /usage` (≈10 s, plan F3). Paseo's usage summary asks on ITS cadence, through the registered usage
// source, and must never spawn one — so `registerUsageSource.fetch` uses `peek`/`joinInFlight`, which answer the last
// reading (or the read already running) and never start a process.
//
// Only a good reading is cached for the full TTL. A failure is cached briefly so a burst of callers cannot spawn a
// process each, and retried soon after: a signed-out CLI becomes readable the moment the owner signs in.

import type { UsageReading } from "../shared/usage.ts";

export const USAGE_TTL_MS = 120_000;
export const USAGE_ERROR_TTL_MS = 15_000;

export type UsageSnapshot =
  | { at: number; kind: "ok"; reading: UsageReading; message?: undefined }
  /** `agy` says the owner is not signed in: a state, not an error. */
  | { at: number; kind: "signed-out"; reading: null; message?: string }
  /** `agy` answered with something this parser does not trust. */
  | { at: number; kind: "unavailable"; reading: null; message?: string }
  | { at: number; kind: "error"; reading: null; message?: string };

export class UsageCache {
  private snapshot: UsageSnapshot | null = null;
  private inFlight: Promise<UsageSnapshot> | null = null;
  private readonly read: () => Promise<UsageSnapshot>;
  private readonly ttlMs: number;
  private readonly errorTtlMs: number;
  private readonly clock: () => number;

  constructor(read: () => Promise<UsageSnapshot>, ttlMs: number = USAGE_TTL_MS, clock: () => number = Date.now, errorTtlMs: number = USAGE_ERROR_TTL_MS) {
    this.read = read;
    this.ttlMs = ttlMs;
    this.errorTtlMs = errorTtlMs;
    this.clock = clock;
  }

  /** The last reading, however old. Never reads. */
  peek(): UsageSnapshot | null {
    return this.snapshot;
  }

  /** The read already running, if any — awaits it, never starts one. */
  async joinInFlight(): Promise<UsageSnapshot | null> {
    return this.inFlight ?? this.snapshot;
  }

  /** A reading, from the cache when it is fresh enough. `refresh` asks for a new one but still joins a running read. */
  async get(options: { refresh?: boolean } = {}): Promise<UsageSnapshot> {
    if (this.inFlight) return this.inFlight;
    if (!options.refresh && this.snapshot && this.age() < this.freshFor(this.snapshot)) return this.snapshot;
    const reading = this.reader();
    this.inFlight = reading;
    try {
      const snapshot = await reading;
      this.snapshot = snapshot;
      return snapshot;
    } finally {
      if (this.inFlight === reading) this.inFlight = null;
    }
  }

  private age(): number {
    if (!this.snapshot) return Number.POSITIVE_INFINITY;
    return this.clock() - this.snapshot.at;
  }

  private freshFor(snapshot: UsageSnapshot): number {
    return snapshot.kind === "ok" ? this.ttlMs : this.errorTtlMs;
  }

  /** One read that cannot throw: a broken spawn is a reading like any other, and the tick must survive it. */
  private async reader(): Promise<UsageSnapshot> {
    try {
      return await this.read();
    } catch (error) {
      return { at: this.clock(), kind: "error", reading: null, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
