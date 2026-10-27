// agy-rotator-windows — the plugin's own identity for the one header the quota endpoint gates on (plan §3.7 as amended in Rev 5.2,
// Probe 3 `271fcf9b`).
//
// `POST v1internal:retrieveUserQuota` answers **403** unless the request carries a `user-agent` containing
// "antigravity" (case-insensitive); with one it answers 200. The `x-client-*` headers a copied string would carry do
// nothing, and copying the IDE's own UA is forbidden — so this is our own name, our own version.
//
// The version lives here as a constant rather than being read from `package.json` at runtime: the plugin is bundled, and a
// JSON import is not something to make the bundle depend on. `test/quota-transport.test.ts` asserts it EQUALS
// `package.json`'s version, so the two cannot drift.

export const PLUGIN_VERSION = "0.1.0";

/** `agy-rotator-windows/<version> (antigravity-cli)` — accepted by the endpoint (Probe 3 §2.2 tested this exact shape). */
export const QUOTA_USER_AGENT = `agy-rotator-windows/${PLUGIN_VERSION} (antigravity-cli)`;
