# Context Compact

A long Claude Code chat sends its whole context with every request, so a session that grows to most of a 1M-token window gets expensive and burns plan usage quickly. Context Compact lets you choose when Claude Code compacts the chat in place, for every Claude session Paseo opens. It can also ask an agent to save its notes shortly before that happens.

## Settings

Open Settings, then Plugins, then Context Compact.

| Setting | Default | Effect |
|---|---|---|
| Enabled | on | Turns the plugin on or off |
| Compact at % | 60 | Passed to Claude Code as `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` |
| Window tokens | 1,000,000 | Passed as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; the percentage applies to this window |
| Providers | `claude` | Paseo providers whose sessions get these settings |
| Nudge at % | 45 | Once a top-level agent's context passes this, it gets one prompt asking it to update its notes; 0 turns the nudge off |
| Nudge text | editable | Placeholders `{pct}`, `{window}` and `{compact}` |

With the defaults, Claude Code compacts at 60% of 1M tokens (about 600k; Claude Code itself keeps a small buffer).

## How it works

- Before a Claude session opens (new agent, resume, refresh or import), the plugin adds the two environment variables to it. Claude Code then compacts the chat in place when the threshold is reached and carries on; nothing is restarted.
- At the end of each turn, it reads the size of the last request from the agent's transcript and sends the nudge once when the context passes the nudge percentage. The nudge re-arms after the context drops back below it, which happens after a compaction.

## Limits

- A change applies to a chat the next time it opens. A running Claude process keeps the settings it started with.
- Claude Code chats started outside Paseo are not affected.
- An `env` entry for the same variables in `~/.claude/settings.json` is applied by Claude Code after launch and overrides this plugin.
- The nudge is best-effort: it is checked at turn end, so one long turn with large tool outputs can pass both the nudge and the compaction threshold before it is checked. Sub-agents are not nudged.

## Data and permissions

It reads Paseo's agent records and Claude Code transcripts on the daemon host, sets two environment variables on Claude sessions, and sends the nudge prompt to agents. It makes no network requests.
