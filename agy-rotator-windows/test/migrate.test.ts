import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { LEGACY_PLUGIN_ID, PLUGIN_ID, migratePluginData } from "../server/migrate.ts";
import { withTempPaseoHome } from "../testutil/support.ts";

// The rename `agy-accounts` → `agy-rotator-windows` (owner, 2026-10-27) moves the plugin id, and with it the plugin's own
// data directory. The owner has two real saved accounts, a switch history and three settings; none of it may be lost by a
// directory that simply changed its name.
//
// One-time, additive, and never destructive: if the new directory already has an index, nothing happens; the old
// directory is never deleted (it is the only copy until the owner is satisfied); and only the three settings this plugin
// has ever had are carried over — not an arbitrary blob of the old document.

const oldDir = (home: string) => path.join(home, "plugin-data", LEGACY_PLUGIN_ID);
const newDir = (home: string) => path.join(home, "plugin-data", PLUGIN_ID);
const oldPrefs = (home: string) => path.join(home, "plugin-settings", LEGACY_PLUGIN_ID, "config.json");
const newPrefs = (home: string) => path.join(home, "plugin-settings", PLUGIN_ID, "config.json");

const index = JSON.stringify([{ key: "0123456789abcdef", label: "Work", savedAt: "2026-10-27T01:00:00Z", lastUsage: null, order: 0 }]);
const state = JSON.stringify({ expected: { key: "0123456789abcdef", label: "Work" }, lastSwitchAt: null, lastSwitch: null, updatedAt: "" });
const prefs = JSON.stringify({ version: 1, values: { switchWhenUsedPct: 37, autoSwitch: false, helpOpen: true, somethingElse: "not carried" } });

async function seedOld(home: string, options: { index?: boolean; state?: boolean; prefs?: boolean } = {}) {
  await mkdir(oldDir(home), { recursive: true });
  if (options.index !== false) await writeFile(path.join(oldDir(home), "index.json"), index, "utf8");
  if (options.state !== false) await writeFile(path.join(oldDir(home), "state.json"), state, "utf8");
  if (options.prefs !== false) {
    await mkdir(path.dirname(oldPrefs(home)), { recursive: true });
    await writeFile(oldPrefs(home), prefs, "utf8");
  }
}

test("the ids are the ones the rename actually used", () => {
  assert.equal(PLUGIN_ID, "agy-rotator-windows");
  assert.equal(LEGACY_PLUGIN_ID, "agy-accounts");
});

test("a first start under the new id carries the index, the switch state and the three settings across", async () => {
  await withTempPaseoHome(async (home) => {
    await seedOld(home);
    const logged: string[] = [];
    const result = await migratePluginData({ paseoHome: home, log: (line) => logged.push(line) });
    assert.equal(result.migrated, true);
    assert.equal(await readFile(path.join(newDir(home), "index.json"), "utf8"), index);
    assert.equal(await readFile(path.join(newDir(home), "state.json"), "utf8"), state);
    const written = JSON.parse(await readFile(newPrefs(home), "utf8")) as { values: Record<string, unknown> };
    assert.deepEqual(written.values, { switchWhenUsedPct: 37, autoSwitch: false, helpOpen: true });
    // Logged once, and the line names no path the owner has to understand.
    assert.equal(logged.length, 1);
    assert.match(logged[0], /agy-accounts/);
    // The old directory is still there — it is the only copy until the owner is satisfied.
    assert.equal((await readdir(oldDir(home))).sort().join(","), "index.json,state.json");
  });
});

test("the second start does nothing at all", async () => {
  await withTempPaseoHome(async (home) => {
    await seedOld(home);
    const first = await migratePluginData({ paseoHome: home, log: () => {} });
    assert.equal(first.migrated, true);
    const second = await migratePluginData({ paseoHome: home, log: () => {} });
    assert.equal(second.migrated, false);
    assert.deepEqual(second.files, []);
  });
});

test("a new index already present is never overwritten", async () => {
  await withTempPaseoHome(async (home) => {
    await seedOld(home);
    await mkdir(newDir(home), { recursive: true });
    const mine = JSON.stringify([{ key: "fedcba9876543210", label: "Newer", savedAt: "2026-10-27T02:00:00Z", lastUsage: null, order: 0 }]);
    await writeFile(path.join(newDir(home), "index.json"), mine, "utf8");
    const result = await migratePluginData({ paseoHome: home, log: () => {} });
    assert.equal(result.migrated, false);
    assert.equal(await readFile(path.join(newDir(home), "index.json"), "utf8"), mine);
  });
});

test("no old directory is no migration, not a crash", async () => {
  await withTempPaseoHome(async (home) => {
    const logged: string[] = [];
    assert.deepEqual(await migratePluginData({ paseoHome: home, log: (line) => logged.push(line) }), { migrated: false, files: [] });
    assert.deepEqual(logged, []);
  });
});

test("a partial old directory migrates what is there and says which parts", async () => {
  await withTempPaseoHome(async (home) => {
    await seedOld(home, { index: true, state: false, prefs: false });
    const result = await migratePluginData({ paseoHome: home, log: () => {} });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files.sort(), ["index.json"]);
    assert.equal(await readFile(path.join(newDir(home), "index.json"), "utf8"), index);
  });
});

test("unreadable old settings are skipped rather than guessed at", async () => {
  await withTempPaseoHome(async (home) => {
    await seedOld(home, { prefs: false });
    await mkdir(path.dirname(oldPrefs(home)), { recursive: true });
    await writeFile(oldPrefs(home), "not json", "utf8");
    const result = await migratePluginData({ paseoHome: home, log: () => {} });
    assert.equal(result.migrated, true);
    assert.deepEqual(result.files.sort(), ["index.json", "state.json"]);
  });
});

test("the daemon runs the migration before it reads its own state (the wiring, not just the function)", () => {
  // A perfect migration that nothing calls is the defect this asserts against: the mutant is deleting the call.
  const source = readFileSync(new URL("../index.server.ts", import.meta.url), "utf8");
  const migrateAt = source.indexOf("migratePluginData({ paseoHome: paseoHome()");
  const stateAt = source.indexOf("persisted = await readPluginState()");
  assert.notEqual(migrateAt, -1, "index.server.ts never calls migratePluginData");
  assert.notEqual(stateAt, -1);
  assert.equal(migrateAt < stateAt, true, "the migration must run before the state is read");
});
