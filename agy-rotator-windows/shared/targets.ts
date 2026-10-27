// agy-rotator-windows — the two names this plugin is allowed to touch, and the guards over them.
//
// `gemini:antigravity` is `agy`'s own sign-in (plan F1): type 1 (generic), persist 2 (local machine), user
// `antigravity`. A saved slot is its own generic credential under `paseo-agy-accounts:<key>` — deliberately OUTSIDE the
// `gemini:` prefix, which `agy`'s go-keyring `DeleteAll` sweeps on a `/logout` (r2 R2-1).
//
// Slice 2 lifts slice 1's blanket refusal of the live target for exactly two uses, and this file is where that is
// spelled out:
//   READ   — `liveReadable` (Save current account, the re-assert check, the switch's step (a)). Always safe.
//   WRITE  — `liveWriteable`, reachable only through `writeLive`, whose callers are the switch and the re-assert.
//   DELETE — never. `agy`'s own `/logout` is the only thing that may remove it; a plugin delete signs the owner out.
//
// Pure: no Paseo, no `node:` import — this file is bundled into the plugin's shared bundle.

export const LIVE_TARGET = "gemini:antigravity";
/**
 * The slot prefix is `paseo-agy-accounts:` and does NOT follow the plugin id (`agy-rotator-windows`), on purpose: these
 * names are in the owner's Windows Credential Manager. Renaming the prefix would orphan every saved sign-in at once — the
 * two real accounts included — and nothing in the vault would tell a reader which was which. The id changed once
 * (`agy-accounts` → `agy-rotator-windows`); the credentials did not move, and the whole point of the rename is that the
 * owner's accounts keep working. `test/slots.test.ts` pins the value.
 */
export const SLOT_PREFIX = "paseo-agy-accounts:";
export const CREDENTIAL_USER = "antigravity";
/** CRED_TYPE_GENERIC. */
export const CREDENTIAL_TYPE_GENERIC = 1;
/** CRED_PERSIST_LOCAL_MACHINE. */
export const CREDENTIAL_PERSIST_LOCAL_MACHINE = 2;

/** A slot target (or a throwaway stand-in for the live entry in tests, which is slot-shaped on purpose). */
const SLOT_TARGET = /^paseo-agy-accounts:[A-Za-z0-9._-]{1,128}$/;

export function isSlotTarget(target: string): boolean {
  return SLOT_TARGET.test(target);
}

/** The live entry or a slot may be READ. */
export function liveReadable(target: string): boolean {
  return target === LIVE_TARGET || isSlotTarget(target);
}

/** Only a slot may be written through the ordinary path; the live entry goes through `writeLive`. */
export function slotWritable(target: string): boolean {
  return isSlotTarget(target);
}

/** Where `writeLive` may write: the live entry itself, or a slot-shaped stand-in (the integration tests). */
export function liveWriteable(target: string): boolean {
  return target === LIVE_TARGET || isSlotTarget(target);
}

/** Nothing this plugin does may delete the live entry. */
export function deletable(target: string): boolean {
  return isSlotTarget(target);
}
