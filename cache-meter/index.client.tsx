import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { getCacheRpc, type CacheFigure } from "./shared/card";

const POLL_MS = 15_000;
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(1)}%`);
/** Turn-end time in the viewing device's own time zone, e.g. "11:47". */
const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const short = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v)}%`);

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  const pills = new Map<string, { update: (p: any) => void; remove: () => void }>();
  const figures = new Map<string, CacheFigure>();

  function Popover(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    const f = figures.get(props.agentId);
    const { theme } = props;
    return (
      <View style={{ padding: 10, gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{`Last turn: ${fmt(f?.turnPct)}`}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{`This session: ${fmt(f?.sessionPct)}`}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{`All agents: ${fmt(f?.overallPct)}`}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {f ? `last reply ended ${clock(f.at)} (${new Date(f.at).toLocaleDateString()}) · from the agent transcript` : "no transcript usage yet"}
        </Text>
      </View>
    );
  }

  // Paseo sizes the pill itself and truncates past ~16 characters, so the label is
  // compact: "CH <last turn>/<session> <time>"; the hover title carries the spelled-out figures.
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "-" : String(Math.round(v)));
  const label = (agentId: string) => {
    const f = figures.get(agentId);
    return f ? `CH ${num(f.turnPct)}/${num(f.sessionPct)} ${clock(f.at)}` : "CH -";
  };
  const title = (agentId: string) => {
    const f = figures.get(agentId);
    return f
      ? `Cache read - last turn ${num(f.turnPct)}% · session ${num(f.sessionPct)}% · last reply ${clock(f.at)}`
      : "Cache read % (no transcript usage yet)";
  };

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const existing = pills.get(agent.id);
    if (existing) {
      existing.update({ label: label(agent.id), title: title(agent.id) });
      return;
    }
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "cache-meter-pill",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: title(agent.id),
          icon: "Database",
          label: label(agent.id),
          behavior: { kind: "popover", Content: Popover },
        },
      }) as any,
    );
  };

  const poll = () => {
    const ids = [...pills.keys()];
    if (!ids.length) return;
    client
      .rpc(getCacheRpc, { agentIds: ids })
      .then((result) => {
        for (const [id, f] of Object.entries(result)) {
          figures.set(id, f);
          pills.get(id)?.update({ label: label(id), title: title(id) });
        }
        return undefined;
      })
      .catch(() => {});
  };
  const timer = setInterval(poll, POLL_MS);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) register(agent);
          poll();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const u = message.payload;
          if (u.kind === "upsert") register(u.agent);
          else if ("agentId" in u && typeof u.agentId === "string") {
            pills.get(u.agentId)?.remove();
            pills.delete(u.agentId);
          }
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[cache-meter] agent observation failed", error);
    });

  return () => {
    clearInterval(timer);
    lifetime.abort();
    for (const p of pills.values()) p.remove();
    pills.clear();
  };
}
