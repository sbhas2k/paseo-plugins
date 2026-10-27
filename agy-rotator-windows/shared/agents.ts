// agy-rotator-windows — which agents a switch touches, and whether they may be reloaded now (plan §3.4(c), r3 note iii).
//
// A Paseo `agent reload` kills and respawns the provider process, so reloading a BUSY agent kills its turn. The rule is
// therefore: reload the idle `antigravity-cli` agents now, queue the busy ones and reload each at its own turn end.
// Archived agents are not the plugin's business at all.
//
// Pure: no Paseo, no `node:` import — it is bundled into the plugin's shared bundle.

export const ANTIGRAVITY_PROVIDER = "antigravity-cli";

/** The fields this plugin reads off an agent snapshot (the SDK's `PluginHookAgent` plus the live status). */
export interface SwitchAgent {
  id: string;
  provider: string;
  status: string;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
  archivedAt?: string | null;
  title?: string | null;
}

/** An `antigravity-cli` agent that has not been archived. */
export function isAntigravity(agent: SwitchAgent): boolean {
  return agent.provider === ANTIGRAVITY_PROVIDER && !agent.archivedAt;
}

/**
 * A turn is in flight, or about to be: `running`, `initializing`, or an `activeTurn` on an agent the daemon still calls
 * idle. `pendingPermissions` counts as busy too — the owner is looking at a question, and a reload would lose it.
 */
export function isBusy(agent: SwitchAgent): boolean {
  if (agent.status === "running" || agent.status === "initializing") return true;
  if (agent.activeTurn) return true;
  return (agent.pendingPermissions?.length ?? 0) > 0;
}

/** Split the `antigravity-cli` agents into who is reloaded now and who waits for its own turn end. */
export function partitionAgents(agents: readonly SwitchAgent[]): { idle: string[]; busy: string[] } {
  const idle: string[] = [];
  const busy: string[] = [];
  for (const agent of agents.filter(isAntigravity)) (isBusy(agent) ? busy : idle).push(agent.id);
  return { idle, busy };
}

/** How an agent is named in a note or a log line: its title, else a short id. Never anything account-shaped. */
export function agentLabel(agent: SwitchAgent): string {
  const title = agent.title?.trim();
  return title && title.length > 0 ? title : agent.id.slice(0, 8);
}
