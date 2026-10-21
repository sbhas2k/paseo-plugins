import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// context-compact — settings document. Edited from Settings → Plugins → Context Compact, or by hand in
// <paseoHome>/plugin-settings/context-compact/config.json (store envelope `{ "version": 1, "values": { ... } }`).
//
// Claude Code compacts when the context reaches compactPct % of windowTokens. The plugin hands both to every Claude
// session it opens as CLAUDE_AUTOCOMPACT_PCT_OVERRIDE and CLAUDE_CODE_AUTO_COMPACT_WINDOW. A value changed here
// reaches a chat on its NEXT open (new agent, resume, refresh) — a running Claude process keeps the env it started with.

export const ContextCompactSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** Paseo provider ids whose sessions get the env (each must run Claude Code). */
  providers: z.array(z.string()).default(["claude"]),
  /** Compact at this % of windowTokens. */
  compactPct: z.number().int().min(10).max(100).default(60),
  /** The window the % applies to. 1,000,000 = the 1M models' full window. */
  windowTokens: z.number().int().min(50_000).max(2_000_000).default(1_000_000),
  /**
   * Ask a top-level agent to update its handoff once its context passes this % of windowTokens (0 = never).
   * BEST-EFFORT: checked at turn end only, so a single long turn (large tool outputs) can cross both this and the
   * compaction threshold before it is checked. Pair it with a Claude Code PostCompact/SessionStart hook if you need
   * a guarantee.
   */
  handoffPct: z.number().int().min(0).max(100).default(45),
  handoffPrompt: z
    .string()
    .default(
      "[context-compact] Your context is at {pct}% of {window} tokens; auto-compaction runs at {compact}%. " +
        "Before it does, bring your durable notes up to date (handoff, progress file or plan, whichever this " +
        "project keeps). Then reply in one line and carry on with your current work.",
    ),
});

export type ContextCompactSettings = z.output<typeof ContextCompactSettingsSchema>;

export const contextCompactSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: ContextCompactSettingsSchema,
  migrate: (values) => values,
});

export const DEFAULT_SETTINGS: ContextCompactSettings = ContextCompactSettingsSchema.parse({});

/** The env a Claude session gets. */
export function compactEnv(s: ContextCompactSettings): Record<string, string> {
  return {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(s.compactPct),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(s.windowTokens),
  };
}
