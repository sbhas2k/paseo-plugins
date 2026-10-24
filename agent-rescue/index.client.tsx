import type { PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { RescueSurface } from "./client/surface";
import { listStuckRpc, reloadRpc, restartProviderRpc, type StuckAgent } from "./shared/contracts";

// agent-rescue — a "Stuck" composer pill on an agent whose session is dead (lastError matches a pattern while the
// agent is in error), plus a sidebar page listing every such agent.
// The server decides who is stuck (settings patterns), so the pill and the page always agree.

const POLL_MS = 10_000;
const SURFACE_ID = "agent-rescue";

function RescueItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="LifeBuoy" active={currentScreen?.screenId === SURFACE_ID} onPress={() => openScreen({ screenId: SURFACE_ID })} />;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lastResult = new Map<string, string>();
  const running = new Set<string>();

  const title = (a: StuckAgent) => {
    if (running.has(a.id)) return "Agent Rescue: working...";
    const result = lastResult.get(a.id);
    const head = a.state === "reloading" ? "Reload in progress" : `Stuck: ${a.lastError}`;
    return result ? `${head}\nLast action: ${result}` : head;
  };

  const act = async (a: StuckAgent, kind: "reload" | "restart") => {
    running.add(a.id);
    poll();
    try {
      const result = await client.rpc(kind === "reload" ? reloadRpc : restartProviderRpc, { agentId: a.id });
      lastResult.set(a.id, result.message);
    } catch (error) {
      lastResult.set(a.id, error instanceof Error ? error.message : String(error));
    } finally {
      running.delete(a.id);
      poll();
    }
  };

  const button = (a: StuckAgent) => ({
    label: running.has(a.id) ? "Rescuing..." : a.state === "reloading" ? "Reloading" : "Stuck",
    icon: "LifeBuoy",
    title: title(a),
    disabled: running.has(a.id) || a.state === "reloading",
    behavior: {
      kind: "menu" as const,
      items: [
        { kind: "item" as const, id: "reload", title: "Reload agent", icon: "RefreshCw", behavior: { kind: "action" as const, onPress: () => act(a, "reload") } },
        {
          kind: "item" as const,
          id: "restart",
          title: `Restart ${a.provider} processes, then reload`,
          icon: "Power",
          visible: a.canRestart,
          behavior: { kind: "action" as const, onPress: () => act(a, "restart") },
        },
      ],
    },
  });

  const sync = (agents: StuckAgent[]) => {
    const seen = new Set<string>();
    for (const a of agents) {
      if (!a.workspaceId) continue;
      seen.add(a.id);
      const existing = pills.get(a.id);
      if (existing) existing.update(button(a));
      else pills.set(a.id, client.addComposerPill({ id: "agent-rescue-pill", workspaceId: a.workspaceId, agentId: a.id, button: button(a) }));
    }
    for (const [id, pill] of pills) {
      if (seen.has(id) || running.has(id)) continue;
      pill.remove();
      pills.delete(id);
    }
  };

  let stopped = false;
  function poll() {
    if (stopped) return;
    client.rpc(listStuckRpc, {}).then(({ agents }) => !stopped && sync(agents)).catch(() => {});
  }
  poll();
  const timer = setInterval(poll, POLL_MS);

  const removers = [
    client.addScreen({ id: SURFACE_ID, title: "Agent Rescue", Component: RescueSurface }),
    client.addSidebarHeaderItem({ id: "rescue", title: "Agent Rescue", Component: RescueItem }),
  ];

  return () => {
    stopped = true;
    clearInterval(timer);
    for (const pill of pills.values()) pill.remove();
    pills.clear();
    for (const remove of removers) if (typeof remove === "function") void remove();
  };
}
