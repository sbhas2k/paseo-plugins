# Agent Rescue

Sometimes an agent's provider session dies under it. One common case is an ACP provider (for example Qoder) that stopped answering while a turn was being cancelled. Every new message then fails with **"A foreground turn is already active"**, Stop does nothing, and the agent looks broken for good. The cure is a reload of the agent's session, and sometimes a restart of the provider's processes first. Agent Rescue puts both one click away.

## What it shows

- A **Stuck** pill on the composer of any agent whose status is `error` **and** whose last error matches one of these texts (editable in Settings):
  - `A foreground turn is already active`
  - `Timed out closing previous session`
  - `Timeout waiting for message`
  - `ACP agent exited unexpectedly`
  - `Session is closed`
  - `Session is not initialized`
- An **Agent Rescue** page in the sidebar listing every such agent on the daemon, across all workspaces, with the same actions and the result of the last one.
- An agent that is `closed` with one of those texts is shown as **Reloading**, with its actions disabled. The daemon reports a reload in flight that way, so the plugin won't send a second one.
- Ordinary provider errors, such as a usage limit or "Queuing failed", are not treated as stuck.

## The two actions

1. **Reload agent** runs `paseo agent reload` for that agent.
   - Against a dead provider the first reload often fails with "Timed out closing previous session", because the daemon waits only a few seconds for the old session to close. The plugin waits 5 s and retries once.
   - If the CLI gives up waiting while the daemon is still working, the plugin keeps watching the agent for up to 2 minutes and reports where it landed.
   - A running agent is never reloaded.
2. **Restart \<provider\> processes, then reload** appears only for providers listed in Settings. The default entry is Qoder: `qodercli.exe` with `--acp` in its command line.
   - It refuses, naming them, while any other agent of that provider is running, starting, mid-turn or waiting on a permission. It checks twice, the second time immediately before stopping anything.
   - It stops only matching processes whose parent is the Paseo daemon, so a CLI you run yourself in a terminal or an IDE is left alone. It stops each one with its children (`taskkill /T /F`).
   - It then reloads the stuck agent **and every idle agent of the same provider**. An idle agent whose process was stopped still looks idle but would fail on its next message.

Nothing happens on its own: every action is a click.

## Settings

Settings → Plugins → Agent Rescue:

- `patterns`: the last-error texts that mark an errored agent as stuck. Each is a case-insensitive regex, or plain text if it isn't a valid regex.
- `providerProcesses`: provider id → `{ "name": "<image name>", "pattern": "<regex over the command line>" }`.

## Limits

- **Restart processes is Windows-only.** It uses `Get-CimInstance` and `taskkill`. Reload works on every platform.
- On the Windows desktop app the plugin runs the CLI bundled inside the app, so `paseo` does not need to be on PATH. Anywhere else `paseo` must be on PATH, or `PASEO_CLI_PATH` must point at it.
- It can only see agents whose last error carries a matching text. A new failure text has to be added to `patterns`.
- Restart stops **every** daemon-started process of that provider. That is why it refuses while any sibling agent is busy.

## What it touches

- It reads agent snapshots through the plugin API and the daemon address from `<paseoHome>/paseo.pid`.
- It runs `paseo agent reload` against the local daemon. On Windows Restart only, it also runs `powershell Get-CimInstance` filtered by image name, and `taskkill`.
- It writes nothing except its own settings, logs every step to the plugin log (`paseo plugin logs agent-rescue`), and makes no network requests.
