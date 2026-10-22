import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  AgentRescueSettingsSchema,
  agentRescueSettings,
  listStuckRpc,
  reloadRpc,
  restartProviderRpc,
  type AgentRescueSettings,
  type RescueResult,
} from "./shared/contracts";
import { blockers, matchProviderProcesses, rescueState } from "./shared/rescue";
import { cliReload, getAgent, killTree, listAgents, listProcesses, sleep } from "./server/ops";

// agent-rescue — rescue an agent whose session died.
// Reload a stuck agent; if that cannot work, restart its provider's ACP processes (only when no sibling is busy)
// and reload every agent of that provider. Nothing runs on its own: every action is a click.

type PaseoApi = PluginHandlerContext["paseo"];
const DEFAULTS = AgentRescueSettingsSchema.parse({});
const POLL_MS = 3_000;
const SETTLE_MS = 120_000;
const RETRY_AFTER_CLOSE_TIMEOUT_MS = 5_000;

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(agentRescueSettings);
  let settings: AgentRescueSettings = DEFAULTS;
  const apply = (state: { status: string; values?: unknown }) => {
    settings = state.status === "ready" ? (state.values as AgentRescueSettings) : DEFAULTS;
  };
  void settingsHandle.read().then(apply).catch(() => {});
  const stopSettings = settingsHandle.subscribe(apply);

  /** Agent ids with an action in flight, and whether a provider restart is running. */
  const busy = new Set<string>();
  let restarting: string | null = null;
  let lastListKey: string | null = null;

  const log = (agentId: string, steps: string[], line: string) => {
    steps.push(line);
    console.log(`[agent-rescue] [${agentId}] ${line}`);
  };

  /** Wait until the agent leaves closed/initializing, up to SETTLE_MS. */
  async function settle(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const deadline = Date.now() + SETTLE_MS;
    let status: string | null = null;
    while (Date.now() < deadline) {
      status = (await getAgent(paseo, agentId).catch(() => null))?.status ?? null;
      if (status && status !== "closed" && status !== "initializing") return status;
      await sleep(POLL_MS);
    }
    return status;
  }

  /** the first reload against a dead provider fails by design; retry once, then wait it out. */
  async function reloadFlow(paseo: PaseoApi, agentId: string, steps: string[]): Promise<RescueResult> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(agentId, steps, `reload attempt ${attempt}`);
      const error = await cliReload(agentId);
      if (!error) {
        const status = await settle(paseo, agentId);
        log(agentId, steps, `reload ok, status ${status}`);
        return { ok: status === "idle" || status === "running", message: `Reloaded - agent is ${status}`, status, steps };
      }
      log(agentId, steps, `reload error: ${error}`);
      if (/Timed out closing previous session/i.test(error) && attempt === 1) {
        await sleep(RETRY_AFTER_CLOSE_TIMEOUT_MS);
        continue;
      }
      if (/Timeout waiting for message|did not answer in time/i.test(error)) {
        // The daemon is still working on it after the client gave up; see where it lands.
        const status = await settle(paseo, agentId);
        log(agentId, steps, `after client timeout the agent is ${status}`);
        const ok = status === "idle" || status === "running";
        return { ok, message: ok ? `Reloaded (slowly) - agent is ${status}` : `Reload did not finish - agent is ${status}`, status, steps };
      }
      break;
    }
    const status = (await getAgent(paseo, agentId).catch(() => null))?.status ?? null;
    return { ok: false, message: `Reload failed - ${steps[steps.length - 1]}`, status, steps };
  }

  async function guarded<T extends RescueResult>(agentId: string, fn: () => Promise<T>): Promise<RescueResult> {
    if (busy.has(agentId)) return { ok: false, message: "An action is already running for this agent.", status: null, steps: [] };
    busy.add(agentId);
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[agent-rescue] [${agentId}] failed: ${message}`);
      return { ok: false, message, status: null, steps: [message] };
    } finally {
      busy.delete(agentId);
    }
  }

  server.handle(listStuckRpc, async (_input, { paseo }) => {
    const agents = await listAgents(paseo);
    const stuck = agents
      .map((a) => ({ a, state: rescueState(a, settings.patterns) }))
      .filter((x) => x.state !== "ok")
      .map(({ a, state }) => ({
        id: a.id,
        title: a.title ?? null,
        provider: a.provider,
        workspaceId: a.workspaceId,
        cwd: a.cwd,
        state: state as "stuck" | "reloading",
        lastError: a.lastError ?? "",
        canRestart: process.platform === "win32" && Boolean(settings.providerProcesses[a.provider]),
      }));
    const key = stuck.map((s) => `${s.id.slice(0, 8)}:${s.state}`).join(",");
    if (key !== lastListKey) {
      const errored = agents.filter((a) => a.status === "error").length;
      console.log(`[agent-rescue] scanned ${agents.length} agents (${errored} in error): stuck = [${key}]`);
      lastListKey = key;
    }
    return { agents: stuck, patterns: settings.patterns, busy: [...busy] };
  });

  server.handle(reloadRpc, ({ agentId }, { paseo }) =>
    guarded(agentId, async () => {
      const steps: string[] = [];
      const agent = await getAgent(paseo, agentId);
      if (!agent) return { ok: false, message: "Agent no longer exists.", status: null, steps };
      if (agent.status === "running" || agent.activeTurn) {
        return { ok: false, message: "Agent is running - not reloading it.", status: agent.status, steps };
      }
      if (agent.status === "closed") {
        return { ok: false, message: "A reload is already in progress for this agent - wait for it.", status: agent.status, steps };
      }
      return reloadFlow(paseo, agentId, steps);
    }),
  );

  server.handle(restartProviderRpc, ({ agentId }, { paseo }) =>
    guarded(agentId, async () => {
      const steps: string[] = [];
      const agent = await getAgent(paseo, agentId);
      if (!agent) return { ok: false, message: "Agent no longer exists.", status: null, steps };
      const proc = settings.providerProcesses[agent.provider];
      if (!proc) return { ok: false, message: `No process pattern configured for provider ${agent.provider}.`, status: agent.status, steps };
      if (restarting) return { ok: false, message: `A restart of ${restarting} is already running.`, status: agent.status, steps };
      restarting = agent.provider;
      try {
        const check = async () => blockers(await listAgents(paseo), agent.provider, agentId);
        const names = (list: { id: string; title?: string | null }[]) => list.map((b) => b.title || b.id.slice(0, 8)).join(", ");
        let busyNow = await check();
        if (busyNow.length) {
          log(agentId, steps, `refused: busy ${agent.provider} agents: ${names(busyNow)}`);
          return { ok: false, message: `Not restarting - these ${agent.provider} agents are busy: ${names(busyNow)}. Wait for them.`, status: agent.status, steps };
        }
        const procs = matchProviderProcesses(await listProcesses(proc.name), proc.pattern, process.ppid);
        log(agentId, steps, `found ${procs.length} ${proc.name} process(es): ${procs.map((p) => p.pid).join(", ") || "none"}`);
        // Re-check right before the kill: the process query takes ~1 s.
        busyNow = await check();
        if (busyNow.length) {
          log(agentId, steps, `refused at kill time: busy: ${names(busyNow)}`);
          return { ok: false, message: `Not restarting - ${names(busyNow)} became busy.`, status: agent.status, steps };
        }
        for (const p of procs) {
          const err = await killTree(p.pid);
          log(agentId, steps, err ? `taskkill ${p.pid} failed: ${err}` : `stopped ${p.pid}`);
        }
        await sleep(2_000);
        const result = await reloadFlow(paseo, agentId, steps);
        // Idle siblings keep a dead connection and fail on their next message: reload them too.
        const siblings = (await listAgents(paseo)).filter((a) => a.provider === agent.provider && a.id !== agentId);
        for (const s of siblings) {
          if (s.status === "running" || s.activeTurn) {
            log(agentId, steps, `sibling ${s.title || s.id} is running - left alone`);
            continue;
          }
          const err = await cliReload(s.id);
          log(agentId, steps, err ? `sibling ${s.title || s.id} reload error: ${err}` : `sibling ${s.title || s.id} reloaded`);
        }
        return { ...result, message: `${result.message} (stopped ${procs.length} process(es), reloaded ${siblings.length} sibling(s))` };
      } finally {
        restarting = null;
      }
    }),
  );

  return () => {
    stopSettings();
  };
}
