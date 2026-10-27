// agy-rotator-windows — the switch (plan §3.4), in the order the plan fixes, with every side effect injected.
//
//   (a) read the live entry and save it to the slot of ITS OWN email — it may hold a refreshed token (F7);
//   (b) write the target slot's blob to the live entry;
//   (R2-4) record the expected account IMMEDIATELY after (b), before any further await, so a `turn_ended` or a
//          `before(session_open)` re-assert that lands during the reloads cannot compare against the old expectation and
//          write the old account back;
//   (b2) read the entry back once — not for the race, for a failed `CredWrite` (a write that silently did not land is
//          this project's dominant defect class);
//   (c) reload every IDLE `antigravity-cli` agent now; queue the busy ones for their own turn end;
//   (d) one timeline note per affected agent, by LABEL only — never an email, never a token (AC7).
//
// Nothing here reaches a live system by itself: `deps` carries the credential calls, the agent list, the CLI reload and
// the note, and `liveTarget` is a parameter, so the integration test runs the real sequence against throwaway targets.

import { createHash } from "node:crypto";
import { partitionAgents, agentLabel, type SwitchAgent } from "../shared/agents.ts";
import { exhaustedReading } from "../shared/auto.ts";
import { emptyPending, pendingFold, type PendingState } from "../shared/pending.ts";
import type { UsageReading } from "../shared/usage.ts";
import { LIVE_TARGET } from "../shared/targets.ts";
import type { SlotEntry } from "../shared/slots.ts";
import { credRead, writeLive as writeLiveCredential } from "./cred.ts";
import { loadSlot, readIndex, saveSlot, setSlotUsage, type SavedSlot } from "./store.ts";

export type { SwitchAgent } from "../shared/agents.ts";

/** Everything the sequence touches, injected so the same code runs in tests and in the daemon. */
export interface SwitchDeps {
  readLive(target: string): Promise<Buffer | null>;
  writeLive(target: string, blob: Buffer): Promise<void>;
  loadSlot(key: string): Promise<Buffer | null>;
  saveSlot(blob: Buffer, now: string): Promise<SavedSlot>;
  /** Remember a slot's reading (index only) — used to write down an exhausted departure (F-01). */
  setSlotUsage(key: string, lastUsage: SlotEntry["lastUsage"]): Promise<void>;
  index(): Promise<SlotEntry[]>;
  listAgents(): Promise<SwitchAgent[]>;
  /** `paseo agent reload <id>`; null on success, else the error text. */
  reload(agentId: string): Promise<string | null>;
  /** A timeline note on one agent; false when this Paseo build would not take it. */
  note(agentId: string, text: string): Promise<boolean>;
  now(): string;
}

/** What the plugin remembers between events: the account it expects to be active, and who is waiting to be reloaded. */
export interface SwitchState {
  expected: { key: string; label: string } | null;
  pending: PendingState;
  /** Set when the live entry was missing (an owner's `/logout`): a state, never a drift (r3 note ii). */
  signedOut: boolean;
  /** When this plugin last wrote the live entry — the reference the stale-writer census compares against. */
  lastCredWriteAt: string | null;
  /** Epoch ms of the last switch, manual or automatic: the ping-pong guard's input (S3). */
  lastSwitchAt: number | null;
  /**
   * S4 (R4-2): how many post-switch hops have been spent since the last ordinary trigger. One extra hop is allowed after
   * a switch whose new account is already at the setpoint; this counter is what stops a third.
   */
  postSwitchHops: number;
}

export const emptySwitchState = (): SwitchState => ({
  expected: null,
  pending: emptyPending(),
  signedOut: false,
  lastCredWriteAt: null,
  lastSwitchAt: null,
  postSwitchHops: 0,
});

export interface SwitchResult {
  ok: boolean;
  /** One line for the owner: labels only. */
  message: string;
  /** Every step in the order it happened — the same lines go to the daemon log. */
  steps: string[];
  from: { key: string; label: string } | null;
  to: { key: string; label: string };
  /** Agents whose reload was dispatched before this RPC answered (S3: the call returns immediately). */
  dispatched: string[];
  /** Agents queued for their own turn end. */
  pending: string[];
  /** True when there were affected agents and the timeline refused the note. */
  noteFailed: boolean;
  /** Resolves when the CLI reloads have settled — the RPC does not wait for it (S3, plan §3.4 "switches must feel immediate"). */
  completion: Promise<SwitchCompletion>;
}

