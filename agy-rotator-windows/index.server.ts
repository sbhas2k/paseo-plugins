import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { checkRpc, cleanupRpc, removeRpc, reorderRpc, saveRpc, stateRpc, switchRpc } from "./shared/contracts";
import { ANTIGRAVITY_PROVIDER, isAntigravity, type SwitchAgent } from "./shared/agents";
import { autoDecide, debounceElapsed, EVALUATE_GAP_MS } from "./shared/auto";
import { type TurnOutcome } from "./shared/decide";
import { readBlobEmail, unsavedLabel } from "./shared/slots";
import { LIVE_TARGET } from "./shared/targets";
import { thresholdFromUsedPct, AgyAccountsSettingsSchema, agyAccountsSettings, type AgyAccountsSettings } from "./shared/settings";
import { terminalStale } from "./shared/terminals";
import type { UsageReading } from "./shared/usage";
import { buildStatePayload, type SwitchProgressView } from "./shared/view";
import { listAgyProcesses } from "./server/census";
import { cliReload, probeCli } from "./server/cli";
import { credRead } from "./server/cred";
import { accountKey } from "./server/key";
import { pendingFold } from "./shared/pending";
import { reassert, realReassertDeps, type ReassertDeps } from "./server/reassert";
import { emptyPluginState, readPluginState, writePluginState, type PluginStateFile } from "./server/state";
import { exclusiveWrite, paseoHome, readIndex, readIndexHealth, removeSlot, renameSlot, reorderSlot, saveSlot, setPolled, setSlotUsage } from "./server/store";
import { credDelete, credEnumerate } from "./server/cred";
import { cleanupLabel, planCleanup } from "./server/cleanup-plan";
import { KeyScout } from "./server/keyscan";
import { migratePluginData } from "./server/migrate";
import { POLL_INTERVAL_MS, Poller } from "./server/poller";
import { postQuota, postRefresh } from "./server/quota-transport";
import { SingleFlight } from "./server/single-flight";
import { findPairing } from "./shared/pairing";
import { resolveAgyBinary } from "./server/usage-runner";
import { emptySwitchState, realSwitchDeps, switchAccount, type SwitchDeps, type SwitchResult } from "./server/switch";
import { usageReport } from "./server/usage-report";
import { UsageCache } from "./server/usage-cache";
import { readUsage } from "./server/usage-runner";

// agy-rotator-windows — automatic Antigravity (`agy`) account switching on Windows.
//
//
// S3 is the automatic half: the same `decide()` the screen shows, run on the tick and on every `antigravity-cli` turn end,
// with a threshold the owner sets as "switch when used ≥ N %", a ten-minute ping-pong guard, and the switch button's own
// sequence (S3: the owner's order, walked after the active account and wrapped). Switches are now instant to dispatch —
// the credential is written and the reloads are fired in parallel, so the screen counts them down instead of the RPC
// blocking on the slowest CLI.
//
// The state that must survive a restart (the expected account, the last switch) lives in `plugin-data/agy-rotator-windows/state.json`.

type PaseoApi = PluginHandlerContext["paseo"];
const PLUGIN = "agy-rotator-windows";
const TICK_MS = 10 * 60 * 1000;
/** The session-open hook may delay a spawn by this much and no more (§3.5). */
const SESSION_OPEN_BUDGET_MS = 5_000;

const log = (line: string) => console.log(`[${PLUGIN}] ${line}`);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const nowIso = () => new Date().toISOString();

