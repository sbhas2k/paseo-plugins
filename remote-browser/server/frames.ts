// remote-browser — the latest screen frame and the long-poll over it. Plugin RPC has no push, so the client asks for
// "anything newer than (generation, seq)" and the server answers as soon as there is, or with no data after waitMs.
//
// Chrome keeps encoding only while frames are acked, so a frame is acked when a client TAKES it (or
// when a newer one replaces it untaken) — never on arrival. No client → no ack → Chrome stops encoding.
// Every browser start is a new generation; a client from another generation gets the current frame at
// once (or the first one of the new generation), never a blank.

export interface Frame {
  generation: string;
  seq: number;
  data: string | null;
  width: number;
  height: number;
}

let generationCounter = 0;
const newGeneration = () => `${Date.now().toString(36)}-${++generationCounter}`;

export class FrameQueue {
  generation = newGeneration();
  private seq = 0;
  private data: string | null = null;
  private width = 0;
  private height = 0;
  private ack: (() => void) | null = null;
  private waiters = new Set<() => void>();

  /** A new browser: new generation, nothing to show yet. Waiters stay and get the first new frame. */
  reset(): void {
    this.generation = newGeneration();
    this.seq = 0;
    this.data = null;
    this.ack = null;
  }

  /** Latest wins: a newer frame replaces the previous one; a replaced, untaken frame is acked now. */
  push(data: string, width: number, height: number, ack?: () => void): void {
    this.takeAck();
    this.seq += 1;
    this.data = data;
    this.width = width;
    this.height = height;
    this.ack = ack ?? null;
    const wake = [...this.waiters];
    this.waiters.clear();
    for (const w of wake) w();
  }

  private takeAck(): void {
    const ack = this.ack;
    this.ack = null;
    ack?.();
  }

  private current(): Frame {
    return { generation: this.generation, seq: this.seq, data: this.data, width: this.width, height: this.height };
  }

  private empty(): Frame {
    return { ...this.current(), data: null };
  }

  private isNewFor(generation: string, sinceSeq: number): boolean {
    return this.data !== null && (generation !== this.generation || this.seq > sinceSeq);
  }

  /** Resolves with a frame newer than (generation, sinceSeq), or with no data after waitMs. */
  next(generation: string, sinceSeq: number, waitMs: number): Promise<Frame> {
    if (this.isNewFor(generation, sinceSeq)) {
      this.takeAck();
      return Promise.resolve(this.current());
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        if (this.isNewFor(generation, sinceSeq)) {
          this.takeAck();
          resolve(this.current());
        } else resolve(this.empty());
      };
      const timer = setTimeout(done, Math.max(0, waitMs));
      this.waiters.add(done);
    });
  }

  /** Wake every waiter (used on shutdown so no RPC hangs). */
  flush(): void {
    const wake = [...this.waiters];
    this.waiters.clear();
    for (const w of wake) w();
  }
}
