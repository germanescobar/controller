import assert from "node:assert/strict";
import test from "node:test";
import { handleOpen, waitForOpenComplete, type PreviewWebview } from "./usePreviewBrowserHost.ts";

// The helper uses the renderer's timer APIs; Node supplies the same timer
// behavior for these event-driven tests.
Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

function guest(url: string): PreviewWebview {
  const target = new EventTarget() as PreviewWebview;
  target.getURL = () => url;
  target.getTitle = () => "Test";
  target.executeJavaScript = async () => null;
  target.isLoading = () => true;
  return target;
}

test("open waits for a load event and reports failure", async () => {
  const webview = guest("https://old.example");
  const pending = waitForOpenComplete(() => webview, "https://old.example", 100);
  const failure = new Event("did-fail-load") as Event & {
    errorCode: number;
    errorDescription: string;
  };
  failure.errorCode = -105;
  failure.errorDescription = "Name not resolved";
  webview.dispatchEvent(failure);
  await assert.rejects(pending, /Name not resolved/);
});

test("open does not report success when no new page loads", async () => {
  const webview = guest("https://old.example");
  await assert.rejects(
    waitForOpenComplete(() => webview, "https://old.example", 20),
    /did not finish loading/
  );
});

test("open settles after a new load stops", async () => {
  const webview = guest("https://new.example");
  const pending = waitForOpenComplete(() => webview, "https://old.example", 100);
  webview.dispatchEvent(new Event("did-stop-loading"));
  assert.equal(await pending, webview);
});

test("open returns validation errors without reporting the old page as opened", async () => {
  const webview = guest("https://old.example");
  const result = await handleOpen(
    "file:///outside/project.html",
    false,
    () => webview,
    async () => ({ ok: false, error: "File previews must stay inside the active project" })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /inside the active project/);
});
