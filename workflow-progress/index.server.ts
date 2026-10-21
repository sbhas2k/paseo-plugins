import type { PluginServerContext } from "@getpaseo/plugin/server";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WORKFLOW_KIND, WORKFLOW_VERSION, type WorkflowCard } from "./shared/card";

// workflow-progress — Claude Code Workflow progress as cards in the Paseo timeline.
//
// A Claude Code Workflow runs its sub-agents inside one Claude session; its progress lives in Claude Code's
// `/workflows` view and in `~/.claude/projects/<project>/<sessionId>/subagents/workflows/<wf>/journal.jsonl`.
// Paseo sees only one long "Workflow" tool call, so the chat shows a single line. This plugin reads those journals
// (read-only) and appends a small card per journal event to the owning Paseo agent's timeline:
//   started -> "S2:implement started"; result -> "S1:implement done (status, commits)";
//   a started step whose sub-agent transcript has not been written for STALL_MS -> one "silent" warning.
// First sight of a journal posts ONE summary card, not the whole history. State is in memory; after a daemon or
// plugin restart the next poll posts a fresh summary per live workflow (a deliberate, bounded duplicate).

const POLL_MS = 15_000;
const STALL_MS = 20 * 60_000;
const ACTIVE_MS = 24 * 60 * 60_000; // ignore journals untouched for a day
const HOME = os.homedir();
const AGENTS_DIR = path.join(process.env.PASEO_HOME || path.join(HOME, ".paseo"), "agents");
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");

type JournalRow = { type: string; label?: string; phase?: string; agentId?: string; key?: string; result?: unknown };
type Tracked = {
  lines: number;
  open: Map<string, { label: string; agentId: string }>;
  stalled: Set<string>;
  beat: Map<string, number>;
};

const HEARTBEAT_MS = 3 * 60_000;

/** The sub-agent's most recent tool call or sentence, from the tail of its transcript (read-only, bounded). */
async function lastAction(transcript: string): Promise<string> {
  try {
    const fh = await fs.open(transcript, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    await fh.close();
    const lines = buf.toString("utf8").split(/\r?\n/).reverse();
    for (const line of lines) {
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const part of [...content].reverse()) {
        if (part?.type === "tool_use") {
          const input = part.input ?? {};
          const what = input.description ?? input.command ?? input.file_path ?? input.pattern ?? "";
          return `last: ${part.name}${what ? ` — ${String(what).replace(/\s+/g, " ").slice(0, 90)}` : ""}`;
        }
        if (part?.type === "text" && row?.message?.role === "assistant" && part.text?.trim()) {
          return `last: "${part.text.replace(/\s+/g, " ").slice(0, 90)}"`;
        }
      }
    }
  } catch {
    /* unreadable: fall through */
  }
  return "working";
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function sessionToAgent(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const projectDir of await listFiles(AGENTS_DIR)) {
    for (const file of await listFiles(projectDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await fs.readFile(file, "utf8"));
        if (rec.archivedAt) continue;
        const sid = rec?.persistence?.sessionId ?? rec?.runtimeInfo?.sessionId;
        if (typeof sid === "string" && typeof rec.id === "string") map.set(sid, rec.id);
      } catch {
        /* unreadable record: skip */
      }
    }
  }
  return map;
}

function summarize(result: unknown): string {
  let text = typeof result === "string" ? result : JSON.stringify(result ?? "");
  const status = /'status':\s*'([^']+)'|"status":\s*"([^"]+)"/.exec(text);
  const commits = text.match(/\b[0-9a-f]{8}\b/g) ?? [];
  const parts: string[] = [];
  if (status) parts.push(status[1] ?? status[2]);
  if (commits.length) parts.push(`commits ${[...new Set(commits)].slice(0, 6).join(", ")}`);
  text = parts.join(" · ");
  return text || "finished";
}

