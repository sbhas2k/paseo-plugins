// agy-rotator-windows — the pending set as a pure fold over the events that change it (plan §3.4/R2-5).
//
// A switch reloads every IDLE `antigravity-cli` agent immediately and cannot wait for the busy ones: a running turn
// must finish on whatever token it holds (reloading it would kill the turn). A busy agent is queued here and reloaded
// at its OWN turn end — and only if it is idle at that moment (r3 note iii), because a queued follow-up prompt can make
// it running again within the same tick.
//
// The set is REPLACED by a newer switch, never merged: the newest switch owns the queue, so an agent queued by an
// older switch can never be reloaded for an account that is no longer active.

export interface PendingState {
  ids: string[];
}

export interface PendingAgentRef {
  id: string;
  /** Read fresh by the caller right before the reload (r3 note iii). */
  status: string;
}

export type PendingEvent =
  | { kind: "switch"; idle: readonly string[]; busy: readonly string[] }
  | { kind: "archived"; agentId: string }
  | { kind: "closed"; agentId: string }
  | { kind: "turn_end"; agent: PendingAgentRef };

export interface PendingOutcome {
  state: PendingState;
  /** Agents to reload now, in order. */
  reload: string[];
}

export const emptyPending = (): PendingState => ({ ids: [] });

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/** One event → the new set and what to reload. Never mutates `state`. */
export function pendingFold(state: PendingState, event: PendingEvent): PendingOutcome {
  switch (event.kind) {
    case "switch":
      return { state: { ids: unique(event.busy) }, reload: unique(event.idle) };
    case "archived":
    case "closed":
      return { state: { ids: state.ids.filter((id) => id !== event.agentId) }, reload: [] };
    case "turn_end": {
      if (!state.ids.includes(event.agent.id)) return { state, reload: [] };
      // Only an idle agent may be reloaded; a running one stays queued for its next turn end.
      if (event.agent.status !== "idle") return { state, reload: [] };
      return { state: { ids: state.ids.filter((id) => id !== event.agent.id) }, reload: [event.agent.id] };
    }
  }
}
