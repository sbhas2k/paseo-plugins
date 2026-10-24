import { useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  frameRpc,
  historyRpc,
  inputRpc,
  navigateRpc,
  resizeRpc,
  stateRpc,
  stopRpc,
  tabsRpc,
  type RemoteState,
} from "../shared/contracts";
import { scalePoint } from "../shared/geometry";

// remote-browser — the sidebar page: toolbar, tab strip and the live screen of the browser running on the daemon host.
// Mouse, wheel, keyboard and paste are captured from the screen's DOM element (web/desktop); native mobile shows a note.

type Theme = PluginScreenProps["theme"];
type InputEvent = Parameters<ReturnType<typeof useRpc<typeof inputRpc.input, typeof inputRpc.output>>>[0]["events"][number];

const MOVE_MS = 33;
const RESERVED = new Set(["F5", "F11", "F12"]);

function ToolButton(props: { theme: Theme; label: string; disabled?: boolean; onPress: () => void; title?: string }) {
  const { theme, label, disabled, onPress, title } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title ?? label}
      disabled={disabled}
      onPress={onPress}
      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, opacity: disabled ? 0.35 : 1 }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );
}

export function BrowserSurface({ theme }: PluginScreenProps) {
  const getState = useRpc(stateRpc);
  const getFrame = useRpc(frameRpc);
  const navigate = useRpc(navigateRpc);
  const history = useRpc(historyRpc);
  const sendInput = useRpc(inputRpc);
  const tabs = useRpc(tabsRpc);
  const resize = useRpc(resizeRpc);
  const stop = useRpc(stopRpc);

  const [state, setState] = useState<RemoteState | null>(null);
  const [frame, setFrame] = useState<{ data: string; width: number; height: number } | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<View>(null);
  // Frames per second actually shown, over the last 3 s.
  const frameTimes = useRef<number[]>([]);
  const [fps, setFps] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 3000;
      frameTimes.current = frameTimes.current.filter((x) => x >= cutoff);
      setFps(Math.round((frameTimes.current.length / 3) * 10) / 10);
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const frameSize = useRef({ width: 1280, height: 800 });

  const refresh = useCallback(
    (start = false) =>
      getState({ start })
        .then((s) => {
          setState(s);
          if (s.error) setError(s.error);
        })
        .catch((e) => setError(String(e))),
    [getState],
  );

  // The frame loop: long-poll for anything newer; one request in flight at a time.
  useEffect(() => {
    let alive = true;
    let seq = 0;
    let generation = "";
    void refresh(true);
    (async () => {
      while (alive) {
        try {
          const f = await getFrame({ generation, sinceSeq: seq, waitMs: 1200 });
          if (!alive) break;
          generation = f.generation;
          seq = f.seq;
          if (f.data) {
            frameSize.current = { width: f.width, height: f.height };
            setFrame({ data: f.data, width: f.width, height: f.height });
            frameTimes.current.push(Date.now());
          }
        } catch (e) {
          if (!alive) break;
          setError(String(e));
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [getFrame, refresh]);

  const active = state?.tabs.find((t) => t.id === state.activeId) ?? null;
  useEffect(() => {
    if (!editing && active) setAddress(active.url === "about:blank" ? "" : active.url);
  }, [active?.url, editing]);

  // Input: queued in order, mouse moves throttled.
  const queue = useRef<InputEvent[]>([]);
  const sending = useRef(false);
  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (queue.current.length) {
        const events = queue.current.splice(0, 50);
        const result = await sendInput({ events });
        if (!result.ok && result.message) setError(result.message);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      sending.current = false;
    }
  }, [sendInput]);
  const push = useCallback(
    (event: InputEvent) => {
      queue.current.push(event);
      void flush();
    },
    [flush],
  );

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = screenRef.current as unknown as HTMLElement | null;
    if (!el || typeof el.addEventListener !== "function") return;
    el.tabIndex = 0;
    el.style.outline = "none";
    el.style.cursor = "default";
    let lastMove = 0;
    const point = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      return scalePoint({ x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }, frameSize.current);
    };
    const mods = (e: MouseEvent | KeyboardEvent) => ({ ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
    const button = (b: number) => (b === 1 ? "middle" : b === 2 ? "right" : "left") as "left" | "middle" | "right";
    const onDown = (e: MouseEvent) => {
      el.focus();
      e.preventDefault();
      push({ kind: "mouse", type: "mousePressed", ...point(e), button: button(e.button), clickCount: Math.min(e.detail || 1, 3), mods: mods(e) });
    };
    const onUp = (e: MouseEvent) => {
      e.preventDefault();
      push({ kind: "mouse", type: "mouseReleased", ...point(e), button: button(e.button), clickCount: Math.min(e.detail || 1, 3), mods: mods(e) });
    };
    const onMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMove < MOVE_MS) return;
      lastMove = now;
      const pressed = e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none";
      push({ kind: "mouse", type: "mouseMoved", ...point(e), button: pressed, clickCount: 0, mods: mods(e) });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      push({ kind: "wheel", ...point(e), deltaX: e.deltaX * scale, deltaY: e.deltaY * scale });
    };
    const onKey = (type: "keyDown" | "keyUp") => (e: KeyboardEvent) => {
      if (RESERVED.has(e.key)) return;
      // Ctrl/Cmd+V: let the browser fire "paste" so the local clipboard text can be sent.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
      e.preventDefault();
      push({ kind: "key", type, event: { key: e.key, code: e.code, ...mods(e) } });
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return;
      e.preventDefault();
      push({ kind: "text", text: text.slice(0, 20_000) });
    };
    const onContext = (e: Event) => e.preventDefault();
    const keyDown = onKey("keyDown");
    const keyUp = onKey("keyUp");
    el.addEventListener("mousedown", onDown);
    el.addEventListener("mouseup", onUp);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", keyDown);
    el.addEventListener("keyup", keyUp);
    el.addEventListener("paste", onPaste);
    el.addEventListener("contextmenu", onContext);
    return () => {
      el.removeEventListener("mousedown", onDown);
      el.removeEventListener("mouseup", onUp);
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", keyDown);
      el.removeEventListener("keyup", keyUp);
      el.removeEventListener("paste", onPaste);
      el.removeEventListener("contextmenu", onContext);
    };
  }, [push]);

  // The remote viewport follows the screen area's size (debounced).
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onLayout = (width: number, height: number) => {
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      void resize({ width, height }).catch(() => {});
    }, 300);
  };

  const go = () => {
    setEditing(false);
    navigate({ address })
      .then((r) => setError(r.ok ? null : r.message))
      .catch((e) => setError(String(e)));
  };
  const act = (p: Promise<{ ok: boolean; message: string | null }>) =>
    p.then((r) => (r.ok ? refresh() : setError(r.message))).catch((e) => setError(String(e)));

  const fg = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;

  if (Platform.OS !== "web") {
    return (
      <View style={{ padding: 20 }}>
        <Text style={{ color: fg }}>Remote Browser works in Paseo web and the desktop app.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 6, gap: 2, borderBottomWidth: 1, borderColor: theme.colors.border }}>
        <ToolButton theme={theme} label="←" title="Back" disabled={!state?.canGoBack} onPress={() => void act(history({ action: "back" }))} />
        <ToolButton theme={theme} label="→" title="Forward" disabled={!state?.canGoForward} onPress={() => void act(history({ action: "forward" }))} />
        <ToolButton theme={theme} label="⟳" title="Reload" onPress={() => void act(history({ action: "reload" }))} />
        <TextInput
          value={address}
          onChangeText={setAddress}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onSubmitEditing={go}
          placeholder="Address or search - runs on the dev host (localhost = the dev host)"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ flex: 1, color: fg, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13 }}
        />
        <ToolButton theme={theme} label="+" title="New tab" onPress={() => void act(tabs({ action: "new" }))} />
        <Text style={{ color: muted, fontSize: 11, marginHorizontal: 6 }}>{fps} fps</Text>
        <ToolButton theme={theme} label="⏻" title="Stop the browser (logins are kept)" onPress={() => void act(stop({}))} />
      </View>
      <ScrollView horizontal style={{ flexGrow: 0, borderBottomWidth: 1, borderColor: theme.colors.border }} contentContainerStyle={{ paddingHorizontal: 6 }}>
        {state?.tabs.map((t) => (
          <View key={t.id} style={{ flexDirection: "row", alignItems: "center", marginRight: 4, borderBottomWidth: 2, borderColor: t.id === state.activeId ? theme.colors.accent : "transparent" }}>
            <Pressable onPress={() => void act(tabs({ action: "select", id: t.id }))} style={{ paddingHorizontal: 8, paddingVertical: 6, maxWidth: 220 }}>
              <Text numberOfLines={1} style={{ color: t.id === state.activeId ? fg : muted, fontSize: 12 }}>
                {t.title || t.url || "New tab"}
              </Text>
            </Pressable>
            <Pressable accessibilityLabel="Close tab" onPress={() => void act(tabs({ action: "close", id: t.id }))} style={{ paddingHorizontal: 4 }}>
              <Text style={{ color: muted, fontSize: 12 }}>×</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {error ? (
        <Pressable onPress={() => setError(null)}>
          <Text style={{ color: theme.colors.statusWarning ?? fg, fontSize: 12, paddingHorizontal: 10, paddingVertical: 4 }}>{error} (click to dismiss)</Text>
        </Pressable>
      ) : null}
      <View
        ref={screenRef}
        style={{ flex: 1, backgroundColor: "#ffffff" }}
        onLayout={(e) => onLayout(e.nativeEvent.layout.width, e.nativeEvent.layout.height)}
      >
        {frame ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
            style={{ width: "100%", height: "100%" }}
            resizeMode="stretch"
          />
        ) : (
          <Text style={{ color: "#555", padding: 20 }}>{state?.running ? "Waiting for the first frame..." : "Starting the browser on the dev host..."}</Text>
        )}
      </View>
    </View>
  );
}
