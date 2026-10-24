import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import type { CdpConnection } from "./cdp.ts";
import { findBrowser, launchBrowser, stopProfileBrowsers, type BrowserMode } from "./chrome.ts";
import { FrameQueue, type Frame } from "./frames.ts";
import { clampViewport, type Size } from "../shared/geometry.ts";
import { keyEventFor, modifierBits, type KeyInput } from "../shared/keys.ts";

// remote-browser — the one browser this plugin owns: tabs, the screen stream of the active tab, input and lifecycle.

export interface TabInfo {
  id: string;
  title: string;
  url: string;
}

export interface BrowserState {
  running: boolean;
  tabs: TabInfo[];
  activeId: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  viewport: Size;
  error: string | null;
}

export type MouseInput = {
  kind: "mouse";
  type: "mouseMoved" | "mousePressed" | "mouseReleased";
  x: number;
  y: number;
  button: "none" | "left" | "middle" | "right";
  clickCount: number;
  mods: Omit<KeyInput, "key" | "code">;
};
export type WheelInput = { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number };
export type KeyboardInput = { kind: "key"; type: "keyDown" | "keyUp"; event: KeyInput };
export type TextInput = { kind: "text"; text: string };
export type RemoteInput = MouseInput | WheelInput | KeyboardInput | TextInput;

export interface BrowserOptions {
  profile: string;
  binary: string | null;
  idleMs: number;
  mode?: BrowserMode;
  log: (line: string) => void;
}

export class RemoteBrowser {
  readonly frames = new FrameQueue();
  private conn: CdpConnection | null = null;
  private starting: Promise<CdpConnection> | null = null;
  private child: ChildProcess | null = null;
  private sessions = new Map<string, string>(); // targetId → sessionId
  private tabs = new Map<string, TabInfo>();
  private activeId: string | null = null;
  private viewport: Size = { width: 1280, height: 800 };
  private history = { canGoBack: false, canGoForward: false };
  private lastError: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly options: BrowserOptions;

  constructor(options: BrowserOptions) {
    this.options = options;
  }

