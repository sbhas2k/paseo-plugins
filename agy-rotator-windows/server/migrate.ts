// agy-rotator-windows — the one-time move from the old plugin id's data directory (owner rename, 2026-10-27).
//
// The plugin id changed (`agy-accounts` → `agy-rotator-windows`), and the host keys plugin data and plugin settings by that
// id — so on the first start under the new name the owner's two saved accounts, the switch state and three settings would
// simply not be found. This copies them across, once, additively:
//
//   * only when the NEW index is absent (an existing one is never overwritten);
//   * only the three settings this plugin has ever had (`switchWhenUsedPct`, `autoSwitch`, `helpOpen`), never an
//     arbitrary document;
//   * the old directory is NEVER deleted — it is the only copy until the owner is satisfied;
//   * logged once, and the line names no credential and no account, only the two directory names.
//
// The Credential Manager targets are untouched by this: `paseo-agy-accounts:<key>` deliberately kept its name (see
// `shared/targets.ts`), so the saved sign-ins never moved.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PLUGIN_ID = "agy-rotator-windows";
export const LEGACY_PLUGIN_ID = "agy-accounts";

/** The only settings that exist; anything else in the old document is not carried. */
const CARRIED_SETTINGS = ["switchWhenUsedPct", "autoSwitch", "helpOpen"] as const;

export interface MigrationResult {
  migrated: boolean;
  /** The files written into the new directory, relative names only. */
  files: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the old plugin's data and settings to the new id's directories. Idempotent and safe to call on every start: it
 * does nothing once the new index exists.
 */
export async function migratePluginData(input: { paseoHome: string; log: (line: string) => void }): Promise<MigrationResult> {
  const oldData = path.join(input.paseoHome, "plugin-data", LEGACY_PLUGIN_ID);
  const newData = path.join(input.paseoHome, "plugin-data", PLUGIN_ID);
  const oldIndex = path.join(oldData, "index.json");
  const newIndex = path.join(newData, "index.json");

  if (!(await exists(oldIndex))) return { migrated: false, files: [] };
  if (await exists(newIndex)) return { migrated: false, files: [] };

  const files: string[] = [];
  await mkdir(newData, { recursive: true });
  for (const name of ["index.json", "state.json"]) {
    const from = path.join(oldData, name);
    if (!(await exists(from))) continue;
    await copyFile(from, path.join(newData, name));
    files.push(name);
  }

  // The settings document: the host envelope is `{ version, values }`; only the three carried keys are copied.
  const oldSettings = path.join(input.paseoHome, "plugin-settings", LEGACY_PLUGIN_ID, "config.json");
  if (await exists(oldSettings)) {
    try {
      const parsed = JSON.parse(await readFile(oldSettings, "utf8")) as { version?: unknown; values?: Record<string, unknown> };
      const values = parsed.values ?? {};
      const carried: Record<string, unknown> = {};
      for (const key of CARRIED_SETTINGS) if (key in values) carried[key] = values[key];
      if (Object.keys(carried).length > 0) {
        const newSettings = path.join(input.paseoHome, "plugin-settings", PLUGIN_ID, "config.json");
        await mkdir(path.dirname(newSettings), { recursive: true });
        await writeFile(newSettings, `${JSON.stringify({ version: typeof parsed.version === "number" ? parsed.version : 1, values: carried }, null, 2)}\n`, "utf8");
        files.push("plugin-settings/config.json");
      }
    } catch {
      // An unreadable old settings document is skipped: the defaults are safe, and guessing is not.
    }
  }

  if (files.length === 0) return { migrated: false, files: [] };
  input.log(`migrated ${files.length} file(s) from plugin-data/${LEGACY_PLUGIN_ID} - the old directory was left in place`);
  return { migrated: true, files };
}
