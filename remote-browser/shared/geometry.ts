// remote-browser — display ↔ viewport geometry. Pure; tested in test/pure.test.ts.

export interface Size {
  width: number;
  height: number;
}

export const MIN_VIEWPORT: Size = { width: 320, height: 240 };
export const MAX_VIEWPORT: Size = { width: 2560, height: 1600 };

/** The remote viewport for a panel of this size: rounded, clamped. */
export function clampViewport(width: number, height: number): Size {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  return {
    width: clamp(width, MIN_VIEWPORT.width, MAX_VIEWPORT.width),
    height: clamp(height, MIN_VIEWPORT.height, MAX_VIEWPORT.height),
  };
}

/** A point on the displayed frame → the same point in viewport pixels, kept inside the viewport. */
export function scalePoint(point: { x: number; y: number }, shown: Size, viewport: Size): { x: number; y: number } {
  const sx = shown.width > 0 ? viewport.width / shown.width : 1;
  const sy = shown.height > 0 ? viewport.height / shown.height : 1;
  return {
    x: Math.min(viewport.width - 1, Math.max(0, Math.round(point.x * sx))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round(point.y * sy))),
  };
}
