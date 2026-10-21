# Cache Meter

Paseo shows the context-window percentage and plan usage, but not how much of each request was served from the provider's prompt cache. Cache Meter adds that figure to every agent as a small pill above the message box.

## What it shows

- The pill reads `CH <last turn>/<session> <time>`, for example `CH 97/94 14:05`: the cache-read percentage of the last turn, of the whole session, and when the last reply ended.
- Clicking the pill opens a popover with the same figures spelled out, plus one figure pooled over every agent the plugin has read.
- Cache-read % is `cache read / (uncached input + cache read + cache write)`, summed over the API calls of the turn or session.

## How it works

At the end of every agent turn, the plugin reads only the bytes appended to the agent's transcript since the previous turn:

- Claude Code agents: `~/.claude/projects/*/<sessionId>.jsonl` (`message.usage`), counting each message once.
- Pi agents: the session file Paseo records for the agent.

The client asks the plugin for the latest figures every 15 seconds.

## Limits

- Providers without a local transcript (for example ACP agents such as Qoder) show `-`.
- After a daemon or plugin restart, the first turn read for an agent covers the whole transcript, so its "last turn" equals the session figure.
- A turn with no usage rows yet keeps the previous figure instead of showing a misleading 0%.

## Data and permissions

Read-only. It reads Paseo's agent records and the agents' transcript files on the daemon host. It writes nothing and makes no network requests.
