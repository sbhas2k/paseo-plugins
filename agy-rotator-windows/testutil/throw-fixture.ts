// A test that DIES between writing its credentials and reaching any cleanup — the shape that leaked one target on
// 2026-10-27. It is not in `test/`, so a normal run never collects it; `test/leak-guard.test.ts` spawns it deliberately and
// then censuses the vault, which is the only honest proof that a failing test cleans up after itself.
import { createHash, randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { credWrite } from "../server/cred.ts";
import { sweepFixtures, trackFixture } from "./support.ts";

// The file-level sweep: this is what must still delete the fixtures when the test below throws.
after(sweepFixtures);

const hex16 = createHash("sha256").update(`throw-fixture-${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 16);

test("writes two fixtures, then throws before its own cleanup", async () => {
  const prefixed = `paseo-agy-accounts:test-throw-${randomBytes(4).toString("hex")}`;
  const hexTarget = `paseo-agy-accounts:${hex16}`;
  // Registered BEFORE the writes; a mutant that registers after them leaks the hex16 target, which has no `test-` prefix
  // to be swept by pattern.
  trackFixture(prefixed);
  trackFixture(hexTarget);
  await credWrite(prefixed, Buffer.from("synthetic"));
  await credWrite(hexTarget, Buffer.from("synthetic"));
  throw new Error("deliberate: a test that dies between its write and its finally");
});
