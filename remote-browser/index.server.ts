import os from "node:os";
import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { RemoteBrowser } from "./server/browser.ts";
import {
  RemoteBrowserSettingsSchema,
  frameRpc,
  historyRpc,
  inputRpc,
  navigateRpc,
  remoteBrowserSettings,
  resizeRpc,
  stateRpc,
  stopRpc,
  tabsRpc,
  type RemoteBrowserSettings,
} from "./shared/contracts.ts";
import { normalizeAddress } from "./shared/url.ts";

// remote-browser — a Chrome on the daemon host, shown and driven from a screen: localhost is that host and websites
// see that host's IP.

const DEFAULTS = RemoteBrowserSettingsSchema.parse({});
const home = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(remoteBrowserSettings);
  let settings: RemoteBrowserSettings = DEFAULTS;
  const log = (line: string) => console.log(`[remote-browser] ${line}`);
  let browser = makeBrowser();
  let fresh = true;

  function makeBrowser() {
    return new RemoteBrowser({
      profile: path.join(home, "plugin-data", "remote-browser", "profile"),
      binary: settings.browserPath || null,
      idleMs: settings.idleMinutes * 60_000,
      mode: settings.mode,
      log,
    });
  }
  const apply = (state: { status: string; values?: unknown }) => {
    settings = state.status === "ready" ? (state.values as RemoteBrowserSettings) : DEFAULTS;
  };
  void settingsHandle.read().then(apply).catch(() => {});
  const stopSettings = settingsHandle.subscribe((state) => {
    apply(state);
    // A changed path or idle time applies to the next start.
    void browser.stop().then(() => {
      browser = makeBrowser();
      fresh = true;
    });
  });

  const ok = (message: string | null = null) => ({ ok: true, message });
  const fail = (error: unknown) => ({ ok: false, message: error instanceof Error ? error.message : String(error) });

  /** Starting the browser opens the home address in its first tab. */
  async function ensureStarted() {
    const wasRunning = (await browser.state()).running;
    await browser.ensure();
    if (!wasRunning && fresh) {
      fresh = false;
      const url = normalizeAddress(settings.homeUrl);
      if (url) await browser.navigate(url).catch((e) => log(`home ${url}: ${String(e)}`));
    }
  }

  server.handle(stateRpc, async ({ start }) => {
    if (start) await ensureStarted();
    return { ...(await browser.state()), homeUrl: settings.homeUrl };
  });

  server.handle(frameRpc, async ({ generation, sinceSeq, waitMs }) => {
    await ensureStarted();
    return browser.frame(generation, sinceSeq, waitMs);
  });

  server.handle(navigateRpc, async ({ address }) => {
    const url = normalizeAddress(address);
    if (!url) return { ok: false, message: "That address cannot be opened here." };
    try {
      await ensureStarted();
      await browser.navigate(url);
      log(`navigate ${url}`);
      return ok(url);
    } catch (error) {
      return fail(error);
    }
  });

  server.handle(historyRpc, async ({ action }) => {
    try {
      await browser.historyAction(action);
      return ok();
    } catch (error) {
      return fail(error);
    }
  });

  server.handle(inputRpc, async ({ events }) => {
    try {
      for (const event of events) await browser.input(event);
      return ok();
    } catch (error) {
      return fail(error);
    }
  });

  server.handle(tabsRpc, async ({ action, id }) => {
    try {
      await browser.tabAction(action, id);
      return ok();
    } catch (error) {
      return fail(error);
    }
  });

  server.handle(resizeRpc, async ({ width, height }) => browser.resize(width, height));

  server.handle(stopRpc, async () => {
    await browser.stop();
    fresh = true;
    log("stopped by the user");
    return ok();
  });

  return async () => {
    stopSettings();
    await browser.stop();
  };
}
