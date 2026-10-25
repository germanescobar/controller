type PaintableStyle = Pick<CSSStyleDeclaration,
  "left" | "top" | "zIndex" | "clipPath" | "opacity" | "pointerEvents">;

/** Bring a parked guest on-screen for Chromium's compositor without exposing it over app chrome. */
export async function withPaintablePreview<T>(style: PaintableStyle | undefined, action: () => Promise<T>): Promise<T> {
  if (!style || !(Number.parseFloat(style.left) < -50_000)) return action();

  const previous = {
    left: style.left, top: style.top, zIndex: style.zIndex,
    clipPath: style.clipPath, opacity: style.opacity, pointerEvents: style.pointerEvents,
  };
  try {
    style.left = "0px";
    style.top = "0px";
    style.zIndex = "20";
    style.clipPath = "inset(100%)";
    style.opacity = "0";
    style.pointerEvents = "none";
    return await action();
  } finally {
    Object.assign(style, previous);
  }
}
