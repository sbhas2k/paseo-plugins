// agy-rotator-windows — functional pairing of the scanned key (plan §3.7 "Pairing", R4-5; AC8).
//
// Ids and secrets sit ~665 KB apart in the binary, so pairing them by distance picks the wrong one — measured: the
// nearest secret belongs to a different client. The only reliable question is functional: **which pair actually mints a
// token**, and only an HTTP 200 answers it.
//
// Both `invalid_client` (wrong key) and `invalid_grant` (right client, dead grant) advance to the next pair: a valid other
// client answers `invalid_grant` for a token minted for a different one, so treating that as "the pair" — or as "the
// account is dead" — is wrong in both directions. Nothing here returns `needs sign-in`: that verdict belongs to the
// poller, once a pair is locked.
//
// The loop is bounded by pairs × slots (≤ 9 × 2) so a machine with a patched binary cannot spin.

export interface Pair {
  id: string;
  secret: string;
}

/** The refresh request, as data: the transport lives outside (one place, `redirect: "error"`). */
export interface RefreshRequest extends Pair {
  refreshToken: string;
}

/** What the token endpoint said, reduced to what a decision may use: the status and the OAuth error CODE only. */
export interface RefreshReply {
  status: number;
  /** `invalid_client` | `invalid_grant` | … — the code from the JSON body, never a message, never the response text. */
  error?: string;
}

export type PostRefresh = (request: RefreshRequest) => Promise<RefreshReply>;

export type PairingOutcome =
  | { kind: "locked"; pair: Pair; attempts: number }
  | { kind: "unresolved"; attempts: number }
  | { kind: "unavailable"; reason: "no-id" | "no-secret" };

export interface PairingInput {
  ids: readonly string[];
  secrets: readonly string[];
  /** One entry per saved slot that could be tried; `refreshToken` null means "not tried" (signed out / old blob). */
  slots: ReadonlyArray<{ key: string; refreshToken: string | null }>;
  post: PostRefresh;
  /** At most this many pairs are tried (plan: ≤ 9). */
  maxPairs?: number;
}

export const MAX_PAIRS = 9;

/** Does this pair mint a token for any of the slots? Only a 200 locks it. */
export async function findPairing(input: PairingInput): Promise<PairingOutcome> {
  if (input.ids.length === 0) return { kind: "unavailable", reason: "no-id" };
  if (input.secrets.length === 0) return { kind: "unavailable", reason: "no-secret" };

  const candidates: Pair[] = [];
  for (const id of input.ids) {
    for (const secret of input.secrets) {
      candidates.push({ id, secret });
      if (candidates.length >= (input.maxPairs ?? MAX_PAIRS)) break;
    }
    if (candidates.length >= (input.maxPairs ?? MAX_PAIRS)) break;
  }
  const slots = input.slots.filter((slot) => slot.refreshToken !== null);

  let attempts = 0;
  for (const pair of candidates) {
    for (const slot of slots) {
      attempts += 1;
      const reply = await input.post({ ...pair, refreshToken: slot.refreshToken as string });
      if (reply.status === 200) return { kind: "locked", pair, attempts };
      // invalid_client and invalid_grant both mean "not this pair for this token": keep looking.
    }
  }
  return { kind: "unresolved", attempts };
}
