// agy-rotator-windows — the `/usage` answer, parsed. Pure (no Paseo, no filesystem, no spawn), so `node --test` runs it
// directly and the daemon and the tests share one parser.
//
// `agy -p /usage --output-format json` answers a command result, not an agent turn (plan F3, challenger F5):
//
//   { status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
//       { name: "Gemini Models",         buckets: [ { id: "gemini-weekly", remaining_fraction, reset_time },
//                                                    { id: "gemini-5h",     remaining_fraction, reset_time } ] },
//       { name: "Claude and GPT models", buckets: [ { id: "3p-weekly", ... }, { id: "3p-5h", ... } ] } ] } } }
//
// `remaining_fraction` is REMAINING (1 = untouched), so `<= 0.20` is the owner's "switch at 80% used".
//
// The four guards below are a faithful copy of antigravity-cli's own `quota.ts` `parseQuotaOutput` (challenger F11):
// signed-out text first (a logged-out CLI may answer with a valid-looking JSON body), then `status`, then
// `num_turns === 0` (a /usage that became a real turn spends quota — never read its figures), then
// `command.name ∈ {usage, quota}`. Anything that is not that answer is `null`, never a number: a wrong quota
// reading switches the owner's account for nothing.

/** One bucket as `agy` reports it. `remaining` is a fraction, 0..1; `resetsAt` is the CLI's own RFC3339 UTC text. */
export interface UsageBucket {
  remaining: number;
  resetsAt: string | null;
}

/** The four buckets this plugin acts on or shows. `null` = the CLI did not report that bucket. */
export interface UsageReading {
  gemini5h: UsageBucket | null;
  geminiWeekly: UsageBucket | null;
  threep5h: UsageBucket | null;
  threepWeekly: UsageBucket | null;
}

export type BucketName = keyof UsageReading;

/** Bucket ids `agy` prints, in the order the two groups list them. The 3p group is shown, never a trigger. */
const BUCKETS: Readonly<Record<string, BucketName>> = {
  "gemini-5h": "gemini5h",
  "gemini-weekly": "geminiWeekly",
  "3p-5h": "threep5h",
  "3p-weekly": "threepWeekly",
};

/** `Please sign in` is what a logged-out CLI says, on whichever channel it chooses (quota.ts, challenger F11). */
const SIGNED_OUT = /please sign in|not logged into/i;

/**
 * One `/usage` answer → the four buckets, or `null` when the text is not that answer.
 * `stdout` and `stderr` are both searched for the signed-out line, as `quota.ts` does.
 */
export function parseUsage(stdout: string, stderr: string): UsageReading | null {
  if (SIGNED_OUT.test(`${stdout}\n${stderr}`)) return null;

  const result = asRecord(parseJsonObject(stdout));
  if (!result) return null;

  if (result.status !== "SUCCESS") return null;
  // Strict: a missing num_turns is not 0 — an answer this parser cannot vouch for is not a reading.
  if (result.num_turns !== 0) return null;

  const command = asRecord(result.command);
  const name = asText(command?.name);
  if (name === null || !["usage", "quota"].includes(name.toLowerCase())) return null;

  const groups = (asRecord(command?.data) as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return null;

  const reading: UsageReading = { gemini5h: null, geminiWeekly: null, threep5h: null, threepWeekly: null };
  for (const group of groups) {
    const buckets = (asRecord(group) as { buckets?: unknown } | null)?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const record = asRecord(bucket);
      if (!record) continue;
      const id = asText(record.id);
      const field = id === null ? undefined : BUCKETS[id.toLowerCase()];
      if (!field) continue;
      const remaining = record.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
      reading[field] = { remaining, resetsAt: asText(record.reset_time) };
    }
  }
  return reading;
}

/** The first line of `stdout` that is a JSON object, so a banner line cannot hide the answer (quota.ts). */
function parseJsonObject(stdout: string): unknown {
  const text = stdout.trim();
  if (text.length > 0) {
    try {
      return JSON.parse(text);
    } catch {
      // Not one object: it may be preceded by a banner, so try the lines.
    }
  }
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      continue;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A non-empty string, which is what every field this parser keeps has to be. */
function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
