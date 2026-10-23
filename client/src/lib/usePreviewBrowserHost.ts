/*
 * Renderer side of the agent-controlled preview browser (issue #109).
 *
 * Connects to the server's `/ws/preview-browser` channel, registers the pane
 * this session view owns, and executes incoming browser commands against the
 * visible `<webview>` element. Navigation reuses the normal preview-open path
 * so the user sees the pane switch and load while the agent works.
 *
 * Issue #170 added locator-style selector engines (`text=`, `role=`, `label=`,
 * `placeholder=`, `ref=`) and an accessibility-tree snapshot. The renderer
 * remembers the refs the most recent snapshot emitted (per pane) so a later
 * `click`/`type ref=e3` resolves on the same page without the agent having to
 * re-send the selector. A new navigation (`open`) clears the stored refs.
 */

import { useEffect, useRef } from "react";
import { getController, isControllerAvailable } from "@/lib/controller";
import type {
  BrowserCommandMessage,
  BrowserCommandResult,
  BrowserServerMessage,
  BrowserSetFilesFileMeta,
  BrowserDiagnostic,
  BrowserViewport,
} from "../../../shared/preview-browser.ts";
import {
  buildClickScript,
  buildSetFilesScript,
  buildSnapshotScript,
  buildTypeScript,
  buildWaitCheckScript,
} from "./browser-scripts.ts";
import { capturePreviewScreenshot } from "./preview-screenshot.ts";

/** Subset of the Electron `<webview>` tag API we drive. */
export interface PreviewWebview extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  getTitle: () => string;
  isLoading?: () => boolean;
  reload?: () => void;
  canGoBack?: () => boolean;
  goBack?: () => void;
  sendInputEvent?: (event:
    | { type: "keyDown" | "keyUp" | "char"; keyCode: string }
    | { type: "mouseMove" | "mouseDown" | "mouseUp"; x: number; y: number; button?: "left"; clickCount?: number }
  ) => Promise<void> | void;
  loadURL?: (url: string) => Promise<void>;
  getWebContentsId?: () => number;
}

export interface PreviewBrowserHostOptions {
  /** Only connect when the Electron preview surface is available. */
  enabled: boolean;
  /** Bridge key for this pane: `projectId:worktreeId`. */
  browserKey: string | null;
  /** Returns the live `<webview>` element, or null when no page is open. */
  getWebview: () => PreviewWebview | null;
  /** Latest load error for the selected tab, including early load events. */
  getLoadError: () => string | null;
  /** Trigger the visible navigation flow (validates + switches to Preview). */
  openUrl: (
    url: string,
    options?: { insecure?: boolean }
  ) => Promise<{ ok: true; loaded?: boolean } | { ok: false; error: string }>;
  /**
   * Worktree path the pane is bound to. Used by `setFiles` so the
   * Electron main process can re-check the path policy on read
   * (issue #356). Optional: when omitted, `setFiles` is rejected
   * because the renderer cannot prove the path is project-scoped.
   */
  projectRoot?: string;
  setViewport: (preset: "default" | "desktop" | "mobile") => BrowserViewport | null;
  getDiagnostics: (limit: number) => Promise<BrowserDiagnostic[]>;
}

const RECONNECT_DELAY_MS = 1500;
const LOAD_TIMEOUT_MS = 12_000;
const ACTION_TIMEOUT_MS = 5_000;
const MAX_WAIT_MS = 15_000;

export function previewBrowserWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const port = import.meta.env.DEV
    ? import.meta.env.VITE_API_PORT ?? "3100"
    : window.location.port;
  return `${protocol}//${host}:${port}/ws/preview-browser`;
}

