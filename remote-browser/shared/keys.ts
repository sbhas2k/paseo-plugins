// remote-browser — a DOM keyboard event → CDP Input.dispatchKeyEvent params. Pure; tested in test/pure.test.ts.

export interface KeyInput {
  key: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface CdpKeyEvent {
  type: "keyDown" | "keyUp" | "rawKeyDown";
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
}

const SPECIAL: Record<string, { vk: number; text?: string }> = {
  Enter: { vk: 13, text: "\r" },
  Backspace: { vk: 8 },
  Tab: { vk: 9 },
  Escape: { vk: 27 },
  Delete: { vk: 46 },
  ArrowLeft: { vk: 37 },
  ArrowUp: { vk: 38 },
  ArrowRight: { vk: 39 },
  ArrowDown: { vk: 40 },
  Home: { vk: 36 },
  End: { vk: 35 },
  PageUp: { vk: 33 },
  PageDown: { vk: 34 },
  Shift: { vk: 16 },
  Control: { vk: 17 },
  Alt: { vk: 18 },
  Meta: { vk: 91 },
  " ": { vk: 32, text: " " },
};

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifierBits(k: Pick<KeyInput, "ctrl" | "alt" | "shift" | "meta">): number {
  return (k.alt ? 1 : 0) | (k.ctrl ? 2 : 0) | (k.meta ? 4 : 0) | (k.shift ? 8 : 0);
}

/** US-layout OEM keys by physical code (charCodeAt would give "." → 46 = VK_DELETE). */
const OEM: Record<string, number> = {
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
};

function virtualKey(key: string, code: string): number {
  const special = SPECIAL[key];
  if (special) return special.vk;
  if (OEM[code] !== undefined) return OEM[code];
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

export function keyEventFor(type: "keyDown" | "keyUp", k: KeyInput): CdpKeyEvent {
  const modifiers = modifierBits(k);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: virtualKey(k.key, k.code), modifiers };
  if (type === "keyUp") return { type, ...base };
  const shortcut = k.ctrl || k.alt || k.meta;
  const text = shortcut ? undefined : SPECIAL[k.key] ? SPECIAL[k.key].text : k.key.length === 1 ? k.key : undefined;
  // No text → rawKeyDown would also do; keyDown without text is what Chrome expects for non-printing keys.
  return text === undefined ? { type, ...base } : { type, ...base, text };
}
