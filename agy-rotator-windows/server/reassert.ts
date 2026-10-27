// agy-rotator-windows — the re-assert (plan §3.5), run on the 10-minute tick, on every `antigravity-cli` turn end, and in the
// `before("agent.session_open")` hook (the last moment before any spawn/resume).
//
// It reads the live entry and compares it with what the plugin expects:
//   missing entry            → the signed-out state. NO write: between the owner's `/logout` and `/login` the entry is
//                              absent (r1 F3 — logout is a local CredDeleteW), and writing into that gap would undo a
//                              sign-in that is still in progress (r3 note ii);
//   the expected account     → ok;
//   an account nobody saved  → adopt it (a slot named `unsaved-…`), NO write-back (R2-2);
//   a saved account, not the expected one, no stale writer
//                            → adopt it: the owner signed in at the CLI, and that is never reverted (R2-2);
//   a saved account, not the expected one, with an `agy.exe` older than our last CredWrite
//                            → re-assert: write the expected blob back, because that process will write the old account
//                              back at its next refresh anyway (F7/F12).
//
// An adoption is NOT a switch: it reloads nothing (r3 note i). That is structural here — this file has no reload
// dependency at all, so no path through it can reload an agent or touch the pending set.

import { createHash } from "node:crypto";
import { drift, staleWriterExists, type AgyProcess, type DriftState } from "../shared/drift.ts";
import { isAntigravity, type SwitchAgent } from "../shared/agents.ts";
import { readBlobEmail } from "../shared/slots.ts";
import { LIVE_TARGET } from "../shared/targets.ts";
import { credRead, writeLive as writeLiveCredential } from "./cred.ts";
import { accountKey } from "./key.ts";
import { loadSlot, readIndex, saveSlot, type SavedSlot } from "./store.ts";
import type { SwitchState } from "./switch.ts";

/** What the re-assert may reach. `reload` is deliberately absent — an adoption must never reload an agent. */
export interface ReassertDeps {
  readLive(target: string): Promise<Buffer | null>;
  writeLive(target: string, blob: Buffer): Promise<void>;
  loadSlot(key: string): Promise<Buffer | null>;
  saveSlot(blob: Buffer, now: string): Promise<SavedSlot>;
  index(): Promise<import("../shared/slots.ts").SlotEntry[]>;
  listAgents(): Promise<SwitchAgent[]>;
  /** The `agy.exe` census: which of the owner's own processes could still hold an older token. */
  census(): Promise<AgyProcess[]>;
  note(agentId: string, text: string): Promise<boolean>;
  now(): string;
}

export const realReassertDeps: Omit<ReassertDeps, "census" | "listAgents" | "note"> = {
  readLive: (target) => credRead(target),
  writeLive: (target, blob) => writeLiveCredential(target, blob),
  loadSlot: (key) => loadSlot(key),
  saveSlot: (blob, now) => saveSlot(blob, now),
  index: () => readIndex(),
  now: () => new Date().toISOString(),
};

export interface ReassertOptions {
  state: SwitchState;
  liveTarget?: string;
  deps?: Partial<ReassertDeps>;
  /** The agent whose session open / turn end triggered this, for the note. Left out on a tick. */
  agentId?: string;
}