export function usePreviewBrowserHost(options: PreviewBrowserHostOptions): void {
  const { enabled, browserKey, getWebview, getLoadError, openUrl, projectRoot, setViewport, getDiagnostics } = options;

  // Keep the latest callbacks in refs so the long-lived socket effect doesn't
  // reconnect on every render.
  const getWebviewRef = useRef(getWebview);
  const getLoadErrorRef = useRef(getLoadError);
  const openUrlRef = useRef(openUrl);
  const projectRootRef = useRef(projectRoot);
  const setViewportRef = useRef(setViewport);
  const getDiagnosticsRef = useRef(getDiagnostics);
  getWebviewRef.current = getWebview;
  getLoadErrorRef.current = getLoadError;
  openUrlRef.current = openUrl;
  projectRootRef.current = projectRoot;
  setViewportRef.current = setViewport;
  getDiagnosticsRef.current = getDiagnostics;

  useEffect(() => {
    if (!enabled || !browserKey) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    // Per-pane refs cache (issue #170). The snapshot produces a ref map; the
    // next click/type with `ref=` reads from it. Cleared on `open` because a
    // new page invalidates the selectors.
    const refs: Record<string, string> = {};
    let refsUrl: string | null = null;

    const runCommand = async (
      message: BrowserCommandMessage
    ): Promise<BrowserCommandResult> => {
      try {
        const currentUrl = safeCall(() => getWebviewRef.current()?.getURL()) ?? null;
        if (refsUrl && currentUrl && currentUrl !== refsUrl) {
          for (const key of Object.keys(refs)) delete refs[key];
          refsUrl = null;
        }
        switch (message.action) {
          case "open":
            for (const key of Object.keys(refs)) delete refs[key];
            refsUrl = null;
            return await handleOpen(
              String(message.params.url ?? ""),
              message.params.insecure === true,
              getWebviewRef.current,
              getLoadErrorRef.current,
              openUrlRef.current
            );
          case "snapshot":
            return await handleSnapshot(
              getWebviewRef.current(),
              typeof message.params.selector === "string"
                ? message.params.selector
                : undefined,
              message.params.a11y === true
            );
          case "click":
            return await handleClick(
              getWebviewRef.current(),
              String(message.params.selector ?? ""),
              refs,
              timeoutFrom(message.params)
            );
          case "type":
            return await handleType(
              getWebviewRef.current(),
              String(message.params.selector ?? ""),
              String(message.params.text ?? ""),
              Boolean(message.params.submit),
              refs,
              timeoutFrom(message.params)
            );
          case "wait":
            return await handleWait(getWebviewRef.current(), message.params, refs);
          case "scroll":
            return await handleScroll(getWebviewRef.current(), message.params);
          case "keys":
            return handleKeys(getWebviewRef.current(), message.params);
          case "back":
            for (const key of Object.keys(refs)) delete refs[key];
            refsUrl = null;
            return await handleBack(getWebviewRef.current());
          case "setFiles":
            return await handleSetFiles(
              getWebviewRef.current(),
              String(message.params.selector ?? ""),
              refs,
              (message.params.files ?? []) as BrowserSetFilesFileMeta[],
              projectRootRef.current,
              Boolean(message.params.allowOutside)
            );
          case "viewport": {
            const preset = message.params.preset;
            if (preset !== "default" && preset !== "desktop" && preset !== "mobile") {
              return { ok: false, error: "Invalid viewport preset" };
            }
            const viewport = setViewportRef.current(preset);
            if (viewport) await waitForViewport(getWebviewRef.current(), viewport);
            return { ok: true, viewport, summary: viewport
              ? `Viewport set to ${viewport.width}×${viewport.height}` : "Viewport restored to pane default" };
          }
          case "diagnostics":
            return { ok: true, diagnostics: await getDiagnosticsRef.current(Number(message.params.limit)) };
          case "screenshot":
            return await handleScreenshot(getWebviewRef.current(), message.params.fullPage === true);
          default:
            return { ok: false, error: `Unsupported action` };
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(previewBrowserWsUrl());
      socket = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ kind: "register", key: browserKey }));
      };

      ws.onmessage = (event) => {
        let message: BrowserServerMessage;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.kind !== "command") return;
        void runCommand(message).then((result) => {
          // Snapshot replies carry refs the next `ref=` call will resolve;
          // capture them so a later click can target by id without re-running
          // a querySelector over the snapshot text.
          if (message.action === "snapshot" && result.ok && result.refs) {
            for (const k of Object.keys(refs)) delete refs[k];
            Object.assign(refs, result.refs);
            refsUrl = result.url ?? null;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                kind: "result",
                requestId: message.requestId,
                result,
              })
            );
          }
        });
      };

      ws.onclose = () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, browserKey]);
}

