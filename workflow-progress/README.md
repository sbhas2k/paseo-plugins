# Workflow Progress

Shows Claude Code Workflow progress (steps started, done, silent sub-agents) as cards in the owning agent's Paseo timeline.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and the data it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:workflow-progress
```

Requires Paseo >=0.11.1.

## Develop

```bash
npm install
npm run typecheck
paseo plugin add ./workflow-progress    # from a clone of this repository
```

## License

MIT
