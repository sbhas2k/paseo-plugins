// agy-rotator-windows — the Windows Credential Manager half of the vault, and the only place a credential blob is handled.
//
// Why a `powershell.exe` child and not a native binding (plan §4, challenger F9, AC3):
//  - the blob must never appear on a command line — `Win32_Process.CommandLine` is readable by every process of the
//    user — so the script is passed with `-EncodedCommand` and BOTH the request and the answer travel as base64 on
//    stdin/stdout, decoded and encoded in Node;
//  - PowerShell 5.1 re-encodes text on its pipes (OEM/ANSI page, BOM, a trailing newline from `Write-Output`), which
//    would corrupt a 560-byte JSON blob and sign the account out. The helper therefore reads and writes RAW BYTES on
//    `[Console]::OpenStandardInput()` / `OpenStandardOutput()`, never `Write-Output`, and the C# side moves
//    `byte[]` in and out of the credential, so no text encoding is involved at any point.
//
// Type 1 (CRED_TYPE_GENERIC), persist 2 (CRED_PERSIST_LOCAL_MACHINE), user `antigravity`: the shape `agy` itself
// writes (plan F1, challenger F15). Target names are restricted to `paseo-agy-accounts:…` — deliberately OUTSIDE the
// `gemini:` prefix that `agy`'s go-keyring `DeleteAll` sweeps (R2-1) — and `gemini:antigravity` is refused here, so
// The live entry `gemini:antigravity` is reachable through this module in exactly two ways, both guarded by
// `shared/targets.ts`: `credRead` (always safe) and `writeLive` (the switch and the re-assert only). `credDelete` never
// touches it and the ordinary `credWrite` never does either. `credMeta` reads metadata only — never the blob — which is
// what the S2 gate uses to prove the live entry was not written.


import { spawn } from "node:child_process";
import { deletable, liveReadable, liveWriteable, slotWritable } from "../shared/targets.ts";

const HELPER_TIMEOUT_MS = 30_000;


export class CredentialNotFound extends Error {
  constructor(target: string) {
    super(`No credential named ${target}.`);
    this.name = "CredentialNotFound";
  }
}

function refuse(target: string): never {
  throw new Error(`Refusing to touch credential ${JSON.stringify(target)}.`);
}

