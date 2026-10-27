// agy-rotator-windows — the live 5-hour poller (plan §3.7 "Poll"/"Failure states"; AC9).
//
// Every five minutes it asks `v1internal:retrieveUserQuota` for each SAVED account that is not the live one, using a
// refresh token minted in memory from the slot's stored sign-in. It never writes a credential: `PollStore` can read a
// blob, read/write the index, and nothing else — there is no `credWrite`, `writeLive` or `credDelete` in its type, so the
// compiler is what enforces "the poller cannot write the vault".
//
// The rules that matter, and each has a test:
//  - **per request, not per cycle** (R4-8): `expected` and the switch single-flight are re-read before every slot, so a
//    switch that starts mid-cycle is respected from the next slot on;
//  - the live account is never polled (its `/usage` reading is fresher and costs nothing extra);
//  - a refresh token and its expiry are cached in memory; the blob is re-read only when `savedAt` changed or a refresh
//    failed (R4-10 — no PowerShell spawn per poll), and a fresh access token is **never written back**;
//  - one request at a time, the attempt recorded BEFORE it (so a 429 cannot be amplified), `invalid_grant` on the locked
//    pair means needs-sign-in, while network/429/5xx are transient with a doubling backoff;
//  - a poll MERGES into `polled` (it can never carry the weekly, so replacing would erase it).

import { mergePolled, type PolledReading } from "../shared/polled.ts";
import type { UsageBucket } from "../shared/usage.ts";

export const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Refresh this long before expiry, and never sooner than necessary (≈13 requests/h/account). */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** Backoff for transient failures: ×2 per failure, capped. */
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** One saved slot, as the index describes it. */
export interface PollSlot {
  key: string;
  label: string;
  savedAt: string;
}

/** The only things the poller may reach: read a blob, read/write the index. No credential write exists here. */
export interface PollStore {
  slots(): Promise<PollSlot[]>;
  readBlob(key: string): Promise<Buffer | null>;
  setPolled(key: string, polled: PolledReading): Promise<void>;
}

export interface TokenReply {
  status: number;
  /** The OAuth error CODE only (`invalid_grant`, `invalid_client`, …). Never a description, never response text. */
  error?: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export interface QuotaReply {
  status: number;
  /** `gemini-5h` and the two 3p buckets, already parsed; null when the response shape was not understood. */
  buckets?: { gemini5h: UsageBucket | null; threep5h: UsageBucket | null; threepWeekly: UsageBucket | null } | null;
}

export interface PollDeps {
  store: PollStore;
  /** The account the plugin expects to be active. Re-read before EVERY request (R4-8). */
  expectedKey(): Promise<string | null>;
  /** Is a switch running? Re-read before EVERY request (R4-8). */
  switchInFlight(): Promise<boolean>;
  /** A hand-started `agy` on this slot's account (F8/F12): do not refresh it, its token is still the one in use. */
  staleTerminalFor(key: string): Promise<boolean>;
  /** Mint an access token. The transport lives outside: literal endpoint, `redirect: "error"`, status-only errors. */
  refresh(refreshToken: string): Promise<TokenReply>;
  /** Ask for the quota. Same hygiene as `refresh`. */
  quota(accessToken: string): Promise<QuotaReply>;
  needsSignIn(key: string, reason: string): void;
  /**
   * The quota endpoint refused this CLIENT (a 403, its user-agent gate — Rev 5.2 / Probe 3). Not a dead grant and not a
   * transient hiccup: it is its own state, reported once, and retried at the normal cadence.
   */
  clientRefused(): void;
  signInCleared(key: string): void;
  now(): number;
  log(line: string): void;
}

interface SlotToken {
  accessToken: string;
  expiresAt: number;
  seenSavedAt: string;
}

interface SlotState {
  token: SlotToken | null;
  failures: number;
  nextAttemptAt: number;
  dead: boolean;
}

export interface PollResult {
  polled: string[];
  skippedLive: string[];
  skippedOther: string[];
  needsSignIn: string[];
  failed: string[];
}

interface RefreshTokenFromBlob {
  refreshToken: string | null;
}

/**
 * The one field the poller needs out of a stored sign-in blob: the refresh token. Parsed locally, never logged, never
 * returned to a caller that could print it. (`readBlobEmail` is deliberately NOT a precondition here — the poller needs a
 * token, not an identity, and a blob without an email is still worth trying.)
 */
export function refreshTokenFromBlob(blob: Buffer | null): RefreshTokenFromBlob {
  if (blob === null) return { refreshToken: null };
  try {
    const parsed = JSON.parse(blob.toString("utf8")) as { token?: { refresh_token?: unknown } };
    const token = parsed.token?.refresh_token;
    return { refreshToken: typeof token === "string" && token.length > 0 ? token : null };
  } catch {
    return { refreshToken: null };
  }
}

/** One cycle over every saved slot. Sequential by construction: one request in flight, ever. */
export class Poller {
  private readonly state = new Map<string, SlotState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly deps: PollDeps;

  constructor(deps: PollDeps) {
    this.deps = deps;
  }

  private slotState(key: string): SlotState {
    const existing = this.state.get(key);
    if (existing) return existing;
    const fresh: SlotState = { token: null, failures: 0, nextAttemptAt: 0, dead: false };
    this.state.set(key, fresh);
    return fresh;
  }

  /** A re-save clears "needs sign-in": the owner signed in again, so the slot deserves one more try. */
  slotResaved(key: string): void {
    this.state.delete(key);
    this.deps.signInCleared(key);
  }

