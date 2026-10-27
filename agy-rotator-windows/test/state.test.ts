import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { emptyPluginState, pluginStatePath, readPluginState, writePluginState } from "../server/state.ts";
import { pluginDataDir } from "../server/store.ts";
import { withTempPaseoHome } from "../testutil/support.ts";

/** The plugin-data directory, created so a test can write a state file by hand. */
const mkdirForTest = () => mkdir(pluginDataDir(), { recursive: true });

// S3 — the plugin remembers, across a daemon restart, which account it expects and when it last switched.
//
// Why: S2 kept `expected` in memory. A restart then primed it from whatever was live — the same answer the re-assert
// would reach, but it silently forgot that a switch had just happened, so the ping-pong guard started from zero and an
// automatic switch could fire seconds after a manual one. Persisted in the plugin's own data directory (no secret is
// here: a 16-hex key, a label the owner typed, and two timestamps).

test("a fresh install has no expectation and no previous switch", async () => {
  await withTempPaseoHome(async () => {
    assert.deepEqual(await readPluginState(), emptyPluginState());
  });
});

test("the expected account and the last switch survive a round trip", async () => {
  await withTempPaseoHome(async () => {
    const written = {
      ...emptyPluginState(),
      expected: { key: "0123456789abcdef", label: "Work" },
      lastSwitchAt: "2026-10-26T14:00:00.000Z",
      lastSwitch: { at: "2026-10-26T14:00:00.000Z", fromLabel: "Personal", toKey: "0123456789abcdef", toLabel: "Work" },
      updatedAt: "2026-10-26T14:00:00.000Z",
    };
    await writePluginState(written);
    assert.deepEqual(await readPluginState(), written);
  });
});

test("a corrupt or partial state file is an empty state, never a throw", async () => {
  await withTempPaseoHome(async () => {
    const path = pluginStatePath();
    await mkdirForTest();
    for (const text of ["", "not json", "[]", JSON.stringify({ expected: { key: 5 } }), JSON.stringify({ expected: { key: "k" } })]) {
      await writeFile(path, text, "utf8");
      const state = await readPluginState();
      assert.equal(state.expected, null, text);
      assert.equal(state.lastSwitchAt, null, text);
      assert.equal(state.lastSwitch, null, text);
    }
  });
});

test("a state file with fields this version does not know is read, not rejected", async () => {
  await withTempPaseoHome(async () => {
    await mkdirForTest();
    await writeFile(
      pluginStatePath(),
      JSON.stringify({ expected: { key: "0123456789abcdef", label: "Work" }, lastSwitchAt: null, futureField: "ignored" }),
      "utf8",
    );
    const state = await readPluginState();
    assert.deepEqual(state.expected, { key: "0123456789abcdef", label: "Work" });
    assert.equal(state.lastSwitchAt, null);
  });
});

test("the file lives in the plugin's own data directory and carries no secret", async () => {
  await withTempPaseoHome(async () => {
    const written = {
      ...emptyPluginState(),
      expected: { key: "0123456789abcdef", label: "Work" },
      lastSwitch: { at: "2026-10-26T14:00:00.000Z", fromLabel: "Personal", toKey: "fedcba9876543210", toLabel: "Work" },
    };
    await writePluginState(written);
    assert.match(pluginStatePath(), /plugin-data[\\/]agy-rotator-windows[\\/]state\.json$/);
    const text = JSON.stringify(written);
    for (const forbidden of ["@", "access_token", "refresh_token", "Bearer", "id_token"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    // The atomic write leaves nothing behind.
    assert.deepEqual((await readdir(pluginStatePath().replace(/[\\/]state\.json$/, ""))).sort(), ["state.json"]);
  });
});

test("writing replaces the previous state rather than merging it", async () => {
  await withTempPaseoHome(async () => {
    await writePluginState({ ...emptyPluginState(), expected: { key: "a", label: "A" }, lastSwitchAt: "2026-10-26T10:00:00.000Z" });
    await writePluginState({ ...emptyPluginState(), expected: { key: "b", label: "B" } });
    const state = await readPluginState();
    assert.deepEqual(state.expected, { key: "b", label: "B" });
    assert.equal(state.lastSwitchAt, null);
  });
});
