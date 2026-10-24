import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAddress } from "../shared/url.ts";
import { scalePoint, clampViewport } from "../shared/geometry.ts";
import { keyEventFor } from "../shared/keys.ts";
import { FrameQueue } from "../server/frames.ts";

// Address bar
test("bare hosts get https, localhost and IPs get http", () => {
  assert.equal(normalizeAddress("google.com"), "https://google.com");
  assert.equal(normalizeAddress("  www.google.com/search?q=x "), "https://www.google.com/search?q=x");
  assert.equal(normalizeAddress("localhost:5173"), "http://localhost:5173");
  assert.equal(normalizeAddress("127.0.0.1:8000/api/health"), "http://127.0.0.1:8000/api/health");
  assert.equal(normalizeAddress("http://localhost:5173/login"), "http://localhost:5173/login");
  assert.equal(normalizeAddress("https://example.org"), "https://example.org");
  assert.equal(normalizeAddress("about:blank"), "about:blank");
});

test("text that is not an address becomes a search", () => {
  assert.equal(normalizeAddress("nifty option chain"), "https://www.google.com/search?q=nifty%20option%20chain");
  assert.equal(normalizeAddress("paseo"), "https://www.google.com/search?q=paseo");
});

test("dangerous or empty input is refused", () => {
  assert.equal(normalizeAddress("javascript:alert(1)"), null);
  assert.equal(normalizeAddress("file:///C:/Windows/win.ini"), null);
  assert.equal(normalizeAddress("   "), null);
});

// Geometry
test("a click on the displayed image maps to viewport pixels", () => {
  assert.deepEqual(scalePoint({ x: 320, y: 200 }, { width: 640, height: 400 }, { width: 1280, height: 800 }), { x: 640, y: 400 });
  assert.deepEqual(scalePoint({ x: -5, y: 9999 }, { width: 640, height: 400 }, { width: 1280, height: 800 }), { x: 0, y: 799 });
});

test("the viewport is clamped and rounded", () => {
  assert.deepEqual(clampViewport(100.7, 50), { width: 320, height: 240 });
  assert.deepEqual(clampViewport(1333.4, 777.6), { width: 1333, height: 778 });
  assert.deepEqual(clampViewport(9000, 9000), { width: 2560, height: 1600 });
});

// Keys
test("printable keys carry text; specials carry codes and no text", () => {
  assert.deepEqual(keyEventFor("keyDown", { key: "a", code: "KeyA", ctrl: false, alt: false, shift: false, meta: false }), {
    type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65, modifiers: 0,
  });
  const enter = keyEventFor("keyDown", { key: "Enter", code: "Enter", ctrl: false, alt: false, shift: false, meta: false });
  assert.equal(enter.windowsVirtualKeyCode, 13);
  assert.equal(enter.text, "\r");
  const bs = keyEventFor("keyDown", { key: "Backspace", code: "Backspace", ctrl: false, alt: false, shift: false, meta: false });
  assert.equal(bs.windowsVirtualKeyCode, 8);
  assert.equal(bs.text, undefined);
  const left = keyEventFor("keyDown", { key: "ArrowLeft", code: "ArrowLeft", ctrl: false, alt: false, shift: false, meta: false });
  assert.equal(left.windowsVirtualKeyCode, 37);
});

test("Ctrl+A is a shortcut (modifier set, no text); keyUp never has text", () => {
  const ctrlA = keyEventFor("keyDown", { key: "a", code: "KeyA", ctrl: true, alt: false, shift: false, meta: false });
  assert.equal(ctrlA.modifiers, 2);
  assert.equal(ctrlA.text, undefined);
  assert.equal(keyEventFor("keyUp", { key: "a", code: "KeyA", ctrl: false, alt: false, shift: false, meta: false }).text, undefined);
  assert.equal(keyEventFor("keyDown", { key: "A", code: "KeyA", ctrl: false, alt: false, shift: true, meta: false }).text, "A");
});

