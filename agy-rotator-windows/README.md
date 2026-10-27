# agy rotator (Windows)

Paseo plugin `agy-rotator-windows`. It keeps **several Antigravity (`agy`) sign-ins** on one Windows machine, watches how
much of each account's Gemini quota is left, and **rotates to the next saved account — in your order — when the active one
runs low**. Requires Paseo 0.13.0 or newer.

**Windows only, on purpose.** `agy` keeps exactly one sign-in per Windows user, in Credential Manager under
`gemini:antigravity`; there is no `HOME` trick that separates two accounts there. On Linux and macOS
[antigravity-cli](https://github.com/lefos13/antigravity-cli) already supports multiple accounts natively — use that
instead.

## What it does

- **Save each sign-in once.** Sign in with `agy` as you normally do, open the plugin, press **Save account** and give it a
  name ("Work", "Personal"). The plugin reads the live sign-in and stores it as its own Credential Manager entry, keyed by
  a hash of the account inside it — never by the name you typed, and never by an email.
- **Rotate at a number you choose.** The setting is **"Switch when used ≥ N %"** (default 80, anything from 1 to 99 with
  decimals; 100 is refused, because it would only switch once the account was already empty). Whichever Gemini bucket runs
  out first — the 5-hour or the weekly — triggers the move.
- **In your sequence.** Accounts are tried in their numbered order, starting after the active one and wrapping around to
  the top. An account still at or past the limit is skipped, unless its reset time has passed. ▲/▼ reorders the list at any
  time; reordering never switches by itself. The Switch button on any card switches immediately, ignoring the order.
- **Live 5-hour bars.** Every five minutes the plugin asks Google for each saved account's **5-hour** figure (the same
  number `/usage` reports, to the bit) so every card shows a current bar without touching the active account. It costs no
  quota.
- **Weekly is last-seen.** No endpoint returns the weekly figure for an account that is not signed in, so a card shows the
  weekly value from the last time that account was active, with its age — or **"weekly unknown"** if it never was.
- **Everything else on the card** is what you would expect: the active marker, "checked HH:MM", a needs-sign-in badge when a
  stored grant is dead, and per-account Switch / Remove.

## Install

1. Clone <https://github.com/sbhas2k/paseo-plugins> and install the `agy-rotator-windows` folder (Paseo → **Plugins →
   Install from folder**, or `paseo plugin install <path>` from a terminal).
2. Open **agy rotator (Windows)** in the sidebar.
3. Sign in with `agy`, come back, press **Save account**, name it. Repeat for each account.
4. Set the percentage, and arrange the order with ▲/▼.

## How it works (and what it touches)

- **Your sign-ins stay in Windows Credential Manager.** Each saved account is one generic credential under
  `paseo-agy-accounts:<key>`; the live entry `gemini:antigravity` is written **only** when you press Switch (or the rule
  does), and is never deleted by the plugin. The plugin's own `index.json` holds a label, a hash and quota figures — no
  token, no email, no blob.
- **A switch** saves the current sign-in back to the account it belongs to, writes the target account's blob to the live
  entry, then reloads every **idle** `agy` agent in Paseo (their chats survive — that is what a reload is). A busy agent is
  reloaded at the end of its own turn. Every step is logged by label only.
- **The app key is read at run time from your own `agy.exe`** — the exact file `/usage` runs — by a streaming scan, and it is
  never written to disk, a log, an RPC payload, a setting, this repository or a published package. It is sent only to
  Google's token endpoint. Pairing is functional: only an HTTP 200 from that endpoint proves a key pair, and a wrong pair is
  skipped.
- **The requests** are the same ones `agy` itself makes: `oauth2.googleapis.com/token` for a refresh, and
  `cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` with a `user-agent` naming this plugin (the endpoint refuses
  requests without an `antigravity` user-agent). Redirects are refused rather than followed, so a redirect can never re-send
  a token somewhere else.
- **Your own terminals are never touched.** An `agy` you started by hand keeps its sign-in in memory, so it keeps spending
  the old account until you restart it; the screen says so. The plugin never kills a process it does not own.
- **Clean up** (only when you press it) removes saved entries under this plugin's name that no account card uses — leftovers
  from test runs. It never removes an account you have, and never anything outside `paseo-agy-accounts:`.

## Known limits

- **Weekly for an inactive account is a last-known value**, not live (§ above) — the 5-hour figure is live, the weekly is
  whatever that account last reported while active, or unknown.
- **An `agy` you started yourself keeps the old account** until you restart it. Paseo agents move because the plugin
  reloads them.
- **A switch reloads every idle `agy` agent in Paseo**, not just the one you are looking at — one sign-in per Windows user
  is the constraint.
- **The IDE's sign-in is separate.** The Antigravity IDE keeps its own sign-in in Electron storage; this plugin does not
  touch it.
- **It uses agy's own client identity.** The refresh uses `agy`'s built-in OAuth app key (read from your own `agy.exe` at
  run time) and identifies itself with an `antigravity` user-agent — the same client identity `agy` uses.
- **Using several Google accounts this way is your call.** It moves between accounts you signed in yourself; whether
  rotating several Google accounts fits Google's terms is your call.

## Development

```bash
npm install --no-audit --no-fund
npm test            # node --test, no network: every credential call is faked in the tests
npx tsc --noEmit
```

The tests never touch a real sign-in: they create throwaway `paseo-agy-accounts:test-…` / hex16 fixture targets, remove
them again, and the collector never reads a blob. `test/package-tree.test.ts` sweeps this whole directory — **README
included** — for anything shaped like a Google client id or secret, so a published copy cannot carry one.
