# Paseo plugins

Plugins for [Paseo](https://paseo.sh).

| Plugin | What it does | Install |
|---|---|---|
| [Cache Meter](cache-meter) | Prompt-cache read % per agent, as a composer pill | `paseo plugin add git:sbhas2k/paseo-plugins:cache-meter` |
| [Workflow Progress](workflow-progress) | Claude Code Workflow steps as cards in the agent's timeline | `paseo plugin add git:sbhas2k/paseo-plugins:workflow-progress` |
| [Context Compact](context-compact) | Claude Code auto-compaction threshold per session, with a save-your-notes nudge | `paseo plugin add git:sbhas2k/paseo-plugins:context-compact` |
| [Agent Rescue](agent-rescue) | One-click rescue for agents whose session died ("A foreground turn is already active"): reload with retry, guarded provider restart | `paseo plugin add git:sbhas2k/paseo-plugins:agent-rescue` |
| [Remote Browser](remote-browser) | A real Chrome on the Paseo host, shown and driven from a screen in Paseo: `localhost` is the host, websites see the host's IP | `paseo plugin add git:sbhas2k/paseo-plugins:remote-browser` |
| [agy rotator (Windows)](agy-rotator-windows) | Several Antigravity (`agy`) sign-ins on Windows, rotated in your order when one runs low; live 5-hour quota bars per account | `paseo plugin add git:sbhas2k/paseo-plugins:agy-rotator-windows` |

All of them run locally on the daemon host. None makes network requests of its own except agy rotator, which calls Google's token and quota endpoints for your saved accounts (Remote Browser's traffic is the browser you drive).

## License

MIT
