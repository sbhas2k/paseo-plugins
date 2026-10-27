import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuotaBuckets, QUOTA_URL, refreshBody, TOKEN_URL } from "../shared/quota-api.ts";

// S4 — the two URLs and the one response shape (spike Q1.4/Q1.5, P2b). The fixture is synthetic but its SHAPE is the
// recorded one: `buckets[]` per model with `remainingFraction` + `resetTime`, every gemini model carrying the same
// 5-hour number, and no weekly anywhere.

const response = (over: Record<string, unknown> = {}) => ({
  buckets: [
    { modelName: "gemini-3.0-flash", remainingFraction: 0.9521263, resetTime: "2026-10-27T04:13:01Z", tokenType: "WTUS" },
    { modelName: "gemini-3.0-pro", remainingFraction: 0.9521263, resetTime: "2026-10-27T04:13:01Z", tokenType: "WTUS" },
    { modelName: "claude-sonnet-4", remainingFraction: 1, resetTime: "2026-10-27T06:15:39Z", tokenType: "WTUS" },
    ...((over.buckets as unknown[]) ?? []),
  ],
  ...over,
});

test("both endpoints are literals in code, never read from the binary", () => {
  assert.equal(TOKEN_URL, "https://oauth2.googleapis.com/token");
  assert.equal(QUOTA_URL, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
});

test("the refresh grant is form-encoded with the four fields the endpoint takes", () => {
  const body = refreshBody({ clientId: "cid.apps.googleusercontent.com", clientSecret: "sec", refreshToken: "rt" });
  const params = new URLSearchParams(body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("client_id"), "cid.apps.googleusercontent.com");
  assert.equal(params.get("client_secret"), "sec");
  assert.equal(params.get("refresh_token"), "rt");
});

test("the gemini 5-hour figure comes out as the float the CLI would print", () => {
  const buckets = parseQuotaBuckets(response());
  assert.equal(buckets?.gemini5h?.remaining, 0.9521263);
  assert.equal(buckets?.gemini5h?.resetsAt, "2026-10-27T04:13:01Z");
  assert.equal(buckets?.threep5h?.remaining, 1);
});

test("no weekly is ever invented by a poll", () => {
  assert.equal(parseQuotaBuckets(response())?.threepWeekly, null);
});

test("several gemini models are one figure — the lowest wins, conservatively", () => {
  const buckets = parseQuotaBuckets(
    response({ buckets: [{ modelName: "gemini-3.0-pro", remainingFraction: 0.4021, resetTime: "2026-10-27T04:13:01Z" }] }),
  );
  assert.equal(buckets?.gemini5h?.remaining, 0.4021);
});

test("agy's own snake_case fields are accepted too (the same bucket, two spellings)", () => {
  const buckets = parseQuotaBuckets({
    buckets: [{ model: { model_id: "gemini-3.0-flash" }, remaining_fraction: 0.5, reset_time: "2026-10-27T04:13:01Z" }],
  });
  assert.equal(buckets?.gemini5h?.remaining, 0.5);
  assert.equal(buckets?.gemini5h?.resetsAt, "2026-10-27T04:13:01Z");
});

test("the LIVE shape is read: {buckets:[{tokenType, modelId, remainingFraction}]} with no reset time at all", () => {
  // Recorded from the endpoint on 2026-10-27 (shape only, no values): 19 buckets, `modelId` identifies the model, and
  // there is NO `resetTime` in this response — unlike the summary endpoint the spike captured.
  const live = {
    buckets: [
      { tokenType: "WTUS", modelId: "gemini-3-pro-preview", remainingFraction: 0.9371946 },
      { tokenType: "WTUS", modelId: "claude-sonnet-4-5", remainingFraction: 1 },
    ],
  };
  const buckets = parseQuotaBuckets(live);
  assert.equal(buckets?.gemini5h?.remaining, 0.9371946);
  assert.equal(buckets?.gemini5h?.resetsAt, null, "this endpoint reports no reset time - the 5h bar has no 'resets in' line");
  assert.equal(buckets?.threep5h?.remaining, 1);
  assert.equal(buckets?.threepWeekly, null);
});

test("an answer with no gemini bucket is refused rather than read as empty", () => {
  assert.equal(parseQuotaBuckets({ buckets: [{ modelName: "claude-sonnet-4", remainingFraction: 1 }] }), null);
  assert.equal(parseQuotaBuckets({}), null);
  assert.equal(parseQuotaBuckets([]), null);
  assert.equal(parseQuotaBuckets(null), null);
});

test("a bucket with an unusable fraction is skipped, not coerced", () => {
  const buckets = parseQuotaBuckets({ buckets: [{ modelName: "gemini-x", remainingFraction: "0.9" }, { modelName: "gemini-y", remainingFraction: 0.75 }] });
  assert.equal(buckets?.gemini5h?.remaining, 0.75);
});

test("a zero fraction survives (an empty account is a reading)", () => {
  assert.equal(parseQuotaBuckets({ buckets: [{ modelName: "gemini-x", remainingFraction: 0 }] })?.gemini5h?.remaining, 0);
});
