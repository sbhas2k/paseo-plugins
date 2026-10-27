// agy-rotator-windows — the `agy.exe` census, through the same `-EncodedCommand` pattern as the credential helper.
//
// The predicate over the result lives in `shared/drift.ts` (`staleWriterExists`), so the interesting half is testable
// without spawning anything. This half only turns PowerShell into that shape.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseAgyCensus, type AgyProcess } from "../shared/census.ts";

const run = promisify(execFile);
const CENSUS_TIMEOUT_MS = 30_000;

/**
 * Every `agy.exe` of this user, with the moment it started and the name of its parent — the parent is what tells an
 * agent Paseo spawned (and the plugin reloaded) from a terminal the owner started by hand (S3's reminder, plan F8). `CreationDate` is formatted here rather than left to
 * `ConvertTo-Json`, because PowerShell 5.1 serialises a DateTime as `/Date(<ms>)/` and ISO parses everywhere.
 */
export async function listAgyProcesses(): Promise<AgyProcess[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$ProgressPreference = 'SilentlyContinue'; " +
    'Get-CimInstance Win32_Process -Filter "Name=\'agy.exe\'" | ' +
    "Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={ if ($null -eq $_.CreationDate) { $null } " +
    "else { $_.CreationDate.ToUniversalTime().ToString('o') } }},@{Name='ParentName';Expression={ try { " +
    "(Get-Process -Id $_.ParentProcessId -ErrorAction Stop).ProcessName } catch { $null } }} | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: CENSUS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return parseAgyCensus(String(stdout));
}