/**
 * The helper, as one PowerShell script. Executed with `-NoProfile -NonInteractive -EncodedCommand <base64 utf16le>`,
 * reads one JSON request on stdin and writes one JSON answer on stdout:
 *
 *   {"op":"read","target":"…"}                                     -> {"ok":true,"blob":"<base64>"}
 *                                                                     {"ok":false,"code":"not_found"}
 *   {"op":"write","target":"…","blob":"<base64>","persist":2,…}     -> {"ok":true}
 *   {"op":"delete","target":"…"}                                   -> {"ok":true} | {"ok":false,"code":"not_found"}
 *
 * The request is ASCII by construction (base64 payload + a target/key), so decoding it with `ASCII` is lossless.
 * No backticks in this text: it lives inside a template literal.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$response = '{"ok":false,"code":"helper","error":"the helper produced no answer"}'

function Write-Response([string]$json) {
  $stream = [Console]::OpenStandardOutput()
  $bytes = [Text.Encoding]::ASCII.GetBytes($json)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

function Quote([string]$text) {
  return (ConvertTo-Json -InputObject $text -Compress)
}

try {
  $stdin = [Console]::OpenStandardInput()
  $buffer = New-Object System.IO.MemoryStream
  $stdin.CopyTo($buffer)
  $requestText = [Text.Encoding]::ASCII.GetString($buffer.ToArray())
  $request = $requestText | ConvertFrom-Json

  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Paseo {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  public static class Cred {
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredEnumerate(string filter, uint flags, out int count, out IntPtr credentials);

    [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
    public static extern void CredFree(IntPtr buffer);
  }
}
'@

  $op = [string]$request.op
  $target = [string]$request.target
  $type = 1
  if ($null -ne $request.type) { $type = [int]$request.type }
  $ERROR_NOT_FOUND = 1168

  if ($op -eq 'read') {
    $ptr = [IntPtr]::Zero
    if (-not [Paseo.Cred]::CredRead($target, [uint32]$type, 0, [ref]$ptr)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -eq $ERROR_NOT_FOUND) {
        $response = '{"ok":false,"code":"not_found"}'
      } else {
        $response = '{"ok":false,"code":"win32","error":' + (Quote ('CredRead ' + $code)) + '}'
      }
    } else {
      try {
        $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][Paseo.CREDENTIAL])
        $size = [int]$cred.CredentialBlobSize
        $bytes = New-Object 'byte[]' $size
        if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $size) }
        $response = '{"ok":true,"blob":"' + [Convert]::ToBase64String($bytes) + '"}'
      } finally {
        [Paseo.Cred]::CredFree($ptr)
      }
    }
  }
  elseif ($op -eq 'enumerate') {
    # Names only (plan §3.7 slot hygiene / AC11): CredEnumerateW filtered to this plugin's prefix. No blob is read.
    # CredEnumerateW matches with star wildcards; a bare prefix would only match a target with that exact name.
    $filter = [string]$request.filter + '*'
    $count = 0
    $ptr = [IntPtr]::Zero
    if ([Paseo.Cred]::CredEnumerate($filter, 0, [ref]$count, [ref]$ptr)) {
      try {
        $names = New-Object System.Collections.ArrayList
        for ($i = 0; $i -lt $count; $i++) {
          $item = [Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
          $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($item, [Type][Paseo.CREDENTIAL])
          [void]$names.Add([string]$cred.TargetName)
        }
        $response = '{"ok":true,"targets":' + (ConvertTo-Json -InputObject $names.ToArray() -Compress) + '}'
      } finally {
        [Paseo.Cred]::CredFree($ptr)
      }
    } else {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -eq 1168) {
        $response = '{"ok":true,"targets":[]}'
      } else {
        $response = '{"ok":false,"code":"win32","error":' + (Quote ('CredEnumerate ' + $code)) + '}'
      }
    }
  }
  elseif ($op -eq 'meta') {
    $ptr = [IntPtr]::Zero
    if (-not [Paseo.Cred]::CredRead($target, [uint32]$type, 0, [ref]$ptr)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -eq $ERROR_NOT_FOUND) {
        $response = '{"ok":false,"code":"not_found"}'
      } else {
        $response = '{"ok":false,"code":"win32","error":' + (Quote ('CredRead ' + $code)) + '}'
      }
    } else {
      try {
        $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [Type][Paseo.CREDENTIAL])
        $written = [DateTime]::FromFileTime([int64]$cred.LastWritten).ToUniversalTime().ToString('o')
        $response = '{"ok":true,"meta":{"type":' + [int]$cred.Type + ',"persist":' + [int]$cred.Persist + ',"user":' + (Quote ([string]$cred.UserName)) + ',"comment":' + (Quote ([string]$cred.Comment)) + ',"lastWritten":' + (Quote $written) + ',"size":' + [int]$cred.CredentialBlobSize + '}}'
      } finally {
        [Paseo.Cred]::CredFree($ptr)
      }
    }
  }
  elseif ($op -eq 'write') {
    $blobBytes = [Convert]::FromBase64String([string]$request.blob)
    $user = 'antigravity'
    if ($null -ne $request.user) { $user = [string]$request.user }
    $persist = 2
    if ($null -ne $request.persist) { $persist = [int]$request.persist }
    $cred = [Paseo.CREDENTIAL]::new()
    $cred.Type = [uint32]$type
    $cred.Persist = [uint32]$persist
    $cred.TargetName = $target
    $cred.UserName = $user
    $cred.Comment = 'paseo-agy-accounts slot'
    $cred.CredentialBlobSize = [uint32]$blobBytes.Length
    $cred.CredentialBlob = [Runtime.InteropServices.Marshal]::AllocHGlobal([Math]::Max($blobBytes.Length, 1))
    try {
      if ($blobBytes.Length -gt 0) {
        [Runtime.InteropServices.Marshal]::Copy($blobBytes, 0, $cred.CredentialBlob, $blobBytes.Length)
      }
      if (-not [Paseo.Cred]::CredWrite([ref]$cred, 0)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $response = '{"ok":false,"code":"win32","error":' + (Quote ('CredWrite ' + $code)) + '}'
      } else {
        $response = '{"ok":true}'
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob)
    }
  }
  elseif ($op -eq 'delete') {
    if ([Paseo.Cred]::CredDelete($target, [uint32]$type, 0)) {
      $response = '{"ok":true}'
    } else {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($code -eq $ERROR_NOT_FOUND) {
        $response = '{"ok":false,"code":"not_found"}'
      } else {
        $response = '{"ok":false,"code":"win32","error":' + (Quote ('CredDelete ' + $code)) + '}'
      }
    }
  }
  else {
    $response = '{"ok":false,"code":"bad_request","error":"unknown op"}'
  }
}
catch {
  $response = '{"ok":false,"code":"helper","error":' + (Quote $_.Exception.Message) + '}'
}

Write-Response $response
`;

/** The fixed argv: script only, never a blob, never a target (challenger P20/AC7). */
export function helperArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS_SCRIPT, "utf16le").toString("base64")];
}

interface HelperRequest {
  op: "read" | "write" | "delete" | "meta" | "enumerate";
  filter?: string;
  target: string;
  blob?: string;
  user?: string;
  persist?: number;
  type?: number;
}

