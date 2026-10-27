// agy-rotator-windows — the drift rule (plan §3.5), the stale-writer census predicate it needs, and the shape a CIM
// creation date arrives in. Pure: no Paseo, no credential, no clock.
//
// Plan §3.5 with the r3 implementer notes that bind it:
//  (i)   an adoption is NOT a switch: it never reloads an agent. It only moves what the plugin expects and posts a
//        note, so the rule can re-evaluate on the next tick and self-heal (the adopted account is the depleted one).
//  (ii)  a missing live entry is a SIGNED-OUT state, never a drift. Between the owner's `/logout` and `/login` the
//        entry is absent (r1 F3: logout is a local `CredDeleteW`); writing into that gap would overwrite a sign-in
//        that is still in progress.
//  (iii) the caller re-reads a pending agent's status right before reloading it — the `turn_ended` payload carries no
//        status, and a queued follow-up prompt can make the agent running inside the same tick. That re-read lives in
//        `server/switch.ts`; the fold below just refuses to reload anything that is not idle.
//
// Two drift sources are indistinguishable from the entry alone (r2 R2-2):
//   (a) a stray `agy.exe` wrote the old account back at its own token refresh (F7/F12) — the case the rule is for;
//   (b) the owner typed `/logout` + login at the CLI on purpose — must be honoured, never reverted.
// The stale-writer census is the discriminator: a re-assert needs an `agy.exe` whose creation date precedes the
// plugin's own last `CredWrite`.

export type DriftState = "signed-out" | "ok" | "adopt-unknown" | "adopt-known" | "reassert";

/**
 * What to do about the live entry.
 *
 * `liveKey`   — the key of the email in the live blob, or null when there is no live entry / no usable email.
 * `expected`  — the account the plugin believes is active (null before it is primed, or after a signed-out read).
 * `knownKeys` — the keys of the saved slots.
 * `staleWriterExists` — an `agy.exe` older than the plugin's last `CredWrite` (see below).
 */
export function drift(
  liveKey: string | null,
  expected: string | null,
  knownKeys: readonly string[],
  staleWriterExists: boolean,
): DriftState {
  // (ii) signed out — the state the entry is in from `/logout` until `/login` completes.
  if (liveKey === null) return "signed-out";
  // Nothing to defend yet: with no expectation there is no blob to write back, so whatever is live is adopted.
  if (expected === null) return knownKeys.includes(liveKey) ? "adopt-known" : "adopt-unknown";
  if (liveKey === expected) return "ok";
  if (!knownKeys.includes(liveKey)) return "adopt-unknown";
  // A known account that is not the expected one: only a stale writer can justify writing the expected one back.
  return staleWriterExists ? "reassert" : "adopt-known";
}

export interface AgyProcess {
  pid: number;
  /** RFC3339, or whatever the census could parse; an unparseable date never justifies a re-assert. */
  creationDate: unknown;
  /** The parent's process name (`Paseo` for an agent the daemon spawned), when the census knows it. */
  parentName?: string | null;
}

/**
 * Is there an `agy.exe` that started before the plugin's last `CredWrite`? Such a process still holds the old sign-in
 * in memory and will write it back at its next token refresh (F7), so the plugin's write is what needs re-asserting.
 * A plugin that has never written has nothing to defend: false, and the live account is adopted.
 */
export function staleWriterExists(processes: readonly AgyProcess[], lastCredWriteAt: string | null): boolean {
  if (lastCredWriteAt === null) return false;
  const written = Date.parse(lastCredWriteAt);
  if (!Number.isFinite(written)) return false;
  return processes.some((process) => {
    const created = parseCimCreationDate(process.creationDate);
    return created !== null && created < written;
  });
}

/**
 * `Get-CimInstance … | Select-Object ProcessId,CreationDate | ConvertTo-Json` arrives as ISO when the script formats
 * it, and as PowerShell 5.1's `/Date(<ms>)/` when it does not. Both are accepted; anything else is null.
 */
export function parseCimCreationDate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const dotnet = /^\/Date\((-?\d+)\)\/$/.exec(text);
  if (dotnet) {
    const ms = Number(dotnet[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  const iso = Date.parse(text);
  return Number.isFinite(iso) ? iso : null;
}