export async function waitForViewport(webview: PreviewWebview | null, viewport: BrowserViewport): Promise<void> {
  if (!webview) return;
  const style = webview.style;
  const parked = style && Number.parseFloat(style.left) < -50_000;
  const previous = parked ? { left: style.left, top: style.top, zIndex: style.zIndex } : null;
  const deadline = Date.now() + 2_000;
  let last: BrowserViewport | null = null;
  try {
    if (parked) {
      style.left = "0px";
      style.top = "0px";
      style.zIndex = "20";
      await delay(100);
    }
    while (Date.now() < deadline) {
      const actual = await boundedGuestCall(
        webview.executeJavaScript(`({ width: window.innerWidth, height: window.innerHeight })`),
        1_000, "Preview did not respond to the viewport check"
      ) as BrowserViewport;
      last = actual;
      if (actual.width === viewport.width && actual.height === viewport.height) return;
      await delay(50);
    }
    throw new Error(`Preview did not reach ${viewport.width}×${viewport.height} within 2 seconds (observed ${last?.width ?? "?"}×${last?.height ?? "?"})`);
  } finally {
    if (previous) Object.assign(style, previous);
  }
}

async function boundedGuestCall<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleScreenshot(webview: PreviewWebview | null, fullPage: boolean): Promise<BrowserCommandResult & { screenshotData?: string; fullPage?: boolean }> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  const guestId = safeCall(() => webview.getWebContentsId?.());
  if (!guestId) return { ok: false, error: "Preview guest is not ready for screenshot capture" };
  return capturePreviewScreenshot({
    style: webview.style,
    getURL: () => webview.getURL(),
    executeJavaScript: (code) => webview.executeJavaScript(code),
    capturePage: () => getController().capturePreviewPage(guestId),
  }, fullPage);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export async function handleOpen(
  url: string,
  insecure: boolean,
  getWebview: () => PreviewWebview | null,
  getLoadError: () => string | null,
  openUrl: (
    url: string,
    options?: { insecure?: boolean }
  ) => Promise<{ ok: true; loaded?: boolean } | { ok: false; error: string }>
): Promise<BrowserCommandResult> {
  if (!url) return { ok: false, error: "Missing url" };
  // Capture the current URL before navigating so we can tell when the *new*
  // page has actually loaded — otherwise an already-open idle pane would report
  // success against the old page and a follow-up snapshot would read it.
  const startedAt = Date.now();
  const beforeUrl = safeCall(() => getWebview()?.getURL()) ?? null;
  const opened = await openUrl(url, insecure ? { insecure: true } : undefined);
  if (!opened.ok) return { ok: false, error: opened.error };
  const webview = opened.loaded
    ? getWebview()
    : await waitForOpenComplete(
        getWebview, beforeUrl, LOAD_TIMEOUT_MS, getLoadError
      );
  if (!webview) return { ok: false, error: "Preview page closed before it loaded" };
  const guestId = safeCall(() => webview.getWebContentsId?.());
  const response = guestId ? await getController().getPreviewResponseStatus(guestId, startedAt) : null;
  const finalUrl = webview.getURL();
  if (
    response && response.statusCode >= 400 &&
    response.url.split("#", 1)[0] === finalUrl.split("#", 1)[0]
  ) {
    return { ok: false, error: `HTTP ${response.statusCode} loading ${response.url}` };
  }
  return {
    ok: true,
    url: finalUrl,
    title: safeCall(() => webview.getTitle()) ?? undefined,
    summary: `Opened ${url}`,
  };
}

async function handleSnapshot(
  webview: PreviewWebview | null,
  selector: string | undefined,
  a11y: boolean
): Promise<BrowserCommandResult> {
  if (!webview) {
    return { ok: false, error: "No page is open. Use `open <url>` first." };
  }
  const result = (await webview.executeJavaScript(
    buildSnapshotScript(selector, a11y ? "a11y" : "default")
  )) as {
    found: boolean;
    url?: string;
    title?: string;
    text?: string;
    refs?: Record<string, string>;
    refCount?: number;
  } | null;
  if (!result || !result.found) {
    return {
      ok: false,
      error: selector
        ? `No element matches: ${selector}`
        : "Could not read the page",
    };
  }
  return {
    ok: true,
    url: result.url,
    title: result.title,
    text: result.text,
    refs: result.refs,
    refCount: result.refCount,
  };
}