// Punctuation keeps its own virtual key, never Delete/Insert/Print/Help
test("punctuation maps to the OEM virtual-key codes", () => {
  const plain = { ctrl: false, alt: false, shift: false, meta: false };
  const vk = (key: string, code: string) => keyEventFor("keyDown", { key, code, ...plain }).windowsVirtualKeyCode;
  assert.equal(vk(".", "Period"), 190);
  assert.equal(vk(",", "Comma"), 188);
  assert.equal(vk("-", "Minus"), 189);
  assert.equal(vk("/", "Slash"), 191);
  assert.equal(vk(";", "Semicolon"), 186);
  assert.equal(vk("=", "Equal"), 187);
  assert.equal(vk("'", "Quote"), 222);
  assert.equal(vk("[", "BracketLeft"), 219);
  assert.equal(vk("]", "BracketRight"), 221);
  assert.equal(vk("\\", "Backslash"), 220);
  assert.equal(vk("`", "Backquote"), 192);
  assert.equal(vk(">", "Period"), 190);
  assert.equal(keyEventFor("keyDown", { key: ".", code: "Period", ...plain }).text, ".");
});

// Frame queue: generation id and ack on consumption
test("long-poll returns at once when a newer frame exists, latest wins", async () => {
  const q = new FrameQueue();
  q.push("f1", 1280, 800);
  q.push("f2", 1280, 800);
  const t0 = Date.now();
  const got = await q.next(q.generation, 0, 1000);
  assert.ok(Date.now() - t0 < 100, "must not wait when a newer frame already exists");
  assert.equal(got.data, "f2");
  assert.equal(got.seq, 2);
});

test("long-poll waits for the next frame and wakes on push", async () => {
  const q = new FrameQueue();
  q.push("f1", 1, 1);
  const waiting = q.next(q.generation, 1, 2000);
  setTimeout(() => q.push("f2", 1, 1), 20);
  const got = await waiting;
  assert.equal(got.data, "f2");
});

test("long-poll times out with the same seq and no data", async () => {
  const q = new FrameQueue();
  q.push("f1", 1, 1);
  const t0 = Date.now();
  const got = await q.next(q.generation, 1, 60);
  assert.equal(got.seq, 1);
  assert.equal(got.data, null);
  assert.ok(Date.now() - t0 >= 50);
});

test("after a browser restart a waiting client gets the first new frame, never a blank", async () => {
  const q = new FrameQueue();
  for (let i = 0; i < 57; i++) q.push(`old${i}`, 1, 1);
  const oldGen = q.generation;
  q.reset();
  assert.notEqual(q.generation, oldGen);
  const waiting = q.next(oldGen, 57, 1000);
  setTimeout(() => q.push("new1", 1, 1), 20);
  const got = await waiting;
  assert.equal(got.data, "new1");
  assert.equal(got.generation, q.generation);
});

test("a client from an older generation is answered at once when a frame exists", async () => {
  const q = new FrameQueue();
  q.reset();
  q.push("x", 1, 1);
  const t0 = Date.now();
  const got = await q.next("stale-generation", 99, 1000);
  assert.ok(Date.now() - t0 < 100);
  assert.equal(got.data, "x");
});

test("a frame is acked when a client takes it, once, and not before", async () => {
  const q = new FrameQueue();
  let acks = 0;
  q.push("f1", 1, 1, () => acks++);
  assert.equal(acks, 0, "no ack while nobody has taken the frame");
  await q.next(q.generation, 0, 100);
  assert.equal(acks, 1);
  await q.next(q.generation, 0, 100);
  assert.equal(acks, 1, "a second client taking the same frame does not ack again");
});

test("a frame replaced before anyone took it is still acked, so Chrome keeps sending", async () => {
  const q = new FrameQueue();
  let acks = 0;
  q.push("f1", 1, 1, () => acks++);
  q.push("f2", 1, 1, () => acks++);
  assert.equal(acks, 1, "the superseded frame is acked on replacement");
});

// Strict bot checks never finish in headless mode — "window" must not be headless.
test("window mode launches a real window that keeps drawing when the session is disconnected", async () => {
  const { modeArgs } = await import("../server/chrome.ts");
  const win = modeArgs("window");
  assert.equal(win.some((a) => a.startsWith("--headless")), false);
  assert.ok(win.includes("--disable-backgrounding-occluded-windows"));
  assert.ok(win.includes("--disable-features=CalculateNativeWinOcclusion"));
  assert.deepEqual(modeArgs("headless"), ["--headless=new"]);
});
