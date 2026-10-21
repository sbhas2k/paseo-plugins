# Cache Meter

Shows each agent's prompt-cache read % (last turn and session) as a small composer pill, read from the agent's local Claude Code or Pi transcript.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and the data it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:cache-meter
```

Requires Paseo >=0.11.1.

## Develop

```bash
npm install
npm run typecheck
paseo plugin add ./cache-meter    # from a clone of this repository
```

## License

MIT
