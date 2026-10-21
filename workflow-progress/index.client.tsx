import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { WORKFLOW_KIND, WORKFLOW_VERSION, WorkflowCardSchema, type WorkflowCard } from "./shared/card";

const ICON: Record<WorkflowCard["event"], string> = {
  summary: "≡",
  started: "▶",
  done: "✓",
  silent: "⚠",
  working: "…",
};

function WorkflowStep(props: PluginTimelineItemProps<WorkflowCard>) {
  const { item, theme } = props;
  const d = item.data;
  const tone =
    d.event === "done"
      ? theme.colors.statusSuccess
      : d.event === "silent"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  const time = d.at.slice(11, 16);
  return (
    <View style={{ marginVertical: 2, paddingVertical: 4, paddingHorizontal: 8, borderLeftWidth: 2, borderLeftColor: tone }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
        <Text style={{ color: tone }}>{ICON[d.event]} </Text>
        {d.label}
        {d.detail ? <Text style={{ color: theme.colors.foregroundMuted }}>{`  ${d.detail}`}</Text> : null}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{`workflow ${d.workflowId} · ${time} UTC`}</Text>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  const off = client.addTimelineRenderer({
    kind: WORKFLOW_KIND,
    version: WORKFLOW_VERSION,
    schema: WorkflowCardSchema,
    Component: WorkflowStep,
  });
  return () => {
    if (typeof off === "function") off();
  };
}