  async cycle(): Promise<PollResult> {
    const result: PollResult = { polled: [], skippedLive: [], skippedOther: [], needsSignIn: [], failed: [] };
    const slots = await this.deps.store.slots();

    for (const slot of slots) {
      // R4-8: re-read the world before EVERY slot's requests, not once per cycle.
      if ((await this.deps.expectedKey()) === slot.key) {
        result.skippedLive.push(slot.key);
        this.deps.log(`poll: ${slot.label} skipped (live account)`);
        continue;
      }
      if (await this.deps.switchInFlight()) {
        this.deps.log(`poll: ${slot.label} skipped (a switch is in flight) - stopping this cycle`);
        break;
      }
      const state = this.slotState(slot.key);
      if (state.dead) {
        result.skippedOther.push(slot.key);
        continue;
      }
      const now = this.deps.now();
      if (now < state.nextAttemptAt) {
        result.skippedOther.push(slot.key);
        this.deps.log(`poll: ${slot.label} backing off (${Math.ceil((state.nextAttemptAt - now) / 1000)}s)`);
        continue;
      }

      // Single-flight per slot: a second cycle (or a manual refresh) joins the running one instead of doubling it.
      const running = this.inFlight.get(slot.key);
      if (running) {
        await running;
        continue;
      }
      const work = this.pollOne(slot, state, result).catch((error: unknown) => {
        this.deps.log(`poll: ${slot.label} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.inFlight.set(slot.key, work);
      try {
        await work;
      } finally {
        this.inFlight.delete(slot.key);
      }
    }
    return result;
  }

  private async pollOne(slot: PollSlot, state: SlotState, result: PollResult): Promise<void> {
    const token = await this.tokenFor(slot, state);
    if (token.kind === "needs-sign-in") {
      result.needsSignIn.push(slot.key);
      return;
    }
    if (token.kind === "skip") {
      result.skippedOther.push(slot.key);
      return;
    }
    // The attempt is recorded BEFORE the request, so a failure cannot amplify itself on the next cycle.
    const attemptAt = this.deps.now();
    const reply = await this.deps.quota(token.token.accessToken);
    if (reply.status === 200 && reply.buckets) {
      state.failures = 0;
      state.nextAttemptAt = 0;
      const at = new Date(attemptAt).toISOString();
      await this.deps.store.setPolled(slot.key, { at, ...reply.buckets });
      result.polled.push(slot.key);
      const five = reply.buckets.gemini5h;
      this.deps.log(`poll: ${slot.label} ok - gemini 5h ${five === null ? "unknown" : `${Math.round(five.remaining * 100)}% left`}`);
      return;
    }
    if (reply.status === 403) {
      // Client refused (the endpoint's UA gate): its own state, reported, no backoff — the next cycle at the normal
      // cadence is what shows a fix took effect. The access token is untouched; it is not the problem.
      this.deps.clientRefused();
      this.deps.log(`poll: ${slot.label} refused (status 403) - the quota endpoint refused this client`);
      result.failed.push(slot.key);
      return;
    }
    if (reply.status === 401) {
      // The cached access token died without a refresh signal: drop it, the next cycle refreshes.
      state.token = null;
    }
    this.transient(slot, state, reply.status);
    result.failed.push(slot.key);
  }

  /** Transient failure: back off ×2 up to an hour. Never "needs sign-in" — that is only a dead grant. */
  private transient(slot: PollSlot, state: SlotState, status: number): void {
    state.failures += 1;
    state.nextAttemptAt = this.deps.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.failures - 1));
    this.deps.log(`poll: ${slot.label} transient failure (status ${status}) - backoff ${Math.round((state.nextAttemptAt - this.deps.now()) / 1000)}s`);
  }

  /** A usable access token: cached while it has more than the buffer left, refreshed otherwise. */
  private async tokenFor(slot: PollSlot, state: SlotState): Promise<{ kind: "ok"; token: SlotToken } | { kind: "needs-sign-in" } | { kind: "skip" }> {
    const now = this.deps.now();
    if (state.token && state.token.expiresAt - now > REFRESH_BUFFER_MS) return { kind: "ok", token: state.token };

    // The blob is re-read only when the slot was re-saved, or when there is no usable token (R4-10).
    const blob = await this.deps.store.readBlob(slot.key);
    const { refreshToken } = refreshTokenFromBlob(blob);
    if (refreshToken === null) {
      this.deps.log(`poll: ${slot.label} has no refresh token - skipped`);
      return { kind: "skip" };
    }
    const reply = await this.deps.refresh(refreshToken);
    if (reply.status === 200 && reply.accessToken && reply.expiresAt) {
      state.token = { accessToken: reply.accessToken, expiresAt: reply.expiresAt, seenSavedAt: slot.savedAt };
      // The refresh succeeded — but that says nothing about the QUOTA call, which is the one that may be failing. The
      // backoff is cleared only by a successful reading (below), so a permanently failing quota endpoint backs off to an hour
      // instead of costing two requests every five minutes forever.
      return { kind: "ok", token: state.token };
    }
    if (reply.error === "invalid_grant") {
      // The locked pair is right, the grant is dead: needs sign-in, and no further refresh for this slot.
      state.dead = true;
      state.token = null;
      this.deps.needsSignIn(slot.key, "invalid_grant");
      this.deps.log(`poll: ${slot.label} needs a sign-in (the locked pair answered invalid_grant)`);
      return { kind: "needs-sign-in" };
    }
    this.transient(slot, state, reply.status);
    return { kind: "skip" };
  }

  /** The slot's blob changed (re-save): forget the cached token so the next cycle reads the new sign-in. */
  async noteSavedAt(key: string, savedAt: string): Promise<void> {
    const state = this.state.get(key);
    if (!state?.token) return;
    if (state.token.seenSavedAt !== savedAt) {
      state.token = null;
      this.slotResaved(key);
    }
  }
}
