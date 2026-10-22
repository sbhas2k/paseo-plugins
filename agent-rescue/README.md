# Agent Rescue

Spots agents whose session died ("A foreground turn is already active", "Timed out closing previous session", ...) and rescues them with one click: a Stuck pill on the composer and a sidebar page, Reload with retry, and a guarded restart of the provider's ACP processes.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and what it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:agent-rescue
```

Requires Paseo >=0.12.0.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin add ./agent-rescue    # from a clone of this repository
```

## License

MIT