/** Metadata only: never the credential's bytes. */
export interface CredentialMeta {
  type: number;
  persist: number;
  user: string;
  /**
   * The entry's own Comment — this plugin writes "paseo-agy-accounts slot", so it says who last wrote it. The marker
   * deliberately keeps the original name: it is a stamp that has to match writes made before the rename, and it names the
   * credential family (which did not move), not the plugin.
   */
  comment: string;
  /** The entry's own LastWritten, RFC3339 UTC — how the S2 gate proves the live entry was not written. */
  lastWritten: string;
  size: number;
}

interface HelperReply {
  ok: boolean;
  code?: string;
  error?: string;
  blob?: string;
  meta?: CredentialMeta;
  targets?: string[];
}

/** One helper run. The blob goes in on stdin and comes back on stdout; it is never on argv and never logged. */
function runHelper(request: HelperRequest): Promise<HelperReply> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("agy-rotator-windows reads the Windows Credential Manager, which only exists on Windows."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", helperArgs(), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error(`The credential helper did not answer within ${HELPER_TIMEOUT_MS / 1000}s.`);
      child.kill();
    }, HELPER_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    // The child may exit before reading its request (a broken PowerShell install): never an unhandled EPIPE.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      const stdout = Buffer.concat(out).toString("latin1").trim();
      const reply = parseReply(stdout);
      if (!reply) {
        // Deliberately never echoes stdout: on a read it holds the credential blob.
        const stderr = Buffer.concat(err).toString("utf8").trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" | ");
        reject(
          new Error(
            `The credential helper answered nothing usable (exit ${String(code)}, ${stdout.length} bytes on stdout)` +
              (stderr ? `: ${stderr.slice(0, 300)}` : "."),
          ),
        );
        return;
      }
      resolve(reply);
    });
    child.stdin.end(Buffer.from(JSON.stringify(request), "ascii"));
  });
}

function parseReply(text: string): HelperReply | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as HelperReply;
    return typeof parsed === "object" && parsed !== null && typeof parsed.ok === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

async function callHelper(request: HelperRequest): Promise<HelperReply> {
  const reply = await runHelper(request);
  if (!reply.ok) {
    if (reply.code === "not_found") throw new CredentialNotFound(request.target);
    throw new Error(`The credential helper refused ${request.op}: ${reply.code ?? "unknown"}${reply.error ? ` (${reply.error})` : ""}`);
  }
  return reply;
}

/** The blob stored under `target`, or null when the entry does not exist (a signed-out state, not an error). */
export async function credRead(target: string): Promise<Buffer | null> {
  if (!liveReadable(target)) refuse(target);
  try {
    const reply = await callHelper({ op: "read", target });
    return Buffer.from(reply.blob ?? "", "base64");
  } catch (error) {
    if (error instanceof CredentialNotFound) return null;
    throw error;
  }
}

/** Writes a SLOT's blob byte-for-byte. Overwrites an existing slot. The live entry is refused here. */
export async function credWrite(target: string, blob: Buffer): Promise<void> {
  if (!slotWritable(target)) refuse(target);
  await callHelper({ op: "write", target, blob: blob.toString("base64") });
}

/**
 * Writes the LIVE target (or a slot-shaped stand-in, which is how the integration tests run the real sequence).
 * Only the switch (§3.4(b)) and the re-assert (§3.5) call this — the two places the plan allows a write to `agy`'s
 * own entry. Nothing else in the plugin may.
 */
export async function writeLive(target: string, blob: Buffer): Promise<void> {
  if (!liveWriteable(target)) refuse(target);
  await callHelper({ op: "write", target, blob: blob.toString("base64") });
}

/** Deletes a SLOT; false when there was none. The live entry is never deletable from here. */
export async function credDelete(target: string): Promise<boolean> {
  if (!deletable(target)) refuse(target);
  try {
    await callHelper({ op: "delete", target });
    return true;
  } catch (error) {
    if (error instanceof CredentialNotFound) return false;
    throw error;
  }
}

/** Type, persist, user, LastWritten and size of an entry — read without its blob (the S2 gate's proof). */
export async function credMeta(target: string): Promise<CredentialMeta | null> {
  if (!liveReadable(target)) refuse(target);
  try {
    const reply = await callHelper({ op: "meta", target });
    return reply.meta ?? null;
  } catch (error) {
    if (error instanceof CredentialNotFound) return null;
    throw error;
  }
}

/**
 * Every credential target whose name starts with `filter` — NAMES ONLY, no blob (plan §3.7 slot hygiene, AC11). This is
 * the census the "Clean up" button and the test suite's before/after proof use; `cmdkey /list` was rejected because its
 * output is localised text.
 */
export async function credEnumerate(filter: string): Promise<string[]> {
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(filter)) refuse(filter);
  const reply = await callHelper({ op: "enumerate", target: filter, filter });
  return (reply.targets ?? []).filter((target) => typeof target === "string" && target.startsWith(filter));
}
