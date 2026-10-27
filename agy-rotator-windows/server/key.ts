// agy-rotator-windows — the ONE account key (challenger T4): `hashAccountKey(email).slice(0, 16)`.
//
// `hashAccountKey` is the SDK's own sha256-hex (usage.js:101-103) and `UsageAccount.key` documents "never a
// credential or raw email", so the slot target, `index.json` and the usage source all use this one function. An email
// is only ever hashed here and then dropped: it is never written to disk, never logged and never sent over an RPC.
//
// This lives in `server/`, not `shared/`: it imports `@getpaseo/plugin/server/*`, and the plugin build refuses a
// server-only module inside the shared bundle ("server-only module cannot be imported into the plugin shared bundle" —
// caught by the slice-1 install). `shared/slots.ts` therefore takes the key function as a parameter instead. The
// client never computes a key; it receives one from the server.

import { hashAccountKey } from "@getpaseo/plugin/server/usage";

/** Sixteen hex characters: enough to collide nowhere in practice, short enough for a credential target. */
export const KEY_LENGTH = 16;

export function accountKey(email: string): string {
  return hashAccountKey(email.trim()).slice(0, KEY_LENGTH);
}