export async function handleClick(
  webview: PreviewWebview | null,
  selector: string,
  refs: Record<string, string>,
  timeoutMs: number
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!selector) return { ok: false, error: "Missing selector" };
  const result = await retryAction(webview, () => buildClickScript({ selector, refs }), timeoutMs);
  if (!result) return { ok: false, error: "Renderer returned no result" };
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "unknown ref"
          ? `Unknown ref: ${selector}. Run \`snapshot\` first to populate refs.`
          : result.error === "stale ref"
            ? `Stale ref (the page changed since the snapshot): ${selector}. Run \`snapshot\` again.`
            : `${result.error ?? "Target unavailable"}: ${selector} (engine: ${result.engine ?? "?"})`,
    };
  }
  if (!webview.sendInputEvent || typeof result.x !== "number" || typeof result.y !== "number" ||
    !Number.isFinite(result.x) || !Number.isFinite(result.y)) {
    return { ok: false, error: "Native mouse input is unavailable in this preview" };
  }
  const x = Math.round(result.x);
  const y = Math.round(result.y);
  const style = webview.style;
  const parked = style && Number.parseFloat(style.left) < -50_000;
  const previous = parked ? { left: style.left, top: style.top, zIndex: style.zIndex } : null;
  try {
    if (parked) {
      style.left = "0px";
      style.top = "0px";
      style.zIndex = "20";
      await delay(100);
    }
    await webview.sendInputEvent({ type: "mouseMove", x, y });
    await webview.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    await webview.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    if (parked) await delay(50);
  } finally {
    if (previous) Object.assign(style, previous);
  }
  return { ok: true, summary: `Clicked ${selector} (${result.engine})` };
}

async function handleType(
  webview: PreviewWebview | null,
  selector: string,
  text: string,
  submit: boolean,
  refs: Record<string, string>,
  timeoutMs: number
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!selector) return { ok: false, error: "Missing selector" };
  const result = await retryAction(webview, () => buildTypeScript({ selector, refs, text, submit }), timeoutMs);
  if (!result) return { ok: false, error: "Renderer returned no result" };
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "unknown ref"
          ? `Unknown ref: ${selector}. Run \`snapshot\` first to populate refs.`
          : result.error === "stale ref"
            ? `Stale ref (the page changed since the snapshot): ${selector}. Run \`snapshot\` again.`
            : `${result.error ?? "Target unavailable"}: ${selector} (engine: ${result.engine ?? "?"})`,
    };
  }
  return {
    ok: true,
    summary: `Typed into ${selector}${submit ? " and submitted" : ""} (${result.engine})`,
  };
}

/**
 * Drive a `<input type="file">` (or dropzone) on the active page
 * (issue #356). The server has already run the path policy; this
 * handler reads each file via the Electron main process and ships
 * the bytes into the guest via a single `executeJavaScript` round-trip.
 * The page's own validation (`accept`, `max-file-size`) runs inside
 * the script and returns a per-file outcome the agent can act on.
 *
 * The per-file outcome is correlated by **input index**, not by
 * basename (issue #356 review, P2): two files named `photo.png` in
 * different directories would otherwise collapse to a single script
 * result row, and a multi-file input that accepts only the first
 * would appear to accept both.
 */
