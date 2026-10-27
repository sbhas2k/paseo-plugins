// agy-rotator-windows — the `agy.exe` census, parsed. Pure: the PowerShell call lives in `server/census.ts`.
//
// The census is how the plugin tells "a stray agy wrote the old account back" (F7/F12 — the case a re-assert is for)
// from "the owner signed in at the CLI on purpose" (which is never reverted, R2-2). Both are the same entry state; the
// only discriminator is a live process older than the plugin's own last write.

import { parseCimCreationDate, type AgyProcess } from "./drift.ts";

export type { AgyProcess } from "./drift.ts";

/**
 * `Get-CimInstance Win32_Process -Filter "Name='agy.exe'" | Select-Object ProcessId,CreationDate | ConvertTo-Json`
 * answers an array, a single object, nothing at all, or noise. Only rows with a usable pid survive; a row without a
 * parseable creation date survives with `null`, and `staleWriterExists` then refuses to count it.
 */
export function parseAgyCensus(json: string): AgyProcess[] {
  if (json.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: AgyProcess[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    const parent = record.ParentName;
    processes.push({
      pid,
      creationDate: parseCimCreationDate(record.CreationDate) === null ? null : record.CreationDate,
      parentName: typeof parent === "string" && parent.trim().length > 0 ? parent.trim() : null,
    });
  }
  return processes;
}
