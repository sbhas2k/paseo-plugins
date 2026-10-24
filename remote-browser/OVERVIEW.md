# Remote Browser

When Paseo runs on a remote machine (a VM, a home server, a dev box) and you use it from Paseo web, the apps you build there run on *that* machine's `localhost`, which your laptop cannot open. Remote Browser puts a real Chrome on the Paseo host and shows it inside Paseo, so `http://localhost:5173` opens the host's dev server, and any website you visit sees the host's IP address, not your laptop's.

## What it shows

- A **Remote Browser** row in the sidebar opens a screen with Back, Forward, Reload, an address bar, a tab strip, New tab, a frames-per-second readout and Stop.
- The address bar opens `localhost:5173` or an IP address as `http://`, a domain like `google.com` as `https://`, and anything else as a Google search. It refuses `javascript:` and `file:` addresses.
- The page area is the browser's live screen. Clicks, double-clicks, dragging, scrolling and typing go to the page. **Ctrl/Cmd+V** pastes your local clipboard into it.

## How it works

- On first use the plugin starts the host's Google Chrome, or Microsoft Edge if Chrome is missing, with its own profile in `<paseoHome>/plugin-data/remote-browser/profile`. Logins you make there persist; it never touches your own browser profile.
- **Window mode (default):** a genuine Chrome window placed off-screen on the host's desktop. It keeps drawing even when nobody is looking at that desktop, for example a disconnected remote-desktop session. Because it is an ordinary browser, sites with strict bot checks treat it like one. If no window can open (a server with no display), it falls back to headless.
- **Headless mode** (Settings): no window at all. It is lighter, but sites with strict bot checks may never finish verifying.
- The plugin talks to Chrome over Chrome's DevTools **pipe**, so no network port is opened and no other program on the host can take control of it. The screen streams as JPEG frames over Paseo's own connection, and a frame is only produced while someone is watching, so an idle browser uses no CPU.
- The browser stops after 15 idle minutes (configurable) and restarts on the next visit.

## Settings

Settings → Plugins → Remote Browser:

- `browserPath`: full path to `chrome.exe` / `msedge.exe` / `chromium`; empty picks the first one found.
- `mode`: `window` (default) or `headless`.
- `idleMinutes`: stop the browser after this many idle minutes (default 15).
- `homeUrl`: the address a freshly started browser opens (default `https://www.google.com`).

## Limits

- About 10–15 frames per second, depending on your connection to Paseo. There is no sound, and video is choppy.
- Browser shortcuts such as Ctrl+W, Ctrl+T, Ctrl+Tab, F5 and F11 act on your own Paseo tab, not the remote page. Use the toolbar's **+** and each tab's **×**.
- Copying text *out* of the remote page to your laptop is not supported yet. Pasting in is.
- Downloads land on the host in `<paseoHome>/plugin-data/remote-browser/downloads`.
- Two Paseo windows showing it at once share one browser and one viewport size: the last resize wins.
- Works in Paseo web and the desktop app, not in the native mobile apps.
- Stopping leftover Chrome processes on its profile uses PowerShell, so that clean-up runs on Windows only.

## Security

Anyone who can open your Paseo can use this browser, including whatever is logged in to its profile. That is no wider than what Paseo agents can already do on the host, but treat its logins accordingly.

## What it touches

- It starts and stops one Chrome or Edge process tree with its own profile and downloads folder under `<paseoHome>/plugin-data/remote-browser/`.
- It makes no network requests of its own. All traffic is the browser's, made from the host.
- It writes nothing else.
