# Remote Browser

A full Chrome that runs on the Paseo host and is shown and driven from a screen in Paseo: `localhost` is the host and websites see the host's IP. Tabs, address bar, mouse, keyboard, scrolling and paste work from Paseo web and the desktop app.

See [OVERVIEW.md](OVERVIEW.md) for what it does, how it works, its limits and what it touches.

## Install

```bash
paseo plugin add git:sbhas2k/paseo-plugins:remote-browser
```

Requires Paseo >=0.12.0 and Google Chrome or Microsoft Edge on the host.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin add ./remote-browser    # from a clone of this repository
```

## License

MIT
