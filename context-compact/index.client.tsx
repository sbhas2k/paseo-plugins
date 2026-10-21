import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
  type SettingsInputHandle,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { contextCompactSettings, type ContextCompactSettings } from "./shared/settings";

// context-compact — client entry: Settings → Plugins → Context Compact. Same host-scoped document the server reads
// on every session open and turn end; a change reaches a chat on its next open.

type NumberKey = "compactPct" | "windowTokens" | "handoffPct";

function NumberRow(props: {
  label: string;
  hint: string;
  value: number;
  onSave: (n: number) => void;
}) {
  const input = useRef<SettingsInputHandle>(null);
  return (
    <>
      <SettingsInput label={props.label} hint={props.hint} initialValue={String(props.value)} onChangeText={() => {}} ref={input} />
      <SettingsAction
        label={`${props.label}: ${props.value.toLocaleString("en-US")}`}
        actionLabel="Save"
        onPress={() => {
          const n = Number((input.current?.getText() ?? "").replace(/[,_\s]/g, ""));
          if (Number.isFinite(n)) props.onSave(Math.round(n));
        }}
      />
    </>
  );
}

function SettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(contextCompactSettings);
  const muted = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 13 }), [theme]);
  const gap = useMemo(() => ({ gap: layout.compact ? 12 : 16 }), [layout.compact]);
  const promptInput = useRef<SettingsInputHandle>(null);
  const [providersText, setProvidersText] = useState<string | null>(null);

  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Context Compact">
        <SettingsCard>
          <SettingsAction
            label="Stored settings are unreadable — the plugin does nothing until they are fixed"
            hint={settings.error}
            actionLabel="Reset to defaults"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;
  const save = (next: ContextCompactSettings) => void settings.save(next, settings.revision);
  const setNumber = (key: NumberKey) => (n: number) => save({ ...values, [key]: n });
  const threshold = Math.round((values.compactPct / 100) * values.windowTokens).toLocaleString("en-US");

  return (
    <View style={gap}>
      <SettingsSection
        title="Auto-compaction"
        info={
          <Text style={muted}>
            Claude Code compacts the chat in place at {values.compactPct}% of {values.windowTokens.toLocaleString("en-US")} tokens
            (≈{threshold}). Applies to a chat on its next open — new agent, resume or refresh. Keep these variables out of
            ~/.claude/settings.json, which would override them.
          </Text>
        }
      >
        <SettingsCard>
          <SettingsSwitch label="Enabled" value={values.enabled} onValueChange={(enabled) => save({ ...values, enabled })} />
          <NumberRow label="Compact at %" hint="10–100" value={values.compactPct} onSave={setNumber("compactPct")} />
          <NumberRow
            label="Window tokens"
            hint="50,000–2,000,000; 1,000,000 = full 1M window"
            value={values.windowTokens}
            onSave={setNumber("windowTokens")}
          />
          <SettingsInput
            label="Providers"
            hint="Comma-separated Paseo provider ids"
            initialValue={values.providers.join(", ")}
            onChangeText={setProvidersText}
          />
          <SettingsAction
            label={`Providers: ${values.providers.join(", ") || "(none)"}`}
            actionLabel="Save"
            onPress={() => {
              if (providersText === null) return;
              save({ ...values, providers: providersText.split(",").map((p) => p.trim()).filter(Boolean) });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Handoff before compaction"
        info={
          <Text style={muted}>
            Once a top-level agent's context passes this %, it gets one prompt asking it to update its handoff. 0 = off. Best-effort: checked at turn end, so one long turn can skip it. For a guarantee, add a "# Compact instructions" section to CLAUDE.md and a Claude Code PostCompact hook.
            Placeholders: {"{pct} {window} {compact}"}.
          </Text>
        }
      >
        <SettingsCard>
          <NumberRow label="Nudge at %" hint="0–100, below the compact %" value={values.handoffPct} onSave={setNumber("handoffPct")} />
          <SettingsInput label="Nudge text" initialValue={values.handoffPrompt} onChangeText={() => {}} ref={promptInput} />
          <SettingsAction
            label="Nudge text"
            actionLabel="Save"
            onPress={() => {
              const text = promptInput.current?.getText().trim() ?? "";
              if (text) save({ ...values, handoffPrompt: text });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "settings",
    title: "Context Compact",
    icon: "Minimize2",
    Component: SettingsScreen,
  });
}
