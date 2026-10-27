import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsage } from "../shared/usage.ts";

// AC1 — parseUsage reads the four Gemini/3p buckets out of `agy -p /usage --output-format json`, and answers
// null (never a number) for anything that is not that answer.
//
// Fixtures are built from the shape the CLI actually prints (plan F3 / challenger F5, questionnaire: quota.ts
// reads `command.data.groups[].buckets[]` with `id`, `window`, `remaining_fraction`, `reset_time`) — values are fake.

interface BucketFixture {
  id: string;
  name?: string;
  window?: string;
  remaining_fraction?: unknown;
  reset_time?: string;
}
interface GroupFixture {
  name: string;
  buckets: BucketFixture[];
}

function groups(fixture?: { gemini?: BucketFixture[]; threep?: BucketFixture[] }): GroupFixture[] {
  return [
    {
      name: "Gemini Models",
      buckets: fixture?.gemini ?? [
        { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.9542, reset_time: "2026-11-02T13:13:01Z" },
        { id: "gemini-5h", name: "5 hour", window: "5h", remaining_fraction: 0.1832, reset_time: "2026-10-26T18:13:01Z" },
      ],
    },
    {
      name: "Claude and GPT models",
      buckets: fixture?.threep ?? [
        { id: "3p-weekly", name: "Weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-11-02T13:27:31Z" },
        { id: "3p-5h", name: "5 hour", window: "5h", remaining_fraction: 0.72, reset_time: "2026-10-26T18:27:31Z" },
      ],
    },
  ];
}

function answer(over: Record<string, unknown> = {}, gs: GroupFixture[] = groups()): string {
  return JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    duration_seconds: 9,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    command: { name: "usage", data: { groups: gs } },
    ...over,
  });
}

test("a real /usage answer yields the four buckets and their reset times", () => {
  const usage = parseUsage(answer(), "");
  assert.deepEqual(usage, {
    gemini5h: { remaining: 0.1832, resetsAt: "2026-10-26T18:13:01Z" },
    geminiWeekly: { remaining: 0.9542, resetsAt: "2026-11-02T13:13:01Z" },
    threep5h: { remaining: 0.72, resetsAt: "2026-10-26T18:27:31Z" },
    threepWeekly: { remaining: 1, resetsAt: "2026-11-02T13:27:31Z" },
  });
});

test("a zero remaining fraction stays a number, never a null", () => {
  const usage = parseUsage(answer({}, groups({ gemini: [{ id: "gemini-5h", remaining_fraction: 0, reset_time: "2026-10-26T18:13:01Z" }] })), "");
  assert.deepEqual(usage?.gemini5h, { remaining: 0, resetsAt: "2026-10-26T18:13:01Z" });
});

test("a bucket without a reset time keeps the fraction and reports resetsAt null", () => {
  const usage = parseUsage(answer({}, groups({ gemini: [{ id: "gemini-5h", remaining_fraction: 0.5 }] })), "");
  assert.deepEqual(usage?.gemini5h, { remaining: 0.5, resetsAt: null });
  assert.equal(usage?.geminiWeekly, null);
});

test("a JSON object behind a banner line still parses (agy prints banners)", () => {
  assert.notEqual(parseUsage(`Starting up...\n${answer()}\n`, ""), null);
});

test("a bucket with no usable fraction is null while its siblings still read", () => {
  for (const bad of ["0.5", null, Number.NaN]) {
    const usage = parseUsage(
      answer({}, groups({ gemini: [{ id: "gemini-5h", remaining_fraction: bad }], threep: [{ id: "3p-5h", remaining_fraction: 1 }] })),
      "",
    );
    assert.equal(usage?.gemini5h, null, String(bad));
    assert.deepEqual(usage?.threep5h, { remaining: 1, resetsAt: null }, String(bad));
  }
});

test("`quota` is the other command name the CLI answers with", () => {
  assert.notEqual(parseUsage(answer({ command: { name: "quota", data: { groups: groups() } } }), ""), null);
});

test("anything that is not a /usage answer is null, never a number", () => {
  const cases: Array<[string, string, string]> = [
    ["not JSON at all", "Usage: agy [-p prompt]", ""],
    ["no object", "[]", ""],
    ["status ERROR", answer({ status: "ERROR", response: "no quota summary is available for this account" }), ""],
    ["num_turns 1 (a real turn, which spends quota)", answer({ num_turns: 1 }), ""],
    ["num_turns missing", answer({ num_turns: undefined }), ""],
    ["command.login", answer({ command: { name: "login", data: { groups: groups() } } }), ""],
    ["command missing", answer({ command: undefined }), ""],
    ["no groups", answer({ command: { name: "usage", data: {} } }), ""],
    ["signed out on stdout", "Please sign in to continue.\n" + answer(), ""],
    ["signed out on stderr", answer(), "You are not logged into Antigravity."],
    ["signed out, plain text", "Not logged into any account.", ""],
  ];
  for (const [name, stdout, stderr] of cases) {
    assert.equal(parseUsage(stdout, stderr), null, name);
  }
});
