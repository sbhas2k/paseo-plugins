// agy-rotator-windows — the bar row's text, kept out of the component on purpose: `react-native` is Flow-typed, so a component
// cannot be imported by `node --test`, and "resets in 6d 19h" is exactly the kind of thing that is wrong once and then
// wrong forever. Same split as antigravity-cli's own `client/quota-format.ts`, which is what the owner asked the bars to
// look like.

/** 0..100, rounded, clamped: `agy` reports a 0..1 share and a bar cannot be wider than its track. */
export function percentLeft(remainingFraction: number): number {
  const percent = Math.round(remainingFraction * 100);
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/** Minutes until `resetsAt`: null when there is no usable time, "past" when a cached reading outlived its window. */
function minutesLeft(resetsAt: string, now: number): number | "past" | null {
  const text = resetsAt.trim();
  if (text.length === 0) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  if (remaining <= 0) return "past";
  // A reset under a minute away is still ahead of us, never "resets in 0m".
  return Math.max(1, Math.round(remaining / 60_000));
}

/** "49m" / "6h 19m" / "6d 19h" — a zero lower unit is left off. */
function span(total: number): string {
  if (total < 60) return `${total}m`;
  if (total < 24 * 60) {
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(total / (24 * 60));
  const hours = Math.floor((total % (24 * 60)) / 60);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** "resets in 6d 19h", "resetting now", or "" when `agy` gave no usable time. */
export function formatResetsIn(resetsAt: string | null, now: number): string {
  if (resetsAt === null) return "";
  const left = minutesLeft(resetsAt, now);
  if (left === null) return "";
  if (left === "past") return "resetting now";
  return `resets in ${span(left)}`;
}

/** "checked 14:05", the local clock time of the reading. */
export function formatCheckedAt(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