  /** Every RPC calls this: it (re)starts the browser if needed and pushes the idle shutdown back. */
  async ensure(): Promise<CdpConnection> {
    this.touch();
    if (this.conn && !this.conn.closed) return this.conn;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.options.log(`idle ${Math.round(this.options.idleMs / 60_000)} min - stopping the browser`);
      void this.stop();
    }, this.options.idleMs);
  }

  private async start(): Promise<CdpConnection> {
    const binary = findBrowser(this.options.binary);
    if (!binary) throw new Error("No Chrome or Edge found on this host. Set the browser path in Settings.");
    const launched = await launchBrowser(binary, this.options.profile, this.options.mode ?? "window");
    this.child = launched.child;
    this.options.log(`started ${binary} (pid ${launched.child.pid}, ${this.options.mode ?? "window"} mode, DevTools over a pipe - no port)`);
    const conn = launched.conn;
    this.conn = conn;
    this.frames.reset();
    this.sessions.clear();
    this.tabs.clear();
    this.activeId = null;
    conn.onClose(() => {
      if (this.conn === conn) this.conn = null;
      this.sessions.clear();
      this.frames.flush();
    });
    conn.on("Target.targetInfoChanged", (p) => this.onTargetInfo(p.targetInfo as Record<string, unknown>));
    conn.on("Target.targetCreated", (p) => this.onTargetInfo(p.targetInfo as Record<string, unknown>));
    conn.on("Target.targetDestroyed", (p) => void this.onTargetGone(String(p.targetId)));
    conn.on("Page.screencastFrame", (p, sessionId) => {
      if (!sessionId) return;
      const ack = () => void conn.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sessionId).catch(() => {});
      // Not the streamed tab (a late frame after a switch): ack so that tab's encoder is not left waiting.
      if (sessionId !== this.sessionOf(this.activeId)) {
        ack();
        return;
      }
      // Acked when a client takes it: no viewer, no encoding.
      const meta = p.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
      this.frames.push(String(p.data), meta?.deviceWidth ?? this.viewport.width, meta?.deviceHeight ?? this.viewport.height, ack);
    });
    conn.on("Page.frameNavigated", (_p, sessionId) => {
      if (sessionId && sessionId === this.sessionOf(this.activeId)) void this.refreshHistory();
    });
    await conn.send("Target.setDiscoverTargets", { discover: true });
    // Downloads land in a known folder on the host, not Chrome's default.
    await conn
      .send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(path.dirname(this.options.profile), "downloads") })
      .catch(() => {});
    const { targetInfos } = await conn.send<{ targetInfos: Record<string, unknown>[] }>("Target.getTargets");
    for (const info of targetInfos) this.onTargetInfo(info);
    const firstPage = targetInfos.find((t) => t.type === "page");
    const id = firstPage ? String(firstPage.targetId) : await this.createTab("about:blank", conn);
    await this.activate(id, conn);
    return conn;
  }

  private onTargetInfo(info: Record<string, unknown> | undefined): void {
    if (!info || info.type !== "page") return;
    const id = String(info.targetId);
    this.tabs.set(id, { id, title: String(info.title ?? ""), url: String(info.url ?? "") });
  }

  private async onTargetGone(id: string): Promise<void> {
    this.tabs.delete(id);
    this.sessions.delete(id);
    if (this.activeId !== id) return;
    this.activeId = null;
    const next = [...this.tabs.keys()][0];
    if (next && this.conn) await this.activate(next, this.conn).catch(() => {});
  }

  private sessionOf(targetId: string | null): string | undefined {
    return targetId ? this.sessions.get(targetId) : undefined;
  }

  private async attach(targetId: string, conn: CdpConnection): Promise<string> {
    const known = this.sessions.get(targetId);
    if (known) return known;
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    await conn.send("Page.enable", {}, sessionId);
    return sessionId;
  }

  private async createTab(url: string, conn: CdpConnection): Promise<string> {
    const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url });
    this.tabs.set(targetId, { id: targetId, title: "", url });
    return targetId;
  }

  private async activate(targetId: string, conn: CdpConnection): Promise<void> {
    const previous = this.sessionOf(this.activeId);
    if (previous && this.activeId !== targetId) await conn.send("Page.stopScreencast", {}, previous).catch(() => {});
    const sessionId = await this.attach(targetId, conn);
    this.activeId = targetId;
    await conn.send("Target.activateTarget", { targetId }).catch(() => {});
    await this.applyViewport(conn, sessionId);
    await conn.send(
      "Page.startScreencast",
      { format: "jpeg", quality: 60, maxWidth: this.viewport.width, maxHeight: this.viewport.height, everyNthFrame: 1 },
      sessionId,
    );
    await this.refreshHistory();
  }

  private async applyViewport(conn: CdpConnection, sessionId: string): Promise<void> {
    await conn.send(
      "Emulation.setDeviceMetricsOverride",
      { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  }

  private async refreshHistory(): Promise<void> {
    const sessionId = this.sessionOf(this.activeId);
    if (!sessionId || !this.conn) return;
    try {
      const h = await this.conn.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {}, sessionId);
      this.history = { canGoBack: h.currentIndex > 0, canGoForward: h.currentIndex < h.entries.length - 1 };
    } catch {
      this.history = { canGoBack: false, canGoForward: false };
    }
  }

  async state(): Promise<BrowserState> {
    return {
      running: Boolean(this.conn && !this.conn.closed),
      tabs: [...this.tabs.values()],
      activeId: this.activeId,
      canGoBack: this.history.canGoBack,
      canGoForward: this.history.canGoForward,
      viewport: this.viewport,
      error: this.lastError,
    };
  }

  async frame(generation: string, sinceSeq: number, waitMs: number): Promise<Frame> {
    await this.ensure();
    return this.frames.next(generation, sinceSeq, Math.min(Math.max(waitMs, 0), 1500));
  }

  private async active(): Promise<{ conn: CdpConnection; sessionId: string }> {
    const conn = await this.ensure();
    if (!this.activeId) await this.activate(await this.createTab("about:blank", conn), conn);
    const sessionId = await this.attach(this.activeId as string, conn);
    return { conn, sessionId };
  }

  async navigate(url: string): Promise<void> {
    const { conn, sessionId } = await this.active();
    const result = await conn.send<{ errorText?: string }>("Page.navigate", { url }, sessionId);
    this.lastError = result.errorText ? `${url}: ${result.errorText}` : null;
  }

  async historyAction(action: "back" | "forward" | "reload"): Promise<void> {
    const { conn, sessionId } = await this.active();
    if (action === "reload") {
      await conn.send("Page.reload", {}, sessionId);
      return;
    }
    const h = await conn.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {}, sessionId);
    const entry = h.entries[h.currentIndex + (action === "back" ? -1 : 1)];
    if (entry) await conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
  }

  async input(event: RemoteInput): Promise<void> {
    const { conn, sessionId } = await this.active();
    switch (event.kind) {
      case "mouse":
        await conn.send(
          "Input.dispatchMouseEvent",
          { type: event.type, x: event.x, y: event.y, button: event.button, clickCount: event.clickCount, modifiers: modifierBits(event.mods) },
          sessionId,
        );
        return;
      case "wheel":
        await conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY }, sessionId);
        return;
      case "key":
        await conn.send("Input.dispatchKeyEvent", { ...keyEventFor(event.type, event.event) }, sessionId);
        return;
      case "text":
        await conn.send("Input.insertText", { text: event.text }, sessionId);
        return;
    }
  }

  async tabAction(action: "new" | "close" | "select", id?: string): Promise<void> {
    const conn = await this.ensure();
    if (action === "new") {
      await this.activate(await this.createTab("about:blank", conn), conn);
      return;
    }
    if (!id || !this.tabs.has(id)) throw new Error("No such tab.");
    if (action === "select") {
      await this.activate(id, conn);
      return;
    }
    if (this.tabs.size === 1) await this.activate(await this.createTab("about:blank", conn), conn);
    await conn.send("Target.closeTarget", { targetId: id });
  }

  async resize(width: number, height: number): Promise<Size> {
    const next = clampViewport(width, height);
    if (next.width === this.viewport.width && next.height === this.viewport.height) return next;
    this.viewport = next;
    const conn = await this.ensure();
    const sessionId = this.sessionOf(this.activeId);
    if (sessionId) {
      await this.applyViewport(conn, sessionId);
      await conn.send("Page.stopScreencast", {}, sessionId).catch(() => {});
      await conn.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 60, maxWidth: next.width, maxHeight: next.height, everyNthFrame: 1 },
        sessionId,
      );
    }
    return next;
  }

  /** Closes the browser this plugin started; a re-attached one is closed through CDP. */
  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const conn = this.conn;
    this.conn = null;
    if (conn && !conn.closed) await conn.send("Browser.close", {}, undefined, 5_000).catch(() => {});
    conn?.close();
    this.sessions.clear();
    this.tabs.clear();
    this.activeId = null;
    this.frames.flush();
    // Browser.close returns before Chrome's helper processes have gone (measured: ~11 processes take a few seconds).
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited && process.platform === "win32" && child.pid) {
        await new Promise<void>((resolve) =>
          execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()),
        );
      }
    }
    await stopProfileBrowsers(this.options.profile);
  }


}
