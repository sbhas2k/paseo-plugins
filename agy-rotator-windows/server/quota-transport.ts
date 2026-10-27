// agy-rotator-windows — the two HTTP calls, with the hygiene the plan fixes (R4-9).
//
// `redirect: "error"` is the load-bearing one: Node's default follows a redirect and RE-POSTS the body — which here is the
// client secret and a refresh token — to whatever the redirect target is. An error carries `{ status, error }` only: never
// `error_description`, never the response text, never the request, because a poller error can reach an RPC handler and be
// forwarded to the client.

import { QUOTA_URL, refreshBody, TOKEN_URL, parseQuotaBuckets } from "../shared/quota-api.ts";
import { QUOTA_USER_AGENT } from "../shared/version.ts";
import type { QuotaReply, TokenReply } from "./poller.ts";

export interface TransportDeps {
  fetch: typeof fetch;
  now: () => number;
}

/** The refresh grant. A 200 carries the access token and the expiry the response reports (or one hour). */
export async function postRefresh(
  input: { clientId: string; clientSecret: string; refreshToken: string },
  deps: TransportDeps,
): Promise<TokenReply> {
  try {
    const response = await deps.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: refreshBody(input),
      redirect: "error",
    });
    if (response.status !== 200) {
      const error = await readErrorCode(response);
      return error === undefined ? { status: response.status } : { status: response.status, error };
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || body.access_token.length === 0) return { status: 502 };
    const lifetime = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : 3600;
    return { status: 200, accessToken: body.access_token, expiresAt: deps.now() + lifetime * 1000 };
  } catch {
    // Network failure, a refused redirect, a body that is not JSON: a status this poller treats as transient.
    return { status: 0 };
  }
}

/**
 * `POST retrieveUserQuota {}` with the access token. Only a 200 with a parseable gemini bucket is a reading.
 *
 * The `user-agent` is load-bearing (Rev 5.2 / Probe 3): the endpoint gates on a UA containing "antigravity" and answers
 * 403 without one. `x-client-name`/`x-client-version` are deliberately absent — measured to change nothing.
 */
export async function postQuota(accessToken: string, deps: TransportDeps): Promise<QuotaReply> {
  try {
    const response = await deps.fetch(QUOTA_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": QUOTA_USER_AGENT },
      body: "{}",
      redirect: "error",
    });
    if (response.status !== 200) return { status: response.status };
    const buckets = parseQuotaBuckets(await response.json());
    return buckets === null ? { status: 502 } : { status: 200, buckets };
  } catch {
    return { status: 0 };
  }
}

/** The OAuth error CODE from the body, or undefined. Never a description, never the raw text. */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{3,40}$/.test(body.error) ? body.error : undefined;
  } catch {
    return undefined;
  }
}
