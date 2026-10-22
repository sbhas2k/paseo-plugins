import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PATTERNS,
  blockers,
  cliInvocation,
  matchProviderProcesses,
  parseCimProcesses,
  rescueState,
  type RescueAgent,
} from "../shared/rescue.ts";

const agent = (over: Partial<RescueAgent> = {}): RescueAgent => ({
  id: "a1",
  provider: "qoder",
  status: "error",
  lastError: "A foreground turn is already active",
  activeTurn: null,
  pendingPermissions: [],
  archivedAt: null,
  ...over,
});

// AC1 — stuck detection
test("every default pattern on an errored agent is stuck", () => {
  for (const text of [
    "A foreground turn is already active",
    "Timed out closing previous session during refresh",
    "Timeout waiting for message (60000ms)",
    "ACP agent exited unexpectedly",
    "Session is closed",
    "Session is not initialized",
  ]) {
    assert.equal(rescueState(agent({ lastError: text }), DEFAULT_PATTERNS), "stuck", text);
  }
});

test("an ordinary provider error is not stuck", () => {
  assert.equal(rescueState(agent({ lastError: "Queuing failed. Try again later or enter /model to switch models." }), DEFAULT_PATTERNS), "ok");
  assert.equal(rescueState(agent({ lastError: null }), DEFAULT_PATTERNS), "ok");
});

test("idle with the stuck text left over from a successful reload is not stuck", () => {
  assert.equal(rescueState(agent({ status: "idle" }), DEFAULT_PATTERNS), "ok");
});

test("a running agent or one with an active turn is never stuck", () => {
  assert.equal(rescueState(agent({ status: "running" }), DEFAULT_PATTERNS), "ok");
  assert.equal(rescueState(agent({ activeTurn: { id: "t1" } }), DEFAULT_PATTERNS), "ok");
});

test("closed with the stuck text is a reload in flight, not stuck", () => {
  assert.equal(rescueState(agent({ status: "closed" }), DEFAULT_PATTERNS), "reloading");
});

test("archived agents are ignored", () => {
  assert.equal(rescueState(agent({ archivedAt: "2026-10-22T00:00:00Z" }), DEFAULT_PATTERNS), "ok");
});

test("a pattern that is not a valid regex is matched as plain text", () => {
  assert.equal(rescueState(agent({ lastError: "weird (text" }), ["weird (text"]), "stuck");
});

// AC2 — the blocker guard
test("blockers name a same-provider sibling that is busy, and nothing else", () => {
  const all: RescueAgent[] = [
    agent({ id: "self" }),
    agent({ id: "running", status: "running", lastError: null }),
    agent({ id: "starting", status: "initializing", lastError: null }),
    agent({ id: "turn", status: "idle", activeTurn: { id: "t" }, lastError: null }),
    agent({ id: "perm", status: "idle", pendingPermissions: [{ id: "p" }], lastError: null }),
    agent({ id: "idle", status: "idle", lastError: null }),
    agent({ id: "other-provider", provider: "claude", status: "running" }),
    agent({ id: "archived", status: "running", archivedAt: "2026-10-01T00:00:00Z" }),
  ];
  assert.deepEqual(blockers(all, "qoder", "self").map((a) => a.id).sort(), ["perm", "running", "starting", "turn"]);
});

// AC3 — the CLI launch, no shell
test("cliInvocation runs the bundled CLI through Paseo.exe as node", () => {
  const inv = cliInvocation("C:\\Program Files\\Paseo\\Paseo.exe", ["agent", "reload", "x"], { PATH: "p" }, "win32");
  assert.equal(inv.file, "C:\\Program Files\\Paseo\\Paseo.exe");
  assert.deepEqual(inv.args, [
    "--disable-warning=DEP0040",
    "C:\\Program Files\\Paseo\\resources\\app.asar.unpacked\\dist\\daemon\\node-entrypoint-runner.js",
    "node-script",
    "C:\\Program Files\\Paseo\\resources\\app.asar\\node_modules\\@getpaseo\\cli\\dist\\index.js",
    "agent",
    "reload",
    "x",
  ]);
  assert.equal(inv.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(inv.env.PASEO_HOST, "");
  assert.equal(inv.env.PATH, "p");
});

test("outside the Windows desktop app the CLI is resolved from PATH", () => {
  for (const [execPath, platform] of [
    ["/Applications/Paseo.app/Contents/MacOS/Paseo", "darwin"],
    ["/usr/bin/node", "linux"],
    ["C:\\Program Files\\nodejs\\node.exe", "win32"],
  ] as const) {
    const inv = cliInvocation(execPath, ["agent", "reload", "x"], {}, platform);
    assert.equal(inv.file, "paseo", execPath);
    assert.equal(inv.viaPath, true, execPath);
    assert.deepEqual(inv.args, ["agent", "reload", "x"]);
  }
});

test("PASEO_CLI_PATH pointing at a .js entry runs it with the current executable", () => {
  const inv = cliInvocation("C:\\node\\node.exe", ["agent"], { PASEO_CLI_PATH: "D:\\cli\\index.js" }, "win32");
  assert.equal(inv.file, "C:\\node\\node.exe");
  assert.deepEqual(inv.args, ["D:\\cli\\index.js", "agent"]);
});

test("PASEO_CLI_PATH pointing at an executable runs it directly", () => {
  const inv = cliInvocation("C:\\node\\node.exe", ["agent"], { PASEO_CLI_PATH: "/usr/local/bin/paseo" }, "linux");
  assert.equal(inv.file, "/usr/local/bin/paseo");
  assert.deepEqual(inv.args, ["agent"]);
});

// AC5 (unit part) — which processes a restart may stop
test("only processes matching the pattern AND parented by the daemon are selected", () => {
  const json = JSON.stringify([
    { ProcessId: 13776, ParentProcessId: 23732, CommandLine: "C:\\q\\qodercli.exe --acp --dangerously-skip-permissions" },
    { ProcessId: 999, ParentProcessId: 4444, CommandLine: "C:\\q\\qodercli.exe --acp" },
    { ProcessId: 10720, ParentProcessId: 23732, CommandLine: "C:\\q\\qodercli.exe login" },
  ]);
  const procs = parseCimProcesses(json);
  assert.deepEqual(matchProviderProcesses(procs, "qodercli\\.exe.*--acp", 23732).map((p) => p.pid), [13776]);
});

test("a single CIM object (not an array) and empty output both parse", () => {
  assert.equal(parseCimProcesses(JSON.stringify({ ProcessId: 1, ParentProcessId: 2, CommandLine: "x" })).length, 1);
  assert.deepEqual(parseCimProcesses(""), []);
});
