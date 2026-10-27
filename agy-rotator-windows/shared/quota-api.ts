// agy-rotator-windows — the two HTTP calls, and the one response shape they must agree on (plan §3.7; AC9/AC10).
//
// Literal endpoints, both in code — never read from `agy.exe` (R4-9): `https://oauth2.googleapis.com/token` for the
// refresh grant, `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` for the quota. The quota request body
// is `{}` exactly as the plan fixes it.
//
// What `retrieveUserQuota` gives (spike §Q1.4, P2b): `buckets[]`, one per model, each with `remainingFraction` (a float32)
// and `resetTime`. Every gemini model carries the SAME 5-hour figure — `/usage`'s `gemini-5h` is the float32 widening of
// it, bit for bit. There is **no weekly** in any REST answer (Q1.5), so this parser never invents one.

import type { PolledBuckets } from "./polled.ts";
import type { UsageBucket } from "./usage.ts";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

/** The refresh grant, form-encoded, as the endpoint expects it. */
export function refreshBody(input: { clientId: string; clientSecret: string; refreshToken: string }): string {
  return new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: "refresh_token",
  }).toString();
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** `remainingFraction` (REST camelCase) or `remaining_fraction` (agy's own formatting) — both seen in the evidence. */
function fractionOf(record: Record<string, unknown>): number | null {
  return numberOrNull(record.remainingFraction) ?? numberOrNull(record.remaining_fraction);
}

function resetOf(record: Record<string, unknown>): string | null {
  const reset = record.resetTime ?? record.reset_time;
  return typeof reset === "string" && reset.trim().length > 0 ? reset : null;
}

/**
 * The model this bucket is about, from whichever field carries it. `modelId` is what the LIVE endpoint answers with
 * (measured 2026-10-27: `{buckets:[{tokenType, modelId, remainingFraction}]}`) — the snake_case and nested spellings are
 * kept because the spike's recorded shape used them, and the parser must not care which build it is talking to.
 */
function modelOf(record: Record<string, unknown>): string {
  const model = asRecord(record.model);
  for (const candidate of [
    record.modelId,
    record.model_id,
    model?.model_id,
    model?.modelId,
    model?.displayName,
    model?.display_name,
    record.modelName,
    record.model_name,
    record.name,
    record.bucketId,
    record.bucket_id,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return "";
}

const bucketOf = (record: Record<string, unknown>, remaining: number): UsageBucket => ({ remaining, resetsAt: resetOf(record) });

/**
 * `retrieveUserQuota` → the buckets this plugin polls. The gemini figure is the LOWEST gemini bucket in the answer (they
 * are the same number; the minimum is the conservative read), and the 3p figure is the lowest claude/gpt one. Anything
 * that is not a bucket is skipped, and an answer with no gemini bucket at all is `null` (a shape this parser does not
 * trust) rather than an empty reading.
 */
export function parseQuotaBuckets(json: unknown): PolledBuckets | null {
  const root = asRecord(json);
  const raw = root?.buckets;
  if (!Array.isArray(raw)) return null;

  let gemini: UsageBucket | null = null;
  let threep: UsageBucket | null = null;
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) continue;
    const remaining = fractionOf(record);
    if (remaining === null) continue;
    const model = modelOf(record).toLowerCase();
    if (model.includes("gemini")) {
      gemini = gemini === null || remaining < gemini.remaining ? bucketOf(record, remaining) : gemini;
    } else if (model.includes("claude") || model.includes("gpt")) {
      threep = threep === null || remaining < threep.remaining ? bucketOf(record, remaining) : threep;
    }
  }
  if (gemini === null) return null;
  // `threepWeekly` is always null: no REST endpoint returns it (spike Q1.5), and a poll must never invent a weekly.
  return { gemini5h: gemini, threep5h: threep, threepWeekly: null };
}