export default function contribute(server: PluginServerContext) {
  if (process.platform !== "win32") {
    log(`not loading: this plugin manages the Windows Credential Manager only (platform ${process.platform}).`);
    return () => {};
  }

  const state = emptySwitchState();
  const usage = new UsageCache(() => readUsage());
  let settings: AgyAccountsSettings = AgyAccountsSettingsSchema.parse({});
  let persisted: PluginStateFile = emptyPluginState();
  let lastCheckAt: number | null = null;
  let lastEvaluateAt: number | null = null;
  let progress: SwitchProgressView | null = null;
  let staleTerminals: { count: number; fromLabel: string | null } | null = null;
  let stopped = false;
  /** The API handle, learned from the first event: the tick has no context of its own. */
  let paseoApi: PaseoApi | null = null;
  /** One switch at a time, closed synchronously (review F-02). */
  const switchFlight = new SingleFlight();
  /** S4 (R4-6): slots whose locked pair answered `invalid_grant`. In memory; cleared by a re-save or a restart. */
  const needsSignIn = new Set<string>();
  /** The app key: scanned once per agy build, never written anywhere (AC8/R4-11). */
  const scout = new KeyScout();
  let pairing: { state: "unknown" | "locked" | "unresolved" | "unavailable" | "refused"; note: string } = { state: "unknown", note: "" };
  let lastPollAt: number | null = null;
  /** The last Clean up plan (a census spawns PowerShell, so it is computed on demand and on the tick, never on a poll). */
  let cleanup: { count: number; label: string; deletable: string[] } | null = null;

  /** S4: the live poller. Its store is read-only by type — it cannot write a credential. */
  const poller = new Poller({
    store: {
      slots: async () => (await readIndex()).map((entry) => ({ key: entry.key, label: entry.label, savedAt: entry.savedAt })),
      readBlob: (key) => realReassertDeps.loadSlot(key),
      setPolled: (key, record) => setPolled(key, record),
    },
    expectedKey: async () => state.expected?.key ?? null,
    switchInFlight: async () => switchFlight.inFlight,
    // The live slot is skipped before a refresh, and a refresh never writes the slot or the live entry — so an owner's
    // terminal (F8: the token is in its own memory) cannot be affected by polling. Kept as a hook rather than a guess.
    staleTerminalFor: async () => false,
    refresh: async (refreshToken) => {
      const keys = scout.peek();
      if (!keys || pairing.state !== "locked" || !lockedPair) return { status: 401 };
      return postRefresh({ clientId: lockedPair.id, clientSecret: lockedPair.secret, refreshToken }, { fetch, now: Date.now });
    },
    quota: (accessToken) => postQuota(accessToken, { fetch, now: Date.now }),
    needsSignIn: (key, reason) => {
      needsSignIn.add(key);
      log(`poll: slot ${key.slice(0, 6)}… needs a sign-in (${reason})`);
    },
    clientRefused: () => {
      // Its own state (Rev 5.2 / Probe 3): shown on the screen and logged ONCE, not repeated every cycle.
      if (pairing.state === "refused") return;
      pairing = { state: "refused", note: "quota endpoint refused this client" };
      log("poll: quota endpoint refused this client (a 403 - the user-agent gate)");
    },
    signInCleared: (key) => needsSignIn.delete(key),
    now: () => Date.now(),
    log,
  });
  let lockedPair: { id: string; secret: string } | null = null;

  const settingsHandle = server.registerSettings(agyAccountsSettings);
  const applySettings = (next: { status: string; values?: unknown }) => {
    if (next.status === "ready") settings = next.values as AgyAccountsSettings;
  };
  void settingsHandle.read().then(applySettings).catch(() => {});
  const stopSettings = settingsHandle.subscribe(applySettings);

  /** "Switch when used ≥ N %" → the fraction LEFT that `decide()` compares. */
  const threshold = () => thresholdFromUsedPct(settings.switchWhenUsedPct);

  // ---- Paseo-side dependencies -------------------------------------------------

  /** Every agent on the daemon (all workspaces), paged — the same shape `agent-rescue` reads. */
  async function listAgents(paseo: PaseoApi): Promise<SwitchAgent[]> {
    const out: SwitchAgent[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } } as never);
      for (const entry of res.entries) {
        const agent = entry.agent as unknown as Record<string, unknown>;
        out.push({
          id: String(agent.id),
          provider: String(agent.provider ?? ""),
          status: String(agent.status ?? ""),
          activeTurn: agent.activeTurn ?? null,
          pendingPermissions: (agent.pendingPermissions as unknown[] | null | undefined) ?? [],
          archivedAt: (agent.archivedAt as string | null | undefined) ?? null,
          title: (agent.title as string | null | undefined) ?? null,
        });
      }
      const info = res.pageInfo as { hasMore?: boolean; nextCursor?: string | null };
      if (!info?.hasMore || !info.nextCursor) break;
      cursor = info.nextCursor;
    }
    return out;
  }

  /** One timeline note. False when this build will not take it — the switch then says so instead of pretending. */
  async function noteOn(paseo: PaseoApi, agentId: string, text: string): Promise<boolean> {
    try {
      const handle = paseo.agents.ref(agentId) as unknown as { timeline?: { append?: (item: unknown) => Promise<unknown> } };
      if (typeof handle.timeline?.append !== "function") return false;
      await handle.timeline.append({
        type: "plugin",
        id: `agy-rotator-windows-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: "agy-account-switch",
        version: 1,
        data: { text },
      });
      return true;
    } catch (error) {
      log(`timeline note failed: ${errorText(error)}`);
      return false;
    }
  }

  type Deps = SwitchDeps & ReassertDeps;
  const depsFor = (paseo: PaseoApi): Deps => ({
    ...realSwitchDeps,
    ...realReassertDeps,
    listAgents: () => listAgents(paseo),
    reload: (agentId: string) => cliReload(agentId),
    note: (agentId: string, text: string) => noteOn(paseo, agentId, text),
    census: () => listAgyProcesses(),
  });

  // ---- the one payload the screen renders --------------------------------------

  async function payload() {
    const index = await readIndex();
    return buildStatePayload({
      index,
      expected: state.expected,
      signedOut: state.signedOut,
      lastCheckAt,
      nextCheckAt: lastCheckAt === null ? null : lastCheckAt + TICK_MS,
      threshold: threshold(),
      switchWhenUsedPct: settings.switchWhenUsedPct,
      autoEnabled: settings.autoSwitch,
      lastSwitchAt: persisted.lastSwitchAt,
      live: usage.peek(),
      switching: progress,
      staleTerminals,
      needsSignIn: [...needsSignIn],
      polled: Object.fromEntries((await readIndex()).map((entry) => [entry.key, entry.lastUsage?.polled ?? null])),
      livePolling: pairing,
      cleanup: cleanup === null ? null : { count: cleanup.count, label: cleanup.label },
      lastPollAt,
    });
  }

  /** A fresh `/usage` reading, remembered against the account it belongs to. */
  async function refreshUsage(refresh = true) {
    const snapshot = await usage.get({ refresh });
    lastCheckAt = Date.now();
    if (snapshot.kind === "ok" && state.expected) {
      await setSlotUsage(state.expected.key, { at: new Date(snapshot.at).toISOString(), reading: snapshot.reading }).catch((error: unknown) =>
        log(`could not store the reading: ${errorText(error)}`),
      );
    }
    if (snapshot.kind === "ok") {
      const left = (bucket: { remaining: number } | null) => (bucket === null ? "?" : `${Math.round(bucket.remaining * 100)}%`);
      log(`/usage ok: gemini 5h ${left(snapshot.reading.gemini5h)} left, weekly ${left(snapshot.reading.geminiWeekly)} left`);
    } else {
      log(`/usage: ${snapshot.kind}${snapshot.message ? ` (${snapshot.message})` : ""}`);
    }
    return snapshot;
  }

  async function persist(next: Partial<PluginStateFile>): Promise<void> {
    persisted = { ...persisted, ...next, updatedAt: nowIso() };
    await writePluginState(persisted).catch((error: unknown) => log(`could not persist state: ${errorText(error)}`));
  }

  /** How many `agy` terminals the switch left behind on the old account (F8). Never kills anything. */
  async function refreshStaleTerminals(): Promise<void> {
    const last = persisted.lastSwitch;
    if (!last) {
      staleTerminals = null;
      return;
    }
    try {
      const count = terminalStale(await listAgyProcesses(), last.at);
      staleTerminals = count === 0 ? null : { count, fromLabel: last.fromLabel };
      if (count > 0) log(`${count} agy terminal(s) still hold ${last.fromLabel ?? "the previous account"} - restart them to move`);
    } catch (error) {
      staleTerminals = null;
      log(`census failed: ${errorText(error)}`);
    }
  }

  /** The refresh token of a stored sign-in, for pairing only. Never logged, never returned to an RPC. */
  function refreshTokenOf(blob: Buffer): string | null {
    try {
      const parsed = JSON.parse(blob.toString("utf8")) as { token?: { refresh_token?: unknown } };
      const token = parsed.token?.refresh_token;
      return typeof token === "string" && token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }

  // ---- the switch, shared by the button and the rule ---------------------------

  /**
   * One switch at a time (review F-02). The flight is closed before the first await, so two triggers arriving together —
   * a turn end and a click, or two exhausted turns — cannot both write the live credential. A refusal is a value, not a
   * throw: the caller says "wait for it" instead of starting a second order.
   */
  async function startSwitch(
    key: string,
    trigger: "manual" | "auto",
    departing?: { exhausted: boolean; reading: UsageReading | null },
  ): Promise<{ ran: boolean; result?: SwitchResult }> {
    const flight = await switchFlight.run(() => runSwitch(key, trigger, departing?.exhausted === true));
    if (!flight.ran) return { ran: false };
    return { ran: true, result: flight.value };
  }

  /** Run §3.4 and report the two timings: the credential write (what the owner waits for) and the reloads. */
  async function runSwitch(
    key: string,
    trigger: "manual" | "auto",
    departingExhausted = false,
  ): Promise<SwitchResult> {
    const paseo = paseoApi;
    if (!paseo) throw new Error("Paseo is not connected yet - try again in a moment.");
    const index = await readIndex();
    const label = index.find((entry) => entry.key === key)?.label ?? key;
    const startedAt = Date.now();
    progress = { key, label, total: 0, done: 0, failed: 0, startedAt: new Date(startedAt).toISOString(), ms: null, finished: false };
    const reading = usage.peek();
    const remainingPct =
      reading?.kind === "ok" && reading.reading
        ? Math.min(
            reading.reading.gemini5h?.remaining ?? 1,
            reading.reading.geminiWeekly?.remaining ?? 1,
          ) * 100
        : null;

    // N1 (r5): the snapshot that triggered this switch travels INTO the switch, which persists it under the departing
    // slot before the live write — so a stale-high weekly on the departed slot cannot let the one hop go back.
    const snapshot = usage.peek();
    const departing = { exhausted: departingExhausted, reading: snapshot?.kind === "ok" ? snapshot.reading : null };

    let result: SwitchResult;
    try {
      result = await switchAccount({
        key,
        state,
        deps: depsFor(paseo),
        remainingPct,
        departing: state.expected === null ? undefined : departing,
        onDispatch: (ids) => {
          if (progress) progress = { ...progress, total: ids.length };
        },
      });
    } catch (error) {
      progress = progress === null ? null : { ...progress, finished: true, ms: Date.now() - startedAt };
      throw error;
    }

    const credentialMs = Date.now() - startedAt;
    if (result.dispatched.length === 0 && progress) {
      // Nothing to reload (no idle agent, or the switch failed before dispatch): stop the "in flight" state now.
      progress = { ...progress, finished: true, ms: Date.now() - startedAt };
    }
    for (const step of result.steps) log(`switch(${trigger}): ${step}`);
    log(`switch(${trigger}): credential written in ${credentialMs} ms - ${result.message}`);

    // Persist what a restart must not forget (S3): the expected account, and when the switch happened.
    if (result.ok && state.expected) {
      await persist({
        expected: state.expected,
        lastSwitchAt: state.lastCredWriteAt ?? nowIso(),
        lastSwitch: { at: state.lastCredWriteAt ?? nowIso(), fromLabel: result.from?.label ?? null, toKey: key, toLabel: label },
      });
    } else if (state.expected) {
      // R2-4: the expectation is recorded even when the read-back failed, so the next re-assert can fix it.
      await persist({ expected: state.expected });
    }

    void result.completion.then(async (done) => {
      if (progress) {
        progress = { ...progress, done: done.reloaded.length, failed: done.failed.length, finished: true, ms: done.ms };
      }
      log(
        `switch done in ${credentialMs + done.ms} ms (${done.reloaded.length}/${result.dispatched.length} agents reloaded` +
          `${done.failed.length ? `, ${done.failed.length} failed` : ""})`,
      );
      await refreshStaleTerminals();
      const settled = await refreshUsage();
      // R4-2: the post-switch check. If the account we just moved to is already at the setpoint the switch accomplished
      // nothing, so ONE more hop is allowed past the guard — `postSwitchHops` bounds it to one.
      if (settled.kind === "ok") {
        try {
          await evaluatePostSwitch(trigger);
        } catch (error) {
          log(`post-switch check failed: ${errorText(error)}`);
        }
      }
    });

    return result;
  }

  // ---- the automatic rule (§3.2/§3.3) -----------------------------------------

  /**
   * Evaluate the 80 % rule and switch if it says so. Turn ends ride the `/usage` cache TTL as their debounce (§3.2); a
   * `credits_exhausted` turn skips both the debounce and the ping-pong guard, because the account is out right now.
   */
  async function evaluate(trigger: "turn_end" | "tick", options: { outcome?: TurnOutcome; force?: boolean; snapshot?: Awaited<ReturnType<typeof refreshUsage>> } = {}): Promise<void> {
    if (stopped) return;
    const now = Date.now();
    if (!debounceElapsed(lastEvaluateAt, now, EVALUATE_GAP_MS, options.force === true)) return;
    lastEvaluateAt = now;
    lastCheckAt = lastCheckAt ?? now;

    const snapshot = options.snapshot ?? (await usage.get());
    if (snapshot.kind !== "ok") {
      log(`auto: no reading (${snapshot.kind}) - not evaluating`);
      return;
    }
    const index = await readIndex();
    const outcome = autoDecide({
      enabled: settings.autoSwitch,
      threshold: threshold(),
      active: { key: state.expected?.key ?? null, label: state.expected?.label ?? null, reading: snapshot.reading },
      slots: slotStates(index),
      outcome: options.outcome,
      lastSwitchAt: state.lastSwitchAt,
      now,
      inFlight: progress !== null && !progress.finished,
    });
    if (outcome.kind === "stay") {
      log(`auto(${trigger}): ${outcome.reason}`);
      return;
    }
    log(`auto(${trigger}): switching to ${outcome.label} - ${outcome.reason}${outcome.bypassedGuard ? " (guard bypassed)" : ""}`);
    try {
      // F-01: an exhausted departure leaves a zero behind, so the other account cannot bounce straight back here.
      const exhausted = outcome.triggeredBy.includes("credits_exhausted");
      const started = await startSwitch(outcome.key, "auto", { exhausted, reading: snapshot.reading });
      if (!started.ran) log(`auto(${trigger}): a switch is already in flight - skipped`);
    } catch (error) {
      log(`auto(${trigger}): switch failed: ${errorText(error)}`);
    }
  }

  /** Recompute what "Clean up" would delete (S4, AC11). Runs the census inside the store's queue, names only. */
  async function refreshCleanup(): Promise<void> {
    try {
      cleanup = await exclusiveWrite(async () => {
        const { entries, health } = await readIndexHealth();
        const census = await credEnumerate("paseo-agy-accounts:");
        const plan = planCleanup({
          census,
          indexKeys: entries.map((entry) => entry.key),
          health,
          protectedKeys: [state.expected?.key ?? null, persisted.lastSwitch?.toKey ?? null],
        });
        return { count: plan.deletable.length, label: cleanupLabel(plan), deletable: plan.deletable };
      });
    } catch (error) {
      cleanup = { count: 0, label: `Clean up unavailable - ${errorText(error)}`, deletable: [] };
    }
  }

  // ---- S4: the live 5-hour poll (plan §3.7, AC9/AC10) --------------------------

  /**
   * One poll cycle. The key is scanned once per agy build and paired functionally (only a 200 locks); if there is no
   * usable key, live polling is simply off and the §3.2 `/usage` readings stand — no retry loop.
   */
  async function pollCycle(): Promise<void> {
    if (stopped) return;
    try {
      const keys = await scout.keys(resolveAgyBinary());
      if (keys.changed) {
        // A new agy build: the key it will use may be a different one, so last run's pair is worthless (R4-11).
        lockedPair = null;
        pairing = { state: "unknown", note: "" };
      }
      if (pairing.state !== "locked") {
        const index = await readIndex();
        const slots = index.map((entry) => ({ key: entry.key, refreshToken: null as string | null }));
        // Pairing needs a refresh token per slot: read each blob once, here, and nowhere else.
        for (const [position, slot] of slots.entries()) {
          const blob = await realReassertDeps.loadSlot(slot.key);
          slots[position] = { key: slot.key, refreshToken: blob === null ? null : refreshTokenOf(blob) };
        }
        // Functional pairing (R4-5): only a 200 from the real token endpoint locks a pair. Nothing is written anywhere.
        const outcome = await findPairing({
          ids: keys.ids,
          secrets: keys.secrets,
          slots,
          post: async (request) => {
            const reply = await postRefresh(
              { clientId: request.id, clientSecret: request.secret, refreshToken: request.refreshToken },
              { fetch, now: Date.now },
            );
            return reply.error === undefined ? { status: reply.status } : { status: reply.status, error: reply.error };
          },
        });
        if (outcome.kind === "unavailable") {
          pairing = {
            state: "unavailable",
            note: outcome.reason === "no-secret" ? "live usage for other accounts is unavailable with this agy version" : "no app key found in agy.exe",
          };
          log(`poll: ${pairing.note}`);
          return;
        }
        if (outcome.kind === "unresolved") {
          pairing = { state: "unresolved", note: "pairing unresolved - will retry when agy changes or an account is saved again" };
          log(`poll: ${pairing.note}`);
          return;
        }
        lockedPair = outcome.pair;
        pairing = { state: "locked", note: "" };
        log(`poll: key paired (${outcome.attempts} attempt(s))`);
      }

      const result = await poller.cycle();
      lastPollAt = Date.now();
      log(
        `poll: ${result.polled.length} polled, ${result.skippedLive.length} skipped (live), ` +
          `${result.skippedOther.length} skipped (backoff/other), ${result.needsSignIn.length} need sign-in, ${result.failed.length} failed`,
      );
    } catch (error) {
      log(`poll cycle failed: ${errorText(error)}`);
    }
  }

  /** One automatic evaluation, after a switch, with the one-hop licence (R4-2). */
  async function evaluatePostSwitch(trigger: "manual" | "auto"): Promise<void> {
    const paseo = paseoApi;
    if (!paseo) return;
    const snapshot = usage.peek();
    if (!snapshot || snapshot.kind !== "ok") return;
    const index = await readIndex();
    const outcome = autoDecide({
      enabled: settings.autoSwitch,
      threshold: threshold(),
      active: { key: state.expected?.key ?? null, label: state.expected?.label ?? null, reading: snapshot.reading },
      slots: slotStates(index),
      lastSwitchAt: state.lastSwitchAt,
      now: Date.now(),
      inFlight: switchFlight.inFlight,
      postSwitch: true,
      postSwitchHops: state.postSwitchHops,
    });
    if (outcome.kind === "stay") {
      log(`post-switch(${trigger}): ${outcome.reason}`);
      return;
    }
    log(`post-switch(${trigger}): switching to ${outcome.label} - ${outcome.reason} (one hop)`);
    state.postSwitchHops += 1;
    const started = await startSwitch(outcome.key, "auto");
    if (!started.ran) log(`post-switch(${trigger}): a switch is already in flight - skipped`);
  }

  /** The slots as the rule sees them: sequence order, their own readings, and the live poll where it is fresher. */
  function slotStates(index: Awaited<ReturnType<typeof readIndex>>) {
    return index.map((entry) => ({
      key: entry.key,
      label: entry.label,
      reading: entry.lastUsage?.reading ?? null,
      readingAt: entry.lastUsage?.at ?? null,
      polled: entry.lastUsage?.polled ?? null,
      needsSignIn: needsSignIn.has(entry.key),
    }));
  }

  // ---- usage source: Paseo's own summary, served from the cache (R2-6) ---------

  server.registerUsageSource({
    id: "agy-rotator-windows",
    label: "agy accounts",
    input: z.object({ key: z.string() }).strict(),
    // Every saved account, by label. The key is the hashed email — never the email (AC7).
    discover: async () => (await readIndex()).map((entry) => ({ key: entry.key, label: entry.label, input: { key: entry.key } })),
    fetch: async (input) => {
      const key = (input as { key?: string } | null)?.key;
      const index = await readIndex();
      const entry = index.find((candidate) => candidate.key === key);
      if (!entry) return { status: "unavailable", problem: { kind: "no_quota", detail: "That account is no longer saved." } };
      if (state.expected?.key === entry.key) {
        // The active account: the last live reading, or the read already running. NEVER a new /usage spawn (R2-6).
        const snapshot = await usage.joinInFlight();
        return usageReport(snapshot?.kind === "ok" ? snapshot.reading : null);
      }
      return usageReport(entry.lastUsage?.reading ?? null);
    },
  });

  // ---- the watch: tick + turn end + session open (§3.5) ------------------------

  async function tick(): Promise<void> {
    if (stopped || !paseoApi) return;
    try {
      const agents = await listAgents(paseoApi);
      if (!agents.some(isAntigravity)) {
        log("tick: no antigravity-cli agent - nothing to check");
        return;
      }
      const snapshot = await refreshUsage();
      await evaluate("tick", { snapshot });
      const result = await reassert({ state, deps: depsFor(paseoApi) });
      log(`tick: drift=${result.kind} acted=${result.acted} - ${result.message}`);
      await refreshStaleTerminals();
      await refreshCleanup();
    } catch (error) {
      log(`tick failed: ${errorText(error)}`);
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS);
  const pollTimers: NodeJS.Timeout[] = [];

  server.on("agent.turn_ended", async (event, context) => {
    paseoApi = context.paseo;
    if (event.agent.provider !== ANTIGRAVITY_PROVIDER) return;
    try {
      const exhausted = event.outcome.kind === "failed" && event.outcome.error.code === "credits_exhausted";
      if (exhausted) log(`turn ended credits_exhausted on ${event.agent.title || event.agent.id.slice(0, 8)}`);
      // A pending agent is reloaded at its own turn end — status re-read right now, because the payload has none and a
      // queued follow-up prompt can make it running again inside this same tick (r3 note iii).
      if (state.pending.ids.includes(event.agent.id)) {
        const fresh = (await context.paseo.agents.ref(event.agent.id).refresh().catch(() => null)) as { agent?: { status?: string } } | null;
        const status = String(fresh?.agent?.status ?? "unknown");
        const folded = pendingFoldForTurnEnd(event.agent.id, status);
        for (const agentId of folded) {
          const error = await cliReload(agentId);
          log(error ? `pending reload ${agentId} failed: ${error}` : `pending reload ${agentId} ok`);
        }
      }
      await evaluate("turn_end", { outcome: event.outcome, force: exhausted });
      const result = await reassert({ state, deps: depsFor(context.paseo), agentId: event.agent.id });
      if (result.acted !== "none") log(`turn_ended: ${result.kind} - ${result.message}`);
    } catch (error) {
      log(`turn_ended failed: ${errorText(error)}`);
    }
  });

  server.on("agent.archived", (event) => {
    state.pending = pendingFold(state.pending, { kind: "archived", agentId: event.agent.id }).state;
  });
  server.on("agent.closed", (event) => {
    state.pending = pendingFold(state.pending, { kind: "closed", agentId: event.agent.id }).state;
  });

  server.before("agent.session_open", async ({ request }, context) => {
    // The hook fires for EVERY provider (measured in S1): filter to the one this plugin manages.
    if (request.provider !== ANTIGRAVITY_PROVIDER || request.purpose !== "interactive") return;
    paseoApi = context.paseo;
    // The last moment before a spawn/resume. Capped at 5 s and never rejecting: a session open must not be held up or
    // refused by this plugin (§3.5).
    const work = reassert({ state, deps: depsFor(context.paseo), agentId: request.agentId })
      .then((result) => {
        if (result.acted !== "none") log(`session_open: ${result.kind} - ${result.message}`);
      })
      .catch((error: unknown) => log(`session_open re-assert failed: ${errorText(error)}`));
    await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, SESSION_OPEN_BUDGET_MS))]);
  });

  /** The pending fold, applied to the module state (kept here so the handlers read top to bottom). */
  function pendingFoldForTurnEnd(agentId: string, status: string): string[] {
    const folded = pendingFold(state.pending, { kind: "turn_end", agent: { id: agentId, status } });
    state.pending = folded.state;
    return folded.reload;
  }

  // ---- the screen's RPCs ------------------------------------------------------

  server.handle(stateRpc, async () => payload());

  server.handle(saveRpc, async ({ label }, context) => {
    paseoApi = context.paseo;
    const live = await credRead(LIVE_TARGET);
    if (live === null) {
      return { ok: false, message: "No agy sign-in right now (signed out). Sign in with the CLI, then save.", steps: [], key: null, label: null, isNew: false };
    }
    try {
      const saved = await saveSlot(live);
      const named = label?.trim();
      if (named) await renameSlot(saved.key, named);
      state.expected = { key: saved.key, label: named || saved.label };
      state.signedOut = false;
      // A re-save is the owner's fix for a dead grant AND one of the three pairing retry triggers (R5-3).
      needsSignIn.delete(saved.key);
      poller.slotResaved(saved.key);
      pairing = pairing.state === "unresolved" ? { state: "unknown", note: "" } : pairing;
      await persist({ expected: state.expected });
      log(`saved ${state.expected.label}${saved.isNew ? " (new slot)" : ""}`);
      return { ok: true, message: `Saved ${state.expected.label}.`, steps: [], key: saved.key, label: state.expected.label, isNew: saved.isNew };
    } catch (error) {
      log(`save failed: ${errorText(error)}`);
      return { ok: false, message: `Could not save the current sign-in: ${errorText(error)}`, steps: [], key: null, label: null, isNew: false };
    }
  });

  server.handle(switchRpc, async ({ key }, context) => {
    paseoApi = context.paseo;
    if (switchFlight.inFlight) {
      log("switch(manual): refused - a switch is already running");
      const label = (await readIndex()).find((entry) => entry.key === key)?.label ?? key;
      return {
        ok: false,
        message: "A switch is already running - wait for it to finish.",
        steps: [],
        from: null,
        to: { key, label },
        reloaded: [],
        pending: state.pending.ids,
        noteFailed: false,
      };
    }
    const started = await startSwitch(key, "manual");
    if (!started.ran || !started.result) {
      return {
        ok: false,
        message: "A switch is already running - wait for it to finish.",
        steps: [],
        from: null,
        to: { key, label: key },
        reloaded: [],
        pending: state.pending.ids,
        noteFailed: false,
      };
    }
    const result = started.result;
    return {
      ok: result.ok,
      message: result.message,
      steps: result.steps,
      from: result.from,
      to: result.to,
      reloaded: result.dispatched,
      pending: result.pending,
      noteFailed: result.noteFailed,
    };
  });

  server.handle(removeRpc, async ({ key }, context) => {
    paseoApi = context.paseo;
    const index = await readIndex();
    const label = index.find((entry) => entry.key === key)?.label ?? key;
    const removed = await removeSlot(key);
    if (!removed) return { ok: false, message: `Removing ${label} failed - try again.`, steps: [] };
    if (state.expected?.key === key) {
      state.expected = null;
      await persist({ expected: null });
    }
    log(`removed ${label}`);
    return { ok: true, message: `Removed ${label}.`, steps: [] };
  });

  /** ▲ / ▼: the sequence only. No credential, no switch — the new order applies to the NEXT switch (owner, S3). */
  server.handle(reorderRpc, async ({ key, direction }) => {
    const result = await reorderSlot(key, direction);
    if (!result.moved) return { ok: false, message: direction === "up" ? "Already first." : "Already last.", steps: [] };
    log(`reordered: ${result.labels.join(" → ")}`);
    return { ok: true, message: `Now: ${result.labels.join(" → ")}`, steps: [] };
  });

  /** "Clean up N leftover entries" — the owner's press, never automatic (AC11). */
  server.handle(cleanupRpc, async () => {
    await refreshCleanup();
    const deletable = cleanup?.deletable ?? [];
    if (deletable.length === 0) return { ok: true, message: cleanup?.label ?? "No leftover entries", steps: [], deleted: 0 };
    let deleted = 0;
    for (const target of deletable) {
      try {
        if (await credDelete(target)) deleted += 1;
      } catch (error) {
        log(`cleanup: ${target.slice(0, 24)}… could not be removed: ${errorText(error)}`);
      }
    }
    await refreshCleanup();
    log(`cleanup: removed ${deleted} leftover entr${deleted === 1 ? "y" : "ies"}`);
    return { ok: true, message: `Removed ${deleted} leftover entr${deleted === 1 ? "y" : "ies"}.`, steps: [], deleted };
  });

  server.handle(checkRpc, async (_input, context) => {
    paseoApi = context.paseo;
    await refreshUsage();
    const result = await reassert({ state, deps: depsFor(context.paseo) });
    await refreshStaleTerminals();
    log(`check: drift=${result.kind} acted=${result.acted} - ${result.message}`);
    return { ok: true, message: result.message, steps: result.steps, signedOut: state.signedOut };
  });

  // ---- startup: restore what was persisted, then look at the live entry --------

  /** Learn which account is signed in WITHOUT saving a slot or writing anything (a read is always allowed). */
  async function prime(): Promise<void> {
    try {
      const live = await credRead(LIVE_TARGET);
      if (live === null) {
        state.signedOut = true;
        state.expected = null;
        log("active account: signed out (no live agy sign-in)");
        return;
      }
      const email = readBlobEmail(live.toString("utf8"));
      if (email === null) {
        log("the live agy sign-in carries no email - not adopting it");
        return;
      }
      const key = accountKey(email);
      const index = await readIndex();
      // S3: a persisted expectation wins only when it is what is actually signed in; otherwise the live entry decides and
      // the re-assert reconciles (a restart during a switch must not invent an account).
      const label = index.find((entry) => entry.key === key)?.label ?? state.expected?.label ?? unsavedLabel(key);
      state.expected = { key, label };
      state.signedOut = false;
      lastCheckAt = Date.now();
      log(`active account: ${label} (${index.length} saved slot(s))`);
      if (persisted.expected && persisted.expected.key !== key) {
        log("the persisted expectation is not what is signed in - the next check adopts the live one");
      }
      await persist({ expected: state.expected });
    } catch (error) {
      log(`could not read the live agy sign-in: ${errorText(error)}`);
    }
  }

  void (async () => {
    // The one-time rename migration (owner, 2026-10-27): the host keys plugin-data and plugin settings by plugin id, so
    // the first start under `agy-rotator-windows` would find neither. Additive, never deletes the old directory, and it
    // re-reads the settings handle so the carried setpoint applies to THIS load rather than the next one.
    const migration = await migratePluginData({ paseoHome: paseoHome(), log }).catch((error: unknown) => {
      log(`migration failed: ${errorText(error)}`);
      return { migrated: false, files: [] as string[] };
    });
    if (migration.migrated && migration.files.includes("plugin-settings/config.json")) {
      void settingsHandle.read().then(applySettings).catch(() => {});
    }
    persisted = await readPluginState();
    state.expected = persisted.expected;
    state.lastSwitchAt = persisted.lastSwitchAt === null ? null : Date.parse(persisted.lastSwitchAt);
    if (state.lastSwitchAt !== null && !Number.isFinite(state.lastSwitchAt)) state.lastSwitchAt = null;
    if (persisted.lastSwitch) log(`last switch: ${persisted.lastSwitch.fromLabel ?? "?"} → ${persisted.lastSwitch.toLabel} at ${persisted.lastSwitch.at}`);
    await prime();
    await probeCli().then((line) => log(line));
    await refreshUsage().catch((error: unknown) => log(`first /usage failed: ${errorText(error)}`));
    await refreshStaleTerminals();
    await refreshCleanup();
    void pollCycle();
    if (!stopped) {
      const pollTimer = setInterval(() => void pollCycle(), POLL_INTERVAL_MS);
      pollTimers.push(pollTimer);
    }
    log(`auto-switch: ${settings.autoSwitch ? "on" : "off"} at ≥ ${settings.switchWhenUsedPct}% used; turn-end debounce ${Math.round(EVALUATE_GAP_MS / 1000)}s, ping-pong guard 10 min`);
  })();

  log("loaded - sidebar + screen, Save / Switch / Remove / ▲▼, usage source, auto-switch on tick and turn end, re-assert on session open");

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const pollTimer of pollTimers) clearInterval(pollTimer);
    stopSettings();
  };
}