/** What the parallel reloads ended up doing. */
export interface SwitchCompletion {
  reloaded: string[];
  failed: Array<{ id: string; error: string }>;
  /** Milliseconds from the dispatch to the last reload settling. */
  ms: number;
}

export interface SwitchOptions {
  /** The slot to switch to. */
  key: string;
  /** Defaults to `gemini:antigravity`; the tests point it at a throwaway target. */
  liveTarget?: string;
  state: SwitchState;
  /** Anything left out falls back to the real dependency — only the tests leave fields out. */
  deps?: Partial<SwitchDeps>;
  /** Shown in the note when the active account's quota was already read ("at 18% left"). */
  remainingPct?: number | null;
  /** Called with the agent ids whose reload is about to be dispatched, before any of them finishes. */
  onDispatch?: (agentIds: readonly string[]) => void;
  /**
   * The account we are leaving, and the reading that triggered the switch (N1, r5). That snapshot is persisted under the
   * departing slot FIRST — a stale-high weekly left there would let the one post-switch hop go straight back to the
   * account we just left. When the departure was `credits_exhausted`, both Gemini buckets are written as zero as well, so
   * the rule cannot bounce back on the other account's next failed turn (review F-01).
   */
  departing?: { exhausted: boolean; reading: UsageReading | null };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The real dependencies, minus the three that need the daemon (`listAgents`, `reload`, `note`): the server passes those
 * in, because a switch that quietly reloaded nothing while reporting success is exactly the defect class this project
 * produces. `switchAccount` is never called without them outside tests.
 */
export const realSwitchDeps: SwitchDeps = {
  readLive: (target) => credRead(target),
  writeLive: (target, blob) => writeLiveCredential(target, blob),
  loadSlot: (key) => loadSlot(key),
  saveSlot: (blob, now) => saveSlot(blob, now),
  setSlotUsage: (key, lastUsage) => setSlotUsage(key, lastUsage),
  index: () => readIndex(),
  listAgents: async () => [],
  reload: async () => "reload is not wired to Paseo",
  note: async () => false,
  now: () => new Date().toISOString(),
};

export async function switchAccount(options: SwitchOptions): Promise<SwitchResult> {
  const { key, state } = options;
  const deps: SwitchDeps = { ...realSwitchDeps, ...options.deps };
  const liveTarget = options.liveTarget ?? LIVE_TARGET;
  const steps: string[] = [];
  const index = await deps.index();
  const target = index.find((entry) => entry.key === key);
  if (!target) {
    return {
      ok: false,
      message: "That account is not saved any more - refresh the list.",
      steps,
      from: null,
      to: { key, label: key },
      dispatched: [],
      pending: state.pending.ids,
      noteFailed: false,
      completion: Promise.resolve({ reloaded: [], failed: [], ms: 0 }),
    };
  }

  // (a) save what is live NOW to the slot of its own email — the blob may carry a refreshed token.
  let from: { key: string; label: string } | null = null;
  const live = await deps.readLive(liveTarget);
  if (live !== null) {
    try {
      const saved = await deps.saveSlot(live, deps.now());
      from = { key: saved.key, label: saved.label };
      steps.push(`saved the live sign-in to ${saved.label}${saved.isNew ? " (new slot)" : ""}`);
      state.signedOut = false;
    } catch (error) {
      // No id_token_email in the live blob: nothing to save, and nothing to name in the note.
      steps.push(`the live sign-in could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    // r3 note ii: the live entry is missing. A user-initiated switch may still restore a slot.
    state.signedOut = true;
    steps.push("the live entry is missing (signed out) - writing the slot anyway");
  }

  // (a2) The departure is written down before (b) (N1), so the live entry never names an account whose slot still claims
  // the room a stale reading showed. An exhausted departure is additionally zeroed on both Gemini buckets (review F-01).
  if (options.departing && from !== null) {
    const at = deps.now();
    const reading = options.departing.exhausted
      ? exhaustedReading(options.departing.reading, Date.parse(at))
      : options.departing.reading;
    await deps.setSlotUsage(from.key, { at, reading });
    steps.push(
      options.departing.exhausted
        ? `recorded ${from.label} as exhausted (both Gemini buckets at 0 until their resets)`
        : `recorded ${from.label}'s reading before leaving it`,
    );
  }

  // (b) the target's blob goes into the live entry.
  const blob = await deps.loadSlot(key);
  if (blob === null) {
    steps.push(`slot ${target.label} has no credential in the Credential Manager`);
    return {
      ok: false,
      message: `${target.label} has no saved credential any more - save it again.`,
      steps,
      from,
      to: { key, label: target.label },
      dispatched: [],
      pending: state.pending.ids,
      noteFailed: false,
      completion: Promise.resolve({ reloaded: [], failed: [], ms: 0 }),
    };
  }
  await deps.writeLive(liveTarget, blob);

  // R2-4: before ANY further await.
  state.expected = { key, label: target.label };
  state.lastCredWriteAt = deps.now();
  // The guard counts a switch from the moment the credential was written, not from when the reloads settle: a slow CLI
  // must not leave a window in which a second automatic switch could start.
  state.lastSwitchAt = Date.parse(state.lastCredWriteAt);
  steps.push(`recorded expected account ${target.label}`);

  // (b2) read it back once: a `CredWrite` that did not land must not look like a switch.
  const back = await deps.readLive(liveTarget);
  const identical = back !== null && sha256(back) === sha256(blob);
  steps.push(identical ? "read back the live entry: identical bytes" : "read back the live entry: BYTES DIFFER");

  // (c) reload every idle agent IN PARALLEL, and do not wait for them: the credential is written, so the switch has
  // happened. Each CLI reload takes seconds (client timeout 60 s, backstop 90 s), and the owner's complaint was that
  // switching "takes time" — the screen now counts them down instead of the RPC blocking on the slowest one.
  const agents = await deps.listAgents();
  const { idle, busy } = partitionAgents(agents);
  const folded = pendingFold(state.pending, { kind: "switch", idle, busy });
  state.pending = folded.state;
  const dispatched = [...folded.reload];
  for (const agentId of busy) steps.push(`queued ${agentId} (busy - reloaded at its own turn end)`);
  steps.push(dispatched.length === 0 ? "no idle agent to reload" : `dispatched reload for ${dispatched.length} agent(s)`);
  options.onDispatch?.(dispatched);
  const reloadStarted = Date.now();
  const completion = Promise.allSettled(dispatched.map((agentId) => deps.reload(agentId).then((error) => ({ agentId, error })))).then((settled) => {
    const reloaded: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const entry of settled) {
      if (entry.status === "rejected") {
        failed.push({ id: "unknown", error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) });
        continue;
      }
      const { agentId, error } = entry.value;
      if (error) {
        failed.push({ id: agentId, error });
        steps.push(`reload ${agentId} failed: ${error}`);
      } else {
        reloaded.push(agentId);
        steps.push(`reload ${agentId} ok`);
      }
    }
    return { reloaded, failed, ms: Date.now() - reloadStarted };
  });

