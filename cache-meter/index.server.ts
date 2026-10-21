import type { PluginServerContext } from "@getpaseo/plugin/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCacheRpc, type CacheFigure } from "./shared/card";

// cache-meter — prompt-cache read % per agent, shown as a composer pill.
//
// Paseo shows the context-window % and plan usage but no prompt-cache figure. Each provider's transcript records it
// per API call: Claude `~/.claude/projects/*/<sessionId>.jsonl` (message.usage.cache_read_input_tokens, one usage
// repeated across the lines of a message — deduped by message.id), Pi the agent's persistence.nativeHandle file
// (message.usage.cacheRead). At every turn end this plugin reads only the bytes appended since the previous turn
// end and keeps cache-read % = cacheRead / (uncached input + cacheRead + cacheWrite), this turn and for the session.
// The client shows it as a composer pill ("Cache 99% · 98%" = last turn · session; popover adds all agents pooled), ; it asks
// via the cache-meter.get RPC every 15 s.
//
// Blind spots, stated: the first turn end seen for an agent after a daemon/plugin restart reads the whole transcript,
// so its "this turn" is the session figure; providers without a local transcript (Qoder ACP) show "—"; a turn with
// no usage rows (transcript not flushed yet, after one retry) keeps the previous figure rather than a misleading 0%.

const HOME = os.homedir();
const AGENTS_DIR = path.join(process.env.PASEO_HOME || path.join(HOME, ".paseo"), "agents");
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const FLUSH_RETRY_MS = 1500;

type Totals = { input: number; read: number; write: number };
type Tracked = { file: string; offset: number; session: Totals; seen: Set<string>; lastAt: string | null };

const zero = (): Totals => ({ input: 0, read: 0, write: 0 });
const pct = (t: Totals): number | null => {
  const all = t.input + t.read + t.write;
  return all > 0 ? Math.round((1000 * t.read) / all) / 10 : null;
};

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

async function agentRecord(agentId: string): Promise<any | null> {
  for (const projectDir of await listFiles(AGENTS_DIR)) {
    try {
      return JSON.parse(await fs.readFile(path.join(projectDir, `${agentId}.json`), "utf8"));
    } catch {
      /* not in this project dir */
    }
  }
  return null;
}

async function transcriptFor(agentId: string): Promise<string | null> {
  const rec = await agentRecord(agentId);
  const p = rec?.persistence ?? {};
  const handle: string | undefined = p.nativeHandle;
  if (handle && handle.endsWith(".jsonl")) return handle; // Pi
  const sid: string | undefined = p.sessionId ?? rec?.runtimeInfo?.sessionId ?? handle;
  if (!sid || !String(rec?.provider ?? "").startsWith("claude")) return null;
  for (const projectDir of await listFiles(CLAUDE_PROJECTS)) {
    const f = path.join(projectDir, `${sid}.jsonl`);
    try {
      await fs.stat(f);
      return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Sums usage in bytes [offset, EOF); returns the new offset (end of the last complete line). */
async function readNew(t: Tracked, turn: Totals): Promise<number> {
  const fh = await fs.open(t.file, "r");
  try {
    const { size } = await fh.stat();
    if (size < t.offset) t.offset = 0; // rewritten/compacted file: start over
    const len = size - t.offset;
    if (len <= 0) return 0;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, t.offset);
    const text = buf.toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return 0;
    let rows = 0;
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.includes("usage")) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const m = row?.message;
      const u = m?.usage;
      if (!u || typeof u !== "object") continue;
      let add: Totals;
      if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u || "input_tokens" in u) {
        const id = m.id ?? row.uuid;
        if (id) {
          if (t.seen.has(id)) continue;
          t.seen.add(id);
        }
        add = { input: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0 };
      } else if ("cacheRead" in u || "input" in u) {
        add = { input: u.input ?? 0, read: u.cacheRead ?? 0, write: u.cacheWrite ?? 0 };
      } else continue;
      rows += 1;
      if (typeof row.timestamp === "string") t.lastAt = row.timestamp; // the reply's own time, not the read time
      for (const k of ["input", "read", "write"] as const) {
        turn[k] += add[k];
        t.session[k] += add[k];
      }
    }
    t.offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
    return rows;
  } finally {
    await fh.close();
  }
}

export default function contribute(server: PluginServerContext) {
  const tracked = new Map<string, Tracked>();
  const latest = new Map<string, CacheFigure>();
  const missing = new Set<string>(); // agents with no readable transcript (re-checked on their next turn end)

  async function update(agentId: string, retry: boolean): Promise<void> {
    let t = tracked.get(agentId);
    if (!t) {
      const file = await transcriptFor(agentId);
      if (!file) {
        missing.add(agentId);
        return;
      }
      missing.delete(agentId);
      t = { file, offset: 0, session: zero(), seen: new Set(), lastAt: null };
      tracked.set(agentId, t);
    }
    const turn = zero();
    let rows = await readNew(t, turn);
    if (rows === 0 && retry) {
      await new Promise((r) => setTimeout(r, FLUSH_RETRY_MS));
      rows = await readNew(t, turn);
    }
    if (rows === 0) return;
    latest.set(agentId, { turnPct: pct(turn), sessionPct: pct(t.session), at: t.lastAt ?? new Date().toISOString() });
  }

  const unsubscribe = server.on("agent.turn_ended", async (event) => {
    const agentId = event.agent.id;
    missing.delete(agentId);
    try {
      await update(agentId, true);
      const f = latest.get(agentId);
      if (f) console.log(`[cache-meter] ${agentId.slice(0, 8)} turn ${f.turnPct}% session ${f.sessionPct}%`);
    } catch (error) {
      console.error(`[cache-meter] ${agentId.slice(0, 8)} failed:`, (error as Error)?.message ?? error);
    }
  });

  server.handle(getCacheRpc, async ({ agentIds }) => {
    const out: Record<string, CacheFigure> = {};
    for (const id of agentIds) {
      if (!tracked.has(id) && !missing.has(id)) {
        try {
          await update(id, false); // first sight: whole transcript once, then only appended bytes
        } catch {
          missing.add(id);
        }
      }
    }
    const pool = zero();
    for (const t of tracked.values()) for (const k of ["input", "read", "write"] as const) pool[k] += t.session[k];
    const overallPct = pct(pool);
    for (const id of agentIds) {
      const f = latest.get(id);
      if (f) out[id] = { ...f, overallPct };
    }
    return out;
  });

  return () => {
    unsubscribe();
    tracked.clear();
    latest.clear();
  };
}
