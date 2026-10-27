import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PLUGIN_VERSION, QUOTA_USER_AGENT } from "../shared/version.ts";
import { postQuota, postRefresh } from "../server/quota-transport.ts";

// S4.1 (Probe 3, 271fcf9b): the quota endpoint GATES on the `user-agent` header — it must contain "antigravity"
// (case-insensitive). Without one, undici's default is sent and the answer is 403; the body `{}` and the locked pair were
// always right. The matrix in the probe: `authorization` + `content-type` alone → 403; adding a UA → 200. `x-client-*`
// headers do nothing.
//
// These tests hold the request shape, because nothing else can: a missing UA is not a bug a type or a linter sees.

const UA_PATTERN = /antigravity/i;

interface Capture {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

function fakeFetch(status: number, body: unknown): { fetch: typeof fetch; calls: Capture[] } {
  const calls: Capture[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init as Capture["init"] });
    return {
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const deps = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, now: () => 1_000_000 });

test("the plugin's self-identifying user agent names agy-rotator-windows, its version and antigravity", () => {
  assert.equal(UA_PATTERN.test(QUOTA_USER_AGENT), true, "the endpoint refuses a UA without 'antigravity'");
  assert.match(QUOTA_USER_AGENT, /^agy-rotator-windows\//);
  assert.match(QUOTA_USER_AGENT, new RegExp(PLUGIN_VERSION.replace(/\./g, "\\.")));
});

test("the version in the user agent is the one in package.json, so the two cannot drift", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  assert.equal(pkg.version, PLUGIN_VERSION);
});

test("the quota request carries the user agent, the bearer token and a JSON content type", async () => {
  const fake = fakeFetch(200, { buckets: [{ modelName: "gemini-3.0-flash", remainingFraction: 0.9, resetTime: "2026-10-27T04:13:01Z" }] });
  const reply = await postQuota("token-1", deps(fake.fetch));
  assert.equal(reply.status, 200);
  const headers = fake.calls[0].init.headers ?? {};
  assert.equal(UA_PATTERN.test(String(headers["user-agent"])), true);
  assert.equal(headers["authorization"], "Bearer token-1");
  assert.equal(headers["content-type"], "application/json");
  // Probe 3: these do nothing, and a copied string is what the plan forbids — the UA must be our own.
  assert.equal("x-client-name" in headers, false);
  assert.equal("x-client-version" in headers, false);
  // R4-9: a redirect must never re-POST the token somewhere else.
  assert.equal(fake.calls[0].init.redirect, "error");
  // The body is the plan's `{}`.
  assert.equal(fake.calls[0].init.body, "{}");
});

test("the refresh call is unchanged: no user agent on the token endpoint", async () => {
  const fake = fakeFetch(200, { access_token: "at", expires_in: 3599 });
  const reply = await postRefresh({ clientId: "cid", clientSecret: "sec", refreshToken: "rt" }, deps(fake.fetch));
  assert.equal(reply.status, 200);
  assert.equal(reply.expiresAt, 1_000_000 + 3599 * 1000);
  const headers = fake.calls[0].init.headers ?? {};
  assert.equal("user-agent" in headers, false);
  assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(fake.calls[0].init.redirect, "error");
});

test("a 403 is a refused client: the status comes back, and no body text travels with it", async () => {
  const fake = fakeFetch(403, { error: "forbidden", error_description: "the client is not allowed here" });
  const reply = await postQuota("token-1", deps(fake.fetch));
  assert.deepEqual(reply, { status: 403 });
});

test("a 200 whose body has no gemini bucket is a 502, never an empty reading", async () => {
  const fake = fakeFetch(200, { buckets: [] });
  assert.equal((await postQuota("token-1", deps(fake.fetch))).status, 502);
});

test("a thrown fetch (network, refused redirect) is status 0, and still carries nothing else", async () => {
  const impl = (async () => {
    throw new Error("redirect to https://elsewhere.example/ refused");
  }) as unknown as typeof fetch;
  assert.deepEqual(await postQuota("token-1", deps(impl)), { status: 0 });
  assert.deepEqual(await postRefresh({ clientId: "c", clientSecret: "s", refreshToken: "r" }, deps(impl)), { status: 0 });
});