  // (d) one note per affected agent: labels only.
  const fromLabel = from?.label ?? "signed out";
  const used = options.remainingPct === undefined || options.remainingPct === null ? "" : ` at ${Math.round(options.remainingPct)}% left`;
  const noteText = `agy account ${fromLabel} → ${target.label}${used}`;
  const affected = new Set([...dispatched, ...busy]);
  const noted = await Promise.allSettled([...affected].map((agentId) => deps.note(agentId, noteText)));
  const noteFailed = noted.some((result) => result.status === "rejected" || result.value === false);
  steps.push(noteFailed ? "timeline note unavailable on this Paseo build - the switch itself stands" : `timeline note on ${affected.size} agent(s)`);

  const titles = new Map(agents.map((agent) => [agent.id, agentLabel(agent)]));
  const named = dispatched.map((id) => titles.get(id) ?? id);
  return {
    ok: identical,
    message: identical
      ? `Switched to ${target.label}. ${named.length ? `Reloading ${named.join(", ")}…` : "No idle agent to reload."}${
          busy.length ? ` ${busy.length} busy agent(s) will reload at their turn end.` : ""
        }`
      : `Wrote ${target.label} but the live entry did not read back identical - not reloading anything.`,
    steps,
    from,
    to: { key, label: target.label },
    dispatched,
    pending: [...busy],
    noteFailed,
    completion,
  };
}
