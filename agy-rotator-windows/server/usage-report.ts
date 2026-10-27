// agy-rotator-windows — the usage source's answer (plan §3.6, R2-6), separated from the registration so it can be tested.
//
// `UsageWindow` speaks "used percent"; `/usage` speaks "remaining fraction". The conversion happens here, once, with the
// SDK's own `windowFromUsedPct`/`toneFromUsedPct` so the bars render exactly as they do for every other provider.

import { toneFromUsedPct, windowFromUsedPct, type UsageReport, type UsageWindow } from "@getpaseo/plugin/server/usage";
import type { UsageReading } from "../shared/usage.ts";

/** `used` as the percentages the summary wants: 18% left is 82% used, to one decimal. */
export function usedPct(remaining: number): number {
  return Math.round((1 - remaining) * 1000) / 10;
}

/** The windows for one reading, or an `unavailable` report when there is nothing to show. */
export function usageReport(reading: UsageReading | null): UsageReport {
  if (reading === null) return { status: "unavailable", problem: { kind: "no_quota", detail: "No /usage reading yet." } };
  const entries: Array<{ id: string; label: string; shortLabel: string; summary: boolean; bucket: UsageReading[keyof UsageReading] }> = [
    { id: "gemini-5h", label: "Gemini 5h", shortLabel: "5h", summary: true, bucket: reading.gemini5h },
    { id: "gemini-weekly", label: "Gemini weekly", shortLabel: "wk", summary: true, bucket: reading.geminiWeekly },
    { id: "3p-5h", label: "Claude/GPT 5h", shortLabel: "5h", summary: false, bucket: reading.threep5h },
    { id: "3p-weekly", label: "Claude/GPT weekly", shortLabel: "wk", summary: false, bucket: reading.threepWeekly },
  ];
  const windows: UsageWindow[] = entries
    .filter((entry): entry is typeof entry & { bucket: NonNullable<typeof entry.bucket> } => entry.bucket !== null)
    .map((entry) => {
      const used = usedPct(entry.bucket.remaining);
      return windowFromUsedPct({
        id: entry.id,
        label: entry.label,
        shortLabel: entry.shortLabel,
        summary: entry.summary,
        utilizationPct: used,
        resetsAt: entry.bucket.resetsAt,
        tone: toneFromUsedPct(used),
      });
    });
  // The summary is about the Gemini buckets (the ones the rule acts on). A reading without them shows nothing rather
  // than presenting the 3p quota — which never triggers a switch — as if it were the account's limits.
  if (!windows.some((window) => window.id.startsWith("gemini"))) {
    return { status: "unavailable", problem: { kind: "no_quota", detail: "The last reading had no Gemini buckets." } };
  }
  return { status: "available", windows };
}