export default function contribute(server: PluginServerContext) {
  const tracked = new Map<string, Tracked>();
  let stopped = false;
  let busy = false;

  async function post(paseo: any, agentId: string, card: WorkflowCard): Promise<boolean> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `wf-${card.workflowId}-${card.event}-${randomUUID()}`,
        kind: WORKFLOW_KIND,
        version: WORKFLOW_VERSION,
        data: card,
      });
      console.log(`[workflow-progress] ${agentId.slice(0, 8)} ${card.workflowId} ${card.event} ${card.label}`);
      return true;
    } catch (error) {
      console.error(`[workflow-progress] append to ${agentId} failed:`, (error as Error)?.message ?? error);
      return false;
    }
  }

  async function poll(paseo: any) {
    if (busy || stopped) return;
    busy = true;
    try {
      const sessions = await sessionToAgent();
      const now = Date.now();
      for (const projectDir of await listFiles(CLAUDE_PROJECTS)) {
        for (const [sid, agentId] of sessions) {
          const wfRoot = path.join(projectDir, sid, "subagents", "workflows");
          for (const wfDir of await listFiles(wfRoot)) {
            const journal = path.join(wfDir, "journal.jsonl");
            let stat;
            try {
              stat = await fs.stat(journal);
            } catch {
              continue;
            }
            if (now - stat.mtimeMs > ACTIVE_MS && !tracked.has(journal)) continue;
            const workflowId = path.basename(wfDir);
            const rows: JournalRow[] = (await fs.readFile(journal, "utf8"))
              .split(/\r?\n/)
              .filter((l) => l.trim())
              .map((l) => {
                try {
                  return JSON.parse(l);
                } catch {
                  return { type: "unparsable" };
                }
              });

            let t = tracked.get(journal);
            if (!t) {
              t = { lines: 0, open: new Map(), stalled: new Set(), beat: new Map() };
              const done: string[] = [];
              for (const r of rows) {
                if (r.type === "started" && r.key) t.open.set(r.key, { label: r.label ?? "step", agentId: r.agentId ?? "" });
                if (r.type === "result" && r.key) {
                  const s = t.open.get(r.key);
                  if (s) done.push(s.label);
                  t.open.delete(r.key);
                }
              }
              t.lines = rows.length;
              tracked.set(journal, t);
              const ok = await post(paseo, agentId, {
                workflowId,
                event: "summary",
                label: "Workflow progress",
                detail:
                  `done: ${done.join(", ") || "none"}` +
                  (t.open.size ? ` · running: ${[...t.open.values()].map((s) => s.label).join(", ")}` : ""),
                at: new Date().toISOString(),
              });
              if (!ok) tracked.delete(journal); // retry the summary on the next poll
              continue;
            }

            for (const r of rows.slice(t.lines)) {
              if (r.type === "started" && r.key) {
                t.open.set(r.key, { label: r.label ?? "step", agentId: r.agentId ?? "" });
                await post(paseo, agentId, { workflowId, event: "started", label: r.label ?? "step", detail: r.phase ? `phase ${r.phase}` : "", at: new Date().toISOString() });
              } else if (r.type === "result" && r.key) {
                const s = t.open.get(r.key);
                t.open.delete(r.key);
                await post(paseo, agentId, { workflowId, event: "done", label: s?.label ?? "step", detail: summarize(r.result), at: new Date().toISOString() });
              } else if (r.type === "launched" && t.lines > 0) {
                await post(paseo, agentId, { workflowId, event: "started", label: "Workflow (re)launched", detail: "", at: new Date().toISOString() });
              }
            }
            t.lines = rows.length;

            for (const [key, s] of t.open) {
              if (!s.agentId) continue;
              try {
                const transcript = path.join(wfDir, `agent-${s.agentId}.jsonl`);
                const st = await fs.stat(transcript);
                if (now - st.mtimeMs > STALL_MS) {
                  if (t.stalled.has(key)) continue;
                  t.stalled.add(key);
                  const mins = Math.round((now - st.mtimeMs) / 60_000);
                  await post(paseo, agentId, { workflowId, event: "silent", label: s.label, detail: `no sub-agent activity for ${mins} min`, at: new Date().toISOString() });
                  continue;
                }
                // Heartbeat: a step can run for an hour with no journal line; show what its sub-agent is doing.
                const last = t.beat.get(key) ?? 0;
                if (now - last >= HEARTBEAT_MS && st.mtimeMs > last) {
                  t.beat.set(key, now);
                  t.stalled.delete(key);
                  await post(paseo, agentId, { workflowId, event: "working", label: s.label, detail: await lastAction(transcript), at: new Date().toISOString() });
                }
              } catch {
                /* transcript not written yet */
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("[workflow-progress] poll failed:", (error as Error)?.message ?? error);
    } finally {
      busy = false;
    }
  }

  let paseoRef: any = null;
  const unsubscribe = server.on("agent.turn_started", (_event, { paseo }) => {
    paseoRef = paseo;
  });
  const unsubscribe2 = server.on("agent.turn_ended", (_event, { paseo }) => {
    paseoRef = paseo;
  });
  const timer = setInterval(() => {
    const p = paseoRef ?? (server as any).paseo;
    if (p) void poll(p);
  }, POLL_MS);
  console.log("[workflow-progress] watching Claude Code workflow journals every 15 s");

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    unsubscribe2();
  };
}
