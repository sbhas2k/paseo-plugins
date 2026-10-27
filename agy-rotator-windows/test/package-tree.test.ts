import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CLIENT_ID_PATTERN, CLIENT_SECRET_PATTERN } from "../shared/keys.ts";

// S4 / AC8, publishing half: **no key value may ship**. The plugin reads the app key from the local binary at run time and
// keeps it in memory only, so nothing in this directory — source, tests, docs, README, manifest — may contain anything
// shaped like a Google client id or client secret.
//
// What this can see: literal values in the files that would be published (the whole package except `node_modules`).
// What it cannot see: a value assembled at run time from fragments — which is why the scan is the second line of defence,
// not the first; the first is that no code writes a key anywhere (`server/keyscan.ts` has no write path at all).

const ROOT = new URL("..", import.meta.url);
const SKIP = new Set(["node_modules", ".git", "dist"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

test("no file in the package — README included — carries a Google client id or secret", async () => {
  const files = await walk(ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.equal(files.length > 20, true, "the walk found almost nothing, so this test would pass vacuously");
  const names = files.map((file) => path.basename(file).toLowerCase());
  // The README is asserted explicitly: it is the file a reviewer reads, and the one most likely to quote an example.
  assert.equal(names.includes("readme.md"), true, "the README must be inside this sweep");

  const offenders: string[] = [];
  for (const file of files) {
    // Binary-ish files are skipped by extension only where a key cannot hide in text we publish.
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf)$/i.test(file)) continue;
    const text = await readFile(file, "utf8");
    if (new RegExp(CLIENT_ID_PATTERN.source, "i").test(text) || new RegExp(CLIENT_SECRET_PATTERN.source).test(text)) {
      // The path only — never the matched value, never into a log.
      offenders.push(path.relative(ROOT.pathname.replace(/^\/([A-Za-z]:)/, "$1"), file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("the scan module has no write path: the key cannot be persisted even if it were found", async () => {
  const source = await readFile(new URL("../server/keyscan.ts", import.meta.url), "utf8");
  for (const forbidden of ["writeFile", "appendFile", "createWriteStream"]) {
    assert.equal(source.includes(forbidden), false, `server/keyscan.ts must not ${forbidden}`);
  }
});
