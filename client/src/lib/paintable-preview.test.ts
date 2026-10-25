import test from "node:test";
import assert from "node:assert/strict";
import { withPaintablePreview } from "./paintable-preview.ts";

test("failed background operation restores parked guest visibility", async () => {
  const style = { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" };

  await assert.rejects(withPaintablePreview(style, async () => {
    assert.equal(style.left, "0px");
    assert.equal(style.clipPath, "inset(100%)");
    throw new Error("guest failed");
  }), /guest failed/);

  assert.deepEqual(style, { left: "-100000px", top: "0px", zIndex: "-1", clipPath: "", opacity: "0", pointerEvents: "none" });
});
