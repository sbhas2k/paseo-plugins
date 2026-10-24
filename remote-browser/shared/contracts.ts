import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// remote-browser — settings and the RPCs between the sidebar page and the daemon-side browser.

export const RemoteBrowserSettingsSchema = z.object({
  /** Full path to chrome.exe / msedge.exe; empty = the first Chrome or Edge found. */
  browserPath: z.string().default(""),
  /**
   * "window": a real Chrome window kept off-screen on the host (passes strict bot checks such as Cloudflare's).
   * "headless": no window at all (lighter, but sites with strict bot checks never finish verifying).
   */
  mode: z.enum(["window", "headless"]).default("window"),
  /** Stop the browser after this many idle minutes (no page open). Logins are kept in its profile. */
  idleMinutes: z.number().int().min(1).max(240).default(15),
  /** Address opened in a fresh browser. */
  homeUrl: z.string().default("https://www.google.com"),
});
export type RemoteBrowserSettings = z.output<typeof RemoteBrowserSettingsSchema>;

export const remoteBrowserSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: RemoteBrowserSettingsSchema,
  migrate: (values) => values,
});

const TabSchema = z.object({ id: z.string(), title: z.string(), url: z.string() });
const StateSchema = z.object({
  running: z.boolean(),
  tabs: z.array(TabSchema),
  activeId: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  error: z.string().nullable(),
  homeUrl: z.string(),
});
export type RemoteState = z.infer<typeof StateSchema>;
const Ok = z.object({ ok: z.boolean(), message: z.string().nullable() });

const Mods = z.object({ ctrl: z.boolean(), alt: z.boolean(), shift: z.boolean(), meta: z.boolean() });
export const InputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mouse"),
    type: z.enum(["mouseMoved", "mousePressed", "mouseReleased"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "middle", "right"]),
    clickCount: z.number().int().min(0).max(3),
    mods: Mods,
  }),
  z.object({ kind: z.literal("wheel"), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }),
  z.object({
    kind: z.literal("key"),
    type: z.enum(["keyDown", "keyUp"]),
    event: Mods.extend({ key: z.string().max(32), code: z.string().max(32) }),
  }),
  z.object({ kind: z.literal("text"), text: z.string().max(20_000) }),
]);

export const stateRpc = defineRpc({ name: "remote-browser.state", input: z.object({ start: z.boolean().optional() }), output: StateSchema });

export const frameRpc = defineRpc({
  name: "remote-browser.frame",
  input: z.object({ generation: z.string(), sinceSeq: z.number().int().min(0), waitMs: z.number().int().min(0).max(1500) }),
  output: z.object({ generation: z.string(), seq: z.number(), data: z.string().nullable(), width: z.number(), height: z.number() }),
});

export const navigateRpc = defineRpc({ name: "remote-browser.navigate", input: z.object({ address: z.string().max(4000) }), output: Ok });

export const historyRpc = defineRpc({
  name: "remote-browser.history",
  input: z.object({ action: z.enum(["back", "forward", "reload"]) }),
  output: Ok,
});

export const inputRpc = defineRpc({ name: "remote-browser.input", input: z.object({ events: z.array(InputSchema).max(50) }), output: Ok });

export const tabsRpc = defineRpc({
  name: "remote-browser.tabs",
  input: z.object({ action: z.enum(["new", "close", "select"]), id: z.string().optional() }),
  output: Ok,
});

export const resizeRpc = defineRpc({
  name: "remote-browser.resize",
  input: z.object({ width: z.number(), height: z.number() }),
  output: z.object({ width: z.number(), height: z.number() }),
});

export const stopRpc = defineRpc({ name: "remote-browser.stop", input: z.object({}), output: Ok });
