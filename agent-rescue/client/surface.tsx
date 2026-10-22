import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { listStuckRpc, reloadRpc, restartProviderRpc, type RescueResult, type StuckAgent } from "../shared/contracts";

// agent-rescue — the sidebar page: every stuck agent on this daemon, with Reload and (where configured)
// Restart provider processes. Refreshes every 5 s while open.

type Theme = PluginSurfaceProps["theme"];
const POLL_MS = 5_000;

function ActionButton(props: { theme: Theme; label: string; disabled?: boolean; onPress: () => void; danger?: boolean }) {
  const { theme, label, disabled, onPress, danger } = props;
  const tone = danger ? theme.colors.statusWarning ?? theme.colors.accent : theme.colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{
        paddingVertical: 5,
        paddingHorizontal: 10,
        marginRight: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: tone,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ fontSize: 12, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function RescueSurface({ theme, navigation }: PluginSurfaceProps) {
  const list = useRpc(listStuckRpc);
  const reload = useRpc(reloadRpc);
  const restart = useRpc(restartProviderRpc);
  const [agents, setAgents] = useState<StuckAgent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, RescueResult>>({});

  const refresh = useCallback(() => {
    list({})
      .then((r) => {
        setAgents(r.agents);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [list]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const act = (a: StuckAgent, kind: "reload" | "restart") => {
    setWorking((w) => ({ ...w, [a.id]: true }));
    (kind === "reload" ? reload : restart)({ agentId: a.id })
      .then((r) => setResults((s) => ({ ...s, [a.id]: r })))
      .catch((e) => setResults((s) => ({ ...s, [a.id]: { ok: false, message: String(e), status: null, steps: [] } })))
      .finally(() => {
        setWorking((w) => ({ ...w, [a.id]: false }));
        refresh();
      });
  };

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const finished = Object.entries(results).filter(([id]) => !agents?.some((a) => a.id === id));

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: "600", color: fg, marginBottom: 4 }}>Agent Rescue</Text>
      <Text style={{ fontSize: 12, color: muted, marginBottom: 16 }}>
        Agents whose session is dead (e.g. "A foreground turn is already active"). Reload first; restart the provider's
        processes only if reload fails - it refuses while another agent of that provider is busy.
      </Text>
      {error ? <Text style={{ color: theme.colors.statusWarning ?? fg, marginBottom: 12 }}>{error}</Text> : null}
      {agents === null ? <Text style={{ color: muted }}>Loading...</Text> : null}
      {agents?.length === 0 ? <Text style={{ color: muted }}>No stuck agents.</Text> : null}
      {agents?.map((a) => {
        const result = results[a.id];
        const busy = working[a.id] || a.state === "reloading";
        return (
          <View key={a.id} style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <Pressable onPress={() => navigation?.openAgent({ agentId: a.id })} accessibilityRole="link">
              <Text style={{ fontSize: 14, fontWeight: "600", color: fg }}>{a.title || a.id.slice(0, 8)}</Text>
            </Pressable>
            <Text style={{ fontSize: 11, color: muted, marginTop: 2 }}>
              {a.provider} - {a.cwd ?? ""} - {a.state === "reloading" ? "reload in progress" : "stuck"}
            </Text>
            <Text style={{ fontSize: 12, color: fg, marginTop: 6 }} numberOfLines={3}>
              {a.lastError}
            </Text>
            <View style={{ flexDirection: "row", marginTop: 10 }}>
              <ActionButton theme={theme} label={working[a.id] ? "Working..." : "Reload"} disabled={busy} onPress={() => act(a, "reload")} />
              {a.canRestart ? (
                <ActionButton theme={theme} danger label={`Restart ${a.provider} processes`} disabled={busy} onPress={() => act(a, "restart")} />
              ) : null}
            </View>
            {result ? (
              <Text style={{ fontSize: 12, marginTop: 8, color: result.ok ? theme.colors.statusSuccess ?? fg : theme.colors.statusWarning ?? fg }}>
                {result.message}
              </Text>
            ) : null}
          </View>
        );
      })}
      {finished.map(([id, r]) => (
        <Text key={id} style={{ fontSize: 12, color: r.ok ? theme.colors.statusSuccess ?? fg : muted, marginBottom: 6 }}>
          {id.slice(0, 8)}: {r.message}
        </Text>
      ))}
    </ScrollView>
  );
}