async function handleSetFiles(
  webview: PreviewWebview | null,
  selector: string,
  refs: Record<string, string>,
  rawFiles: BrowserSetFilesFileMeta[],
  projectRoot: string | undefined,
  allowOutside: boolean
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!selector) return { ok: false, error: "Missing selector" };
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return { ok: false, error: "setFiles requires at least one file" };
  }
  if (!projectRoot) {
    return {
      ok: false,
      error:
        "setFiles requires an active worktree path; the renderer cannot prove " +
        "the file is project-scoped without it.",
    };
  }
  if (!isControllerAvailable()) {
    return {
      ok: false,
      error:
        "setFiles is only available in the Electron app (the readPreviewFile IPC is not " +
        "available to the browser preview).",
    };
  }
  // Pull bytes through the main process. Read in parallel — the agent
  // typically passes a small handful of files and the disk I/O dominates
  // the latency here. Each read independently surfaces a structured
  // error (`file does not exist`, `outside project`, `too large`,
  // `user denied`) which we surface verbatim so the CLI's per-file
  // output makes the cause obvious without a separate `getStatus`/log
  // dive.
  const controller = getController();
  const readResults = await Promise.all(
    rawFiles.map((entry, index) =>
      controller
        .readPreviewFile(entry.path, { projectRoot, allowOutside })
        .then((result) => ({ index, entry, result }))
    )
  );
  const preloaded: Array<{ index: number; name: string; type: string; contentBase64: string; path: string }> = [];
  // `earlyResults` carries the policy/IPC verdict for every requested
  // file, keyed by index. We keep the full length even when some files
  // were rejected by the policy layer so the CLI's per-file output is
  // one row per CLI argument, never collapsed by basename collisions.
  const earlyResults: Array<{ index: number; path: string; name: string; accepted: boolean; reason?: string }> = [];
  for (const { index, entry, result } of readResults) {
    if (!result.ok) {
      earlyResults.push({
        index,
        path: entry.path,
        name: entry.name,
        accepted: false,
        reason: result.error ?? "read-failed",
      });
      continue;
    }
    if (
      !result.name ||
      typeof result.contentBase64 !== "string" ||
      typeof result.size !== "number"
    ) {
      earlyResults.push({
        index,
        path: entry.path,
        name: entry.name,
        accepted: false,
        reason: "read-failed",
      });
      continue;
    }
    earlyResults.push({
      index,
      path: entry.path,
      name: result.name,
      accepted: true,
    });
    preloaded.push({
      index,
      name: result.name,
      type: result.type ?? entry.type ?? "application/octet-stream",
      contentBase64: result.contentBase64,
      path: entry.path,
    });
  }
  if (preloaded.length === 0) {
    // All files were rejected by the policy layer; skip the in-page
    // round-trip and return the per-file outcome verbatim.
    return {
      ok: true,
      summary: `Set 0 files on ${selector} (all ${rawFiles.length} rejected by policy)`,
      files: earlyResults,
    };
  }
  const scriptResult = (await webview.executeJavaScript(
    buildSetFilesScript({
      selector,
      refs,
      files: preloaded.map(({ index, name, type, contentBase64 }) => ({
        index,
        name,
        type,
        contentBase64,
      })),
      maxSize: null,
    })
  )) as
    | {
        ok: boolean;
        engine?: string;
        error?: string;
        files?: Array<{ index: number; name: string; accepted: boolean; reason?: string }>;
      }
    | null;
  if (!scriptResult) return { ok: false, error: "Renderer returned no result" };
  if (!scriptResult.ok) {
    return {
      ok: false,
      error:
        scriptResult.error === "unknown ref"
          ? `Unknown ref: ${selector}. Run \`snapshot\` first to populate refs.`
          : scriptResult.error === "stale ref"
            ? `Stale ref (the page changed since the snapshot): ${selector}. Run \`snapshot\` again.`
            : `No element matches: ${selector} (engine: ${scriptResult.engine ?? "?"})`,
    };
  }
  // The script returns its outcome keyed by **index**, not basename,
  // so two files with the same name at different paths correlate
  // back to the right CLI argument. Build the index map from the
  // script result once and look up each pre-loaded entry by its index.
  const byIndex = new Map<number, { accepted: boolean; reason?: string }>();
  for (const row of scriptResult.files ?? []) {
    // `Number.isInteger` guards against malformed script output that
    // forgets to thread the index through (defensive: the script
    // always emits it, but a future refactor shouldn't silently
    // collapse basenames again).
    if (typeof row.index === "number") byIndex.set(row.index, row);
  }
  const finalFiles = earlyResults.map((row) => {
    if (!row.accepted) return row;
    const observed = byIndex.get(row.index);
    if (!observed) {
      return { ...row, accepted: false, reason: "no-files-set" };
    }
    return { ...row, accepted: observed.accepted, reason: observed.reason };
  });
  const acceptedCount = finalFiles.filter((row) => row.accepted).length;
  return {
    ok: true,
    summary: `Set ${acceptedCount}/${rawFiles.length} files on ${selector}`,
    files: finalFiles,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeoutFrom(params: Record<string, unknown>): number {
  const value = params.timeoutMs;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_WAIT_MS, value))
    : ACTION_TIMEOUT_MS;
}

export async function retryAction(
  webview: PreviewWebview,
  script: () => string,
  timeoutMs: number
): Promise<{ ok: boolean; engine?: string; error?: string; x?: number; y?: number } | null> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no result";
  let lastEngine: string | undefined;
  do {
    const result = (await webview.executeJavaScript(script())) as { ok: boolean; engine?: string; error?: string; x?: number; y?: number } | null;
    if (!result || result.ok || result.error === "unknown ref" || result.error === "stale ref" || result.error?.startsWith("ambiguous")) return result;
    lastError = result.error ?? "no result";
    lastEngine = result.engine;
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, deadline - Date.now()));
  } while (true);
  return { ok: false, engine: lastEngine, error: `timed out after ${timeoutMs}ms (last reason: ${lastError})` };
}

