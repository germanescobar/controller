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
} from "../../../shared/preview-browser.ts";
import {
  buildClickScript,
  buildSetFilesScript,
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
  openUrl: (url: string, options?: { insecure?: boolean }) => void;
  /**
   * Worktree path the pane is bound to. Used by `setFiles` so the
   * Electron main process can re-check the path policy on read
   * (issue #356). Optional: when omitted, `setFiles` is rejected
   * because the renderer cannot prove the path is project-scoped.
   */
  projectRoot?: string;
}

const RECONNECT_DELAY_MS = 1500;
const LOAD_TIMEOUT_MS = 12_000;

export function previewBrowserWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.hostname;
  const port = import.meta.env.DEV
    ? import.meta.env.VITE_API_PORT ?? "3100"
    : window.location.port;
  return `${protocol}//${host}:${port}/ws/preview-browser`;
}

export function usePreviewBrowserHost(options: PreviewBrowserHostOptions): void {
  const { enabled, browserKey, getWebview, openUrl, projectRoot } = options;

  // Keep the latest callbacks in refs so the long-lived socket effect doesn't
  // reconnect on every render.
  const getWebviewRef = useRef(getWebview);
  const openUrlRef = useRef(openUrl);
  const projectRootRef = useRef(projectRoot);
  getWebviewRef.current = getWebview;
  openUrlRef.current = openUrl;
  projectRootRef.current = projectRoot;

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
      message: BrowserCommandMessage
    ): Promise<BrowserCommandResult> => {
      try {
        switch (message.action) {
          case "open":
            return await handleOpen(
              String(message.params.url ?? ""),
              message.params.insecure === true,
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
          case "setFiles":
            return await handleSetFiles(
              getWebviewRef.current(),
              String(message.params.selector ?? ""),
              refs,
              (message.params.files ?? []) as BrowserSetFilesFileMeta[],
              projectRootRef.current,
              Boolean(message.params.allowOutside)
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
  insecure: boolean,
  getWebview: () => PreviewWebview | null,
  openUrl: (url: string, options?: { insecure?: boolean }) => void
): Promise<BrowserCommandResult> {
  if (!url) return { ok: false, error: "Missing url" };
  // Capture the current URL before navigating so we can tell when the *new*
  // page has actually loaded — otherwise an already-open idle pane would report
  // success against the old page and a follow-up snapshot would read it.
  const beforeUrl = safeCall(() => getWebview()?.getURL()) ?? null;
  openUrl(url, insecure ? { insecure: true } : undefined);
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
