# Context Compact

Sets the Claude Code auto-compaction threshold (a percent of a token window) for every Claude session Paseo opens, with an optional nudge to save notes before compaction.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works, its limits and the data it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:context-compact
```

Requires Paseo >=0.12.0.

## Develop

```bash
npm install
npm run typecheck
paseo plugin add ./context-compact    # from a clone of this repository
```

## License

MIT