async function handleWait(
  webview: PreviewWebview | null,
  params: Record<string, unknown>,
  refs: Record<string, string>
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  const condition = params.condition;
  const value = params.value;
  if (condition !== "visible" && condition !== "text" && condition !== "url") return { ok: false, error: "wait requires visible, text, or url" };
  if (typeof value !== "string" || !value) return { ok: false, error: "wait requires a nonempty value" };
  const timeoutMs = timeoutFrom(params);
  const deadline = Date.now() + timeoutMs;
  let observed = "";
  do {
    const result = (await webview.executeJavaScript(buildWaitCheckScript(condition, value, refs))) as { matched: boolean; observed: string };
    if (result.matched) return { ok: true, url: safeCall(() => webview.getURL()) ?? undefined, summary: `Condition met: ${condition} ${value}` };
    observed = result.observed;
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, deadline - Date.now()));
  } while (true);
  return { ok: false, error: `wait ${condition} ${value} timed out after ${timeoutMs}ms (last observed: ${observed})` };
}

async function handleScroll(webview: PreviewWebview | null, params: Record<string, unknown>): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  const x = params.x, y = params.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "scroll requires finite x and y offsets" };
  await webview.executeJavaScript(`window.scrollBy(${JSON.stringify(x)}, ${JSON.stringify(y)})`);
  return { ok: true, summary: `Scrolled by ${x}, ${y}` };
}

function handleKeys(webview: PreviewWebview | null, params: Record<string, unknown>): BrowserCommandResult {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  const key = params.key;
  if (typeof key !== "string" || !/^(Enter|Escape|Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Backspace)$/.test(key)) return { ok: false, error: "Unsupported key; use Enter, Escape, Tab, an arrow key, or Backspace" };
  if (!webview.sendInputEvent) return { ok: false, error: "Keyboard input is unavailable in this preview" };
  webview.sendInputEvent({ type: "keyDown", keyCode: key });
  webview.sendInputEvent({ type: "keyUp", keyCode: key });
  return { ok: true, summary: `Pressed ${key}` };
}

async function handleBack(webview: PreviewWebview | null): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!webview.goBack || !webview.canGoBack?.()) return { ok: false, error: "No previous page in preview history" };
  const beforeUrl = safeCall(() => webview.getURL());
  webview.goBack();
  await waitForOpenComplete(() => webview, beforeUrl);
  return { ok: true, url: safeCall(() => webview.getURL()) ?? undefined, summary: "Went back" };
}

/**
 * Wait for an `open` to settle on the newly requested page. Resolves when a
 * fresh load cycle completes (`did-stop-loading`) or the webview has finished
 * loading a URL different from `beforeUrl`, whichever comes first. Falls back to
 * a timeout with an error if no new page ever settles. In particular, a
 * validation failure must not report success against the old page.
 */
export async function waitForOpenComplete(
  getWebview: () => PreviewWebview | null,
  beforeUrl: string | null,
  timeoutMs = LOAD_TIMEOUT_MS,
  getLoadError: () => string | null = () => null
): Promise<PreviewWebview> {
  const start = Date.now();
  let webview = getWebview();
  while (!webview && Date.now() - start < timeoutMs) {
    await delay(100);
    webview = getWebview();
  }
  if (!webview) throw new Error("Preview page did not open before the load timeout");

  const el = webview;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let started = safeCall(() => el.isLoading?.()) ?? false;
    let aborted = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-fail-load", onFail);
      window.clearInterval(interval);
      window.clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    // A completed load cycle since we started waiting is the new navigation —
    // the old page was idle, so it has no pending load to confuse us.
    const onStart = () => {
      started = true;
      aborted = false;
    };
    const onStop = () => {
      if (aborted) return;
      const error = getLoadError();
      if (error) return finish(new Error(error));
      const current = safeCall(() => el.getURL());
      if (started || (current && current !== beforeUrl)) finish();
    };
    const onFail = (event: Event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string };
      if (failure.errorCode === -3) {
        aborted = true;
        return;
      }
      finish(new Error(failure.errorDescription ?? "Preview failed to load"));
    };
    // Also poll, in case the new load finished before listeners attached
    // (common on the very first open, where the webview mounts mid-navigation).
    const poll = () => {
      const error = getLoadError();
      if (error) return finish(new Error(error));
      if (aborted) return;
      const current = safeCall(() => el.getURL());
      const loading = safeCall(() => el.isLoading?.());
      if (loading === false && current && current !== beforeUrl) finish();
    };
    const interval = window.setInterval(poll, 120);
    const timer = window.setTimeout(() => finish(new Error("Preview page did not finish loading before the load timeout")), Math.max(0, timeoutMs - (Date.now() - start)));
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-fail-load", onFail);
    poll();
  });
  return el;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function safeCall<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
