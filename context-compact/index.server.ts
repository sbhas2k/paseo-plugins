import type { PluginServerContext } from "@getpaseo/plugin/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactEnv, contextCompactSettings, type ContextCompactSettings } from "./shared/settings";

// context-compact — Claude Code auto-compaction threshold for every Claude session Paseo opens, plus an optional
// "update your notes before compaction" nudge.
//
// Two jobs:
//  1. `before("agent.session_open")` — every Claude session Paseo opens (create, resume, refresh, import) gets
//     CLAUDE_AUTOCOMPACT_PCT_OVERRIDE + CLAUDE_CODE_AUTO_COMPACT_WINDOW, so Claude Code compacts in the same chat at
//     compactPct % of windowTokens. Claude Code does the compaction and carries on; nothing is restarted.
//  2. `on("agent.turn_ended")` — reads the context size of the session's LAST API call from its transcript
//     (~/.claude/projects/*/<sessionId>.jsonl, the same source cache-meter reads) and, once it passes handoffPct,
//     sends the agent one prompt asking it to update its durable state before compaction. Re-armed when the
//     context falls back under handoffPct (i.e. after a compaction). Top-level agents only: a sub-agent's state
//     belongs to its parent.
//
// What it cannot see: a Claude Code chat started outside Paseo (a plain terminal `claude`) never passes through
// session_open — that one is governed by ~/.claude/settings.json `env` alone. And a `env` entry for the same
// variable in ~/.claude/settings.json is applied by Claude Code AFTER launch, overriding this plugin; keep the
// variables out of settings.json while this plugin is the source.

const HOME = os.homedir();
const AGENTS_DIR = path.join(process.env.PASEO_HOME || path.join(HOME, ".paseo"), "agents");
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const TAIL_BYTES = 512 * 1024;
const FLUSH_RETRY_MS = 1500;
const PREFIX = "[context-compact]";

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function transcriptFor(agentId: string): Promise<string | null> {
  for (const projectDir of await listFiles(AGENTS_DIR)) {
    let rec: any;
    try {
      rec = JSON.parse(await fs.readFile(path.join(projectDir, `${agentId}.json`), "utf8"));
    } catch {
      continue;
    }
    const p = rec?.persistence ?? {};
    const sid: string | undefined = p.sessionId ?? rec?.runtimeInfo?.sessionId ?? p.nativeHandle;
    if (!sid) return null;
    for (const dir of await listFiles(CLAUDE_PROJECTS)) {
      const f = path.join(dir, `${sid}.jsonl`);
      try {
        await fs.stat(f);
        return f;
      } catch {
        /* next */
      }
    }
    return null;
  }
  return null;
}

/** Context tokens of the last API call in the transcript tail (input + cache read + cache write), or null. */
export async function lastContextTokens(file: string): Promise<number | null> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"usage"')) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // the first line of the tail is usually cut
      }
      if (row?.isSidechain) continue;
      const u = row?.message?.usage;
      if (!u || typeof u !== "object") continue;
      const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (total > 0) return total;
    }
    return null;
  } finally {
    await fh.close();
  }
}

const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

// Paseo 0.13.0 (#7477) sends agent.turn_ended with an empty `timeline`; fetch the tail when it is empty.
async function turnTimeline<T>(paseo: any, agentId: string, given: readonly T[], limit: number): Promise<readonly T[]> {
  if (given.length > 0) return given;
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "canonical" });
  return page.entries.map((entry: { item: T }) => entry.item);
}

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(contextCompactSettings);
  const nudged = new Set<string>();

  async function current(): Promise<ContextCompactSettings | null> {
    try {
      const s = await settingsHandle.read();
      return s.status === "ready" && s.values ? s.values : null;
    } catch {
      return null;
    }
  }

  const removeOpen = server.before("agent.session_open", async ({ request }) => {
    const s = await current();
    if (!s || !s.enabled || !s.providers.includes(request.provider)) return undefined;
    if (request.purpose !== "interactive") return undefined;
    const env = compactEnv(s);
    console.log(
      `[context-compact] ${request.agentId.slice(0, 8)} ${request.provider} ${request.reason}: compact at ${s.compactPct}% of ${s.windowTokens}`,
    );
    return { ...request, env: { ...request.env, ...env } };
  });

  const removeTurn = server.on("agent.turn_ended", async (event, { paseo }) => {
    const { agent, outcome } = event;
    try {
      const s = await current();
      if (!s || !s.enabled || s.handoffPct <= 0 || !s.providers.includes(agent.provider)) return;
      if (agent.parentAgentId) return;
      if (outcome.kind !== "completed") return;

      const file = await transcriptFor(agent.id);
      if (!file) return;
      let tokens = await lastContextTokens(file);
      if (tokens === null) {
        await new Promise((r) => setTimeout(r, FLUSH_RETRY_MS));
        tokens = await lastContextTokens(file);
      }
      if (tokens === null) return;
      const pct = Math.round((100 * tokens) / s.windowTokens);

      if (pct < s.handoffPct) {
        nudged.delete(agent.id); // compacted (or never got there): re-arm
        return;
      }
      if (pct >= s.compactPct || nudged.has(agent.id)) return;
      // The nudge's own turn ends here too; it is covered by `nudged`, but never answer a nudge with a nudge.
      const timeline = await turnTimeline(paseo, agent.id, event.timeline, 50);
      const lastPrompt = [...timeline].reverse().find((item) => item.type === "user_message") as { text?: string } | undefined;
      if ((lastPrompt?.text ?? "").startsWith(PREFIX)) return;

      nudged.add(agent.id);
      const text = fill(s.handoffPrompt, {
        pct: String(pct),
        window: s.windowTokens.toLocaleString("en-US"),
        compact: String(s.compactPct),
      });
      await paseo.agents.ref(agent.id).send(text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`);
      console.log(`[context-compact] ${agent.id.slice(0, 8)} at ${pct}% (${tokens} tokens): handoff nudge sent`);
    } catch (error) {
      console.error(`[context-compact] ${agent.id.slice(0, 8)} turn_ended failed:`, (error as Error)?.message ?? error);
    }
  });

  return () => {
    removeOpen();
    removeTurn();
  };
}
