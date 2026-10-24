// remote-browser — what the address bar turns into a URL. Pure; tested in test/pure.test.ts.

const SEARCH = "https://www.google.com/search?q=";

/** A URL to open, or null when the input is empty or a scheme we refuse (javascript:, file:, data:, …). */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") return text;
  if (text.toLowerCase() === "about:blank") return "about:blank";
  // "localhost:5173" parses as scheme "localhost" — treat host:port forms before refusing schemes.
  const hostPort = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.exec(text);
  if (hostPort) return `http://${text}`;
  if (scheme && !/^[^\s/]+\.[^\s/]+(:\d+)?(\/.*)?$/.test(text)) return null;
  if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  return SEARCH + encodeURIComponent(text);
}