export interface ReassertResult {
  /** The drift decision, or `unreadable` when the live blob carries no email we could key. */
  kind: DriftState | "unreadable";
  acted: "none" | "adopted" | "reasserted";
  /** One line for the owner/log: labels only. */
  message: string;
  steps: string[];
  expected: SwitchState["expected"];
  /** A re-assert that did not read back identical says so instead of pretending. */
  readBackIdentical: boolean | null;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export async function reassert(options: ReassertOptions): Promise<ReassertResult> {
  const { state } = options;
  const liveTarget = options.liveTarget ?? LIVE_TARGET;
  const deps: ReassertDeps = { ...realReassertDeps, census: async () => [], listAgents: async () => [], note: async () => false, ...options.deps };
  const steps: string[] = [];
  const result = (kind: ReassertResult["kind"], acted: ReassertResult["acted"], message: string, readBackIdentical: boolean | null = null): ReassertResult => ({
    kind,
    acted,
    message,
    steps,
    expected: state.expected,
    readBackIdentical,
  });

  // (1) the live entry.
  const live = await deps.readLive(liveTarget);
  if (live === null) {
    state.signedOut = true;
    steps.push("live entry missing - signed out, nothing written");
    return result("signed-out", "none", "Signed out: no live agy sign-in, so there is nothing to check.");
  }
  state.signedOut = false;

  // (2) key it by the blob's own email. A blob with no email is not evidence of anything: neither adopt nor revert.
  const email = readBlobEmail(live.toString("utf8"));
  if (email === null) {
    steps.push("the live entry has no id_token_email - left untouched");
    return result("unreadable", "none", "The live agy sign-in has no email in it, so the plugin cannot tell whose it is.");
  }
  const liveKey = accountKey(email);

  // (3) decide.
  const index = await deps.index();
  const processes = await deps.census();
  const stale = staleWriterExists(processes, state.lastCredWriteAt);
  const wasPrimed = state.expected !== null;
  const decision = drift(liveKey, state.expected?.key ?? null, index.map((entry) => entry.key), stale);
  steps.push(`drift=${decision} (staleWriter=${stale}, ${processes.length} agy.exe)`);

  const note = async (text: string): Promise<void> => {
    const agentId = options.agentId ?? (await deps.listAgents()).filter(isAntigravity)[0]?.id;
    if (!agentId) {
      steps.push(`no antigravity-cli agent to note on: ${text}`);
      return;
    }
    const written = await deps.note(agentId, text);
    steps.push(written ? `noted on ${agentId}: ${text}` : `timeline note unavailable on this Paseo build: ${text}`);
  };

  switch (decision) {
    case "ok":
      steps.push(`active is ${state.expected?.label ?? liveKey}`);
      return result("ok", "none", `Active account is still ${state.expected?.label ?? liveKey}.`);

    case "adopt-unknown": {
      // The owner signed in an account nobody saved. Save it under its own key, adopt it, write nothing back.
      const saved = await deps.saveSlot(live, deps.now());
      state.expected = { key: saved.key, label: saved.label };
      steps.push(`adopted ${saved.label} (new slot)`);
      await note(`active appears to be ${saved.label} (no writer found) - will re-evaluate; name it in agy accounts`);
      return result("adopt-unknown", "adopted", `Active account is ${saved.label} - a sign-in this plugin has not seen before. Name it in agy accounts.`);
    }

    case "adopt-known": {
      // An owner `/login` at the CLI, or this plugin's first look. Honour it; never reload (r3 note i).
      const label = index.find((entry) => entry.key === liveKey)?.label ?? liveKey;
      state.expected = { key: liveKey, label };
      steps.push(`adopted ${label}${wasPrimed ? "" : " (first look)"}`);
      await note(wasPrimed ? `active is now ${label} (signed in by hand) - not reverting` : `active is ${label}`);
      return result("adopt-known", "adopted", `Active account is ${label}${wasPrimed ? " (signed in by hand)" : ""}.`);
    }

    case "reassert": {
      const expected = state.expected;
      if (!expected) {
        // Unreachable: `drift` only answers `reassert` with an expectation. Kept so a future edit cannot reach a write.
        steps.push("reassert without an expectation - refused");
        return result("reassert", "none", "Nothing to re-assert.");
      }
      const blob = await deps.loadSlot(expected.key);
      if (blob === null) {
        // The expected slot's credential is gone: write nothing, adopt what is live instead of guessing.
        const label = index.find((entry) => entry.key === liveKey)?.label ?? liveKey;
        state.expected = { key: liveKey, label };
        steps.push(`${expected.label} has no saved credential - adopted ${label} instead`);
        await note(`active is ${label} (${expected.label}'s saved sign-in is gone)`);
        return result("adopt-known", "adopted", `Active account is ${label}: ${expected.label} has no saved credential any more.`);
      }
      await deps.writeLive(liveTarget, blob);
      state.lastCredWriteAt = deps.now();
      steps.push(`wrote ${expected.label} back to the live entry`);
      const back = await deps.readLive(liveTarget);
      const identical = back !== null && sha256(back) === sha256(blob);
      steps.push(identical ? "read back the live entry: identical bytes" : "read back the live entry: BYTES DIFFER");
      const liveLabel = index.find((entry) => entry.key === liveKey)?.label ?? liveKey;
      await note(`restored ${expected.label} (a running agy.exe had written ${liveLabel} back)`);
      return result(
        "reassert",
        identical ? "reasserted" : "none",
        identical
          ? `Wrote ${expected.label} back: an older agy.exe had replaced it with ${liveLabel}.`
          : `Tried to restore ${expected.label}, but the live entry did not read back identical.`,
        identical,
      );
    }

    default:
      steps.push(`drift=${decision}: nothing to do`);
      return result("signed-out", "none", "Signed out.");
  }
}
