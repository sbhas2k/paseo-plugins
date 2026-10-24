// remote-browser — a minimal Chrome DevTools Protocol client over Chrome's DevTools PIPE (--remote-debugging-pipe):
// Chrome reads commands on fd 3 and writes replies/events on fd 4, each message NUL-terminated. No TCP port exists,
// so no other local process can drive the browser. One browser-level connection; pages are driven
// through flattened target sessions.
import type { Readable, Writable } from "node:stream";

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class CdpConnection {
  private readonly out: Writable;
  private nextId = 0;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<Listener>>();
  private closeHandlers = new Set<() => void>();
  closed = false;

  constructor(toChrome: Writable, fromChrome: Readable) {
    this.out = toChrome;
    fromChrome.setEncoding("utf8");
    fromChrome.on("data", (chunk: string) => this.onData(chunk));
    fromChrome.on("close", () => this.handleClose());
    fromChrome.on("error", () => this.handleClose());
    toChrome.on("error", () => this.handleClose());
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => set?.delete(listener);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("browser connection closed"));
    }
    this.pending.clear();
    for (const h of this.closeHandlers) h();
  }

  close(): void {
    this.handleClose();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\0")) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      this.onMessage(raw);
    }
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {}, msg.sessionId);
  }
}
