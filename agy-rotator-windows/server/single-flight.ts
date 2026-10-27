// agy-rotator-windows — one switch at a time (review F-02).
//
// A switch writes the live credential, records the expectation, dispatches CLI reloads and (these days) can be started by
// three different triggers: a turn end, the ten-minute tick, and the owner's own button. Two of them landing together
// would write `gemini:antigravity` twice with the two orders interleaved — the second write's "save the live blob to its
// own slot" would file the first write's account under the wrong expectation, and the reloads would fight.
//
// The guard must be SYNCHRONOUS: it has to be closed before the first `await`, or the check is itself a race. It must also
// reopen when the work throws, or one failed switch freezes the plugin until a restart.

export type FlightResult<T> = { ran: true; value: T } | { ran: false };

export class SingleFlight {
  private running: Promise<unknown> | null = null;

  /** True from the moment a switch starts until it settles — safe to read from an RPC to answer "wait". */
  get inFlight(): boolean {
    return this.running !== null;
  }

  /** Runs `work` unless something is already running, in which case it answers `{ ran: false }` without starting it. */
  async run<T>(work: () => Promise<T>): Promise<FlightResult<T>> {
    if (this.running !== null) return { ran: false };
    // Started and marked in the same tick: no await between these two lines, so a second caller cannot slip in.
    const promise = work();
    this.running = promise.then(
      () => undefined,
      () => undefined,
    );
    try {
      return { ran: true, value: await promise };
    } finally {
      this.running = null;
    }
  }
}
