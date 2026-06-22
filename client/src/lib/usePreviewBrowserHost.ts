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
import type {
  BrowserCommandResult,
  BrowserServerMessage,
} from "../../../shared/preview-browser.ts";
import {
  buildClickScript,
  buildSnapshotScript,
  buildTypeScript,
} from "./browser-scripts.ts";

/** Subset of the Electron `<webview>` tag API we drive. */
export interface PreviewWebview extends HTMLElement {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  getTitle: () => string;
  isLoading?: () => boolean;
  reload?: () => void;
}

export interface PreviewBrowserHostOptions {
  /** Only connect when the Electron preview surface is available. */
  enabled: boolean;
  /** Bridge key for this pane: `projectId:worktreeId`. */
  browserKey: string | null;
  /** Returns the live `<webview>` element, or null when no page is open. */
  getWebview: () => PreviewWebview | null;
  /** Trigger the visible navigation flow (validates + switches to Preview). */
  openUrl: (url: string) => void;
}

const RECONNECT_DELAY_MS = 1500;
const LOAD_TIMEOUT_MS = 12_000;

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const port = import.meta.env.DEV
    ? import.meta.env.VITE_API_PORT ?? "3100"
    : window.location.port;
  return `${protocol}//${host}:${port}/ws/preview-browser`;
}

export function usePreviewBrowserHost(options: PreviewBrowserHostOptions): void {
  const { enabled, browserKey, getWebview, openUrl } = options;

  // Keep the latest callbacks in refs so the long-lived socket effect doesn't
  // reconnect on every render.
  const getWebviewRef = useRef(getWebview);
  const openUrlRef = useRef(openUrl);
  getWebviewRef.current = getWebview;
  openUrlRef.current = openUrl;

  useEffect(() => {
    if (!enabled || !browserKey) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;
    // Per-pane refs cache (issue #170). The snapshot produces a ref map; the
    // next click/type with `ref=` reads from it. Cleared on `open` because a
    // new page invalidates the selectors.
    const refs: Record<string, string> = {};

    const runCommand = async (
      message: BrowserServerMessage
    ): Promise<BrowserCommandResult> => {
      try {
        switch (message.action) {
          case "open":
            return await handleOpen(
              String(message.params.url ?? ""),
              getWebviewRef.current,
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
              refs
            );
          case "type":
            return await handleType(
              getWebviewRef.current(),
              String(message.params.selector ?? ""),
              String(message.params.text ?? ""),
              Boolean(message.params.submit),
              refs
            );
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
      const ws = new WebSocket(wsUrl());
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
        if (message.action === "open") {
          // A new navigation invalidates any refs we cached.
          for (const k of Object.keys(refs)) delete refs[k];
        }
        void runCommand(message).then((result) => {
          // Snapshot replies carry refs the next `ref=` call will resolve;
          // capture them so a later click can target by id without re-running
          // a querySelector over the snapshot text.
          if (message.action === "snapshot" && result.ok && result.refs) {
            for (const k of Object.keys(refs)) delete refs[k];
            Object.assign(refs, result.refs);
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

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleOpen(
  url: string,
  getWebview: () => PreviewWebview | null,
  openUrl: (url: string) => void
): Promise<BrowserCommandResult> {
  if (!url) return { ok: false, error: "Missing url" };
  // Capture the current URL before navigating so we can tell when the *new*
  // page has actually loaded — otherwise an already-open idle pane would report
  // success against the old page and a follow-up snapshot would read it.
  const beforeUrl = safeCall(() => getWebview()?.getURL()) ?? null;
  openUrl(url);
  const webview = await waitForOpenComplete(getWebview, beforeUrl);
  if (!webview) {
    return { ok: true, url, summary: `Opened ${url}` };
  }
  return {
    ok: true,
    url: safeCall(() => webview.getURL()) ?? url,
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

async function handleClick(
  webview: PreviewWebview | null,
  selector: string,
  refs: Record<string, string>
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!selector) return { ok: false, error: "Missing selector" };
  const result = (await webview.executeJavaScript(
    buildClickScript({ selector, refs })
  )) as { ok: boolean; engine?: string; error?: string } | null;
  if (!result) return { ok: false, error: "Renderer returned no result" };
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "unknown ref"
          ? `Unknown ref: ${selector}. Run \`snapshot\` first to populate refs.`
          : result.error === "stale ref"
            ? `Stale ref (the page changed since the snapshot): ${selector}. Run \`snapshot\` again.`
            : `No element matches: ${selector} (engine: ${result.engine ?? "?"})`,
    };
  }
  return { ok: true, summary: `Clicked ${selector} (${result.engine})` };
}

async function handleType(
  webview: PreviewWebview | null,
  selector: string,
  text: string,
  submit: boolean,
  refs: Record<string, string>
): Promise<BrowserCommandResult> {
  if (!webview) return { ok: false, error: "No page is open. Use `open <url>` first." };
  if (!selector) return { ok: false, error: "Missing selector" };
  const result = (await webview.executeJavaScript(
    buildTypeScript({ selector, refs, text, submit })
  )) as { ok: boolean; engine?: string; error?: string } | null;
  if (!result) return { ok: false, error: "Renderer returned no result" };
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "unknown ref"
          ? `Unknown ref: ${selector}. Run \`snapshot\` first to populate refs.`
          : result.error === "stale ref"
            ? `Stale ref (the page changed since the snapshot): ${selector}. Run \`snapshot\` again.`
            : `No element matches: ${selector} (engine: ${result.engine ?? "?"})`,
    };
  }
  return {
    ok: true,
    summary: `Typed into ${selector}${submit ? " and submitted" : ""} (${result.engine})`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for an `open` to settle on the newly requested page. Resolves when a
 * fresh load cycle completes (`did-stop-loading`) or the webview has finished
 * loading a URL different from `beforeUrl`, whichever comes first. Falls back to
 * a timeout so a non-navigating `open` (e.g. re-opening the current URL) still
 * returns. Returns null only if the webview never appears.
 */
async function waitForOpenComplete(
  getWebview: () => PreviewWebview | null,
  beforeUrl: string | null
): Promise<PreviewWebview | null> {
  const start = Date.now();
  let webview = getWebview();
  while (!webview && Date.now() - start < LOAD_TIMEOUT_MS) {
    await delay(100);
    webview = getWebview();
  }
  if (!webview) return null;

  const el = webview;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("did-stop-loading", onStop);
      window.clearInterval(interval);
      window.clearTimeout(timer);
      resolve();
    };
    // A completed load cycle since we started waiting is the new navigation —
    // the old page was idle, so it has no pending load to confuse us.
    const onStop = () => finish();
    // Also poll, in case the new load finished before listeners attached
    // (common on the very first open, where the webview mounts mid-navigation).
    const poll = () => {
      const current = safeCall(() => el.getURL());
      const loading = el.isLoading ? el.isLoading() : false;
      if (!loading && current && current !== beforeUrl) finish();
    };
    const interval = window.setInterval(poll, 120);
    const timer = window.setTimeout(finish, LOAD_TIMEOUT_MS - (Date.now() - start));
    el.addEventListener("did-stop-loading", onStop);
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
