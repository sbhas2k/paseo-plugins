import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_PATTERNS, DEFAULT_PROVIDER_PROCESSES } from "./rescue";

// agent-rescue — settings (Settings → Plugins → Agent Rescue, or <paseoHome>/plugin-settings/agent-rescue/config.json).
export const AgentRescueSettingsSchema = z.object({
  /** lastError texts (regex, case-insensitive; plain text if not a valid regex) that mark an errored agent stuck. */
  patterns: z.array(z.string().min(1)).default([...DEFAULT_PATTERNS]),
  /**
   * Provider id → its long-lived ACP process: `name` is the image name (CIM filter), `pattern` a regex over the
   * command line. Only providers listed here get "Restart processes".
   */
  providerProcesses: z
    .record(z.string(), z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/), pattern: z.string().min(1) }))
    .default({ ...DEFAULT_PROVIDER_PROCESSES }),
});
export type AgentRescueSettings = z.output<typeof AgentRescueSettingsSchema>;

export const agentRescueSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: AgentRescueSettingsSchema,
  migrate: (values) => values,
});

const StuckAgentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  workspaceId: z.string().nullable(),
  cwd: z.string().nullable(),
  state: z.enum(["stuck", "reloading"]),
  lastError: z.string(),
  canRestart: z.boolean(),
});
export type StuckAgent = z.infer<typeof StuckAgentSchema>;

const ResultSchema = z.object({
  ok: z.boolean(),
  /** One human line: what happened. */
  message: z.string(),
  /** The agent's status after the action, when known. */
  status: z.string().nullable(),
  /** Every step, in order — the same lines go to the daemon log. */
  steps: z.array(z.string()),
});
export type RescueResult = z.infer<typeof ResultSchema>;

export const listStuckRpc = defineRpc({
  name: "agent-rescue.list",
  input: z.object({}),
  output: z.object({ agents: z.array(StuckAgentSchema), patterns: z.array(z.string()), busy: z.array(z.string()) }),
});

export const reloadRpc = defineRpc({
  name: "agent-rescue.reload",
  input: z.object({ agentId: z.string().min(1) }),
  output: ResultSchema,
});

export const restartProviderRpc = defineRpc({
  name: "agent-rescue.restart-provider",
  input: z.object({ agentId: z.string().min(1) }),
  output: ResultSchema,
});
