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
  target.getWebContentsId = () => 7;
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

test("an old stop event does not complete a new open", async () => {
  const webview = guest("https://old.example");
  webview.isLoading = () => false;
  const pending = waitForOpenComplete(() => webview, "https://old.example", 20);
  webview.dispatchEvent(new Event("did-stop-loading"));
  await assert.rejects(pending, /did not finish loading/);
});

test("an aborted redirect load waits for its replacement navigation", async () => {
  const webview = guest("https://old.example");
  let settled = false;
  const pending = waitForOpenComplete(() => webview, "https://old.example", 100)
    .then(() => { settled = true; });
  const aborted = new Event("did-fail-load") as Event & { errorCode: number };
  aborted.errorCode = -3;
  webview.dispatchEvent(aborted);
  webview.dispatchEvent(new Event("did-stop-loading"));
  await Promise.resolve();
  assert.equal(settled, false);
  webview.dispatchEvent(new Event("did-start-loading"));
  webview.dispatchEvent(new Event("did-stop-loading"));
  await pending;
  assert.equal(settled, true);
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
    () => null,
    async () => ({ ok: false, error: "File previews must stay inside the active project" })
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /inside the active project/);
});

test("open reports a main-frame HTTP 404 to the agent", async () => {
  Object.defineProperty(globalThis, "controller", {
    value: { getPreviewResponseStatus: async () => ({ url: "https://missing.example/", statusCode: 404 }) },
    configurable: true,
  });
  const webview = guest("https://missing.example/");
  const result = await handleOpen(
    "https://missing.example/", false, () => webview, () => null,
    async () => ({ ok: true, loaded: true })
  );
  assert.deepEqual(result, { ok: false, error: "HTTP 404 loading https://missing.example/" });
});

test("open ignores an HTTP error from a different navigation", async () => {
  Object.defineProperty(globalThis, "controller", {
    value: { getPreviewResponseStatus: async () => ({ url: "https://old.example/", statusCode: 404 }) },
    configurable: true,
  });
  const webview = guest("https://new.example/");
  const result = await handleOpen(
    "https://new.example/", false, () => webview, () => null,
    async () => ({ ok: true, loaded: true })
  );
  assert.equal(result.ok, true);
});

test("open observes a load error that occurred before listeners attached", async () => {
  const webview = guest("https://broken.example/");
  await assert.rejects(
    waitForOpenComplete(() => webview, "https://old.example/", 100, () => "Name not resolved"),
    /Name not resolved/
  );
});
