/*
 * Preview browser pool (issue #158).
 *
 * The agent-controlled preview browser must keep running even when the user
 * switches to a session in another worktree. Previously the `<webview>`, its
 * preview state, and the bridge WebSocket all lived inside `SessionView`, which
 * is keyed by `projectId:worktreeId` and therefore unmounts on a worktree
 * switch — tearing the live page down and deregistering the pane.
 *
 * This provider hoists all of that above `SessionView`. It owns one webview per
 * pane (`projectId:worktreeId`), rendered in a fixed overlay and positioned over
 * a placeholder the active `SessionView` exposes. Inactive panes are parked
 * off-screen at full size so their guest page (DOM, JS, scroll, form state) and
 * their bridge socket stay alive. `SessionView` renders only the preview chrome
 * (URL bar, title, errors, empty state) and reads/drives pane state through the
 * hooks exported here.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { getController, isControllerAvailable } from "@/lib/controller";
import {
  previewBrowserWsUrl,
  usePreviewBrowserHost,
  type PreviewWebview,
} from "@/lib/usePreviewBrowserHost";
import type { BrowserServerMessage } from "../../../shared/preview-browser";
import { PreviewDiagnosticBuffer } from "../../../shared/preview-diagnostics";
import { PreviewViewportStore } from "@/lib/preview-viewport";
import type { BrowserDiagnostic, BrowserViewport } from "../../../shared/preview-browser";
import { previewPartitionForKey } from "../../../shared/preview-partition";

type PreviewOpenResult = { ok: true; loaded?: boolean } | { ok: false; error: string };

/** Per-pane preview chrome state, mirrored from the live webview. */
export interface PreviewPaneState {
  input: string;
  url: string | null;
  title: string | null;
  loading: boolean;
  error: string | null;
  tabs: PreviewTab[];
  activeTabId: string;
}

export interface PreviewTab {
  id: string;
  input: string;
  url: string | null;
  /** Last validated URL assigned to the webview. Redirect commits only update url. */
  src: string | null;
  insecure: boolean;
  title: string | null;
  loading: boolean;
  error: string | null;
}

/** Actions a `SessionView` performs against its own pane. */
export interface PreviewPaneControls {
  state: PreviewPaneState;
  open: (url: string) => void;
  clear: () => void;
  reload: () => void;
  setInput: (input: string) => void;
  selectTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
}

const EMPTY_PANE: PreviewPaneState = {
  input: "",
  url: null,
  title: null,
  loading: false,
  error: null,
  tabs: [],
  activeTabId: "",
};

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Subscribe to a pane's chrome state and obtain its controls. Pass `null` when
 * the host view has no worktree yet; the returned controls are inert.
 */
export function usePreviewPane(key: string | null): PreviewPaneControls {
  const ctx = useRequiredContext();
  const store = ctx.store;

  const subscribe = useCallback(
    (cb: () => void) => store.subscribePane(key, cb),
    [store, key]
  );
  const getSnapshot = useCallback(() => store.getPane(key), [store, key]);
  const state = useSyncExternalStore(subscribe, getSnapshot);

  return useMemo<PreviewPaneControls>(
    () => ({
      state,
      open: (url) => key && ctx.openUrl(key, url),
      clear: () => key && ctx.clear(key),
      reload: () => key && ctx.reload(key),
      setInput: (input) => key && ctx.setInput(key, input),
      selectTab: (tabId) => key && ctx.selectTab(key, tabId),
      closeTab: (tabId) => key && ctx.closeTab(key, tabId),
    }),
    [state, key, ctx]
  );
}

/**
 * Register the calling view's pane as the active (visible) one and tell the pool
 * where to render its webview. Tracks the pane (creating its bridge host) for as
 * long as the app runs, so an agent can drive it even after the view unmounts.
 *
 * @param key          Pane key (`projectId:worktreeId`), or null when unknown.
 * @param projectRoot  Worktree path used to validate file-path previews.
 * @param placeholder  Element the active webview is sized/positioned over, or
 *                     null to park the pane off-screen (e.g. preview tab hidden).
 * @param onSurface    Called when an agent opens a URL on this pane so the view
 *                     can bring the preview tab forward.
 */
export function useActivePreviewPane(options: {
  key: string | null;
  projectRoot?: string;
  placeholder: HTMLElement | null;
  onSurface: () => void;
}): void {
  const { key, projectRoot, placeholder, onSurface } = options;
  const ctx = useRequiredContext();

  // Keep the surface callback in a ref so re-registration doesn't churn.
  const onSurfaceRef = useRef(onSurface);
  onSurfaceRef.current = onSurface;

  useEffect(() => {
    if (!key) return;
    ctx.trackPane(key, projectRoot);
  }, [ctx, key, projectRoot]);

  useEffect(() => {
    if (!key) {
      ctx.setActivePane(null, null, null);
      return;
    }
    ctx.setActivePane(key, placeholder, () => onSurfaceRef.current());
    return () => ctx.setActivePane(null, null, null);
  }, [ctx, key, placeholder]);
}

/**
 * Stable opener bound to no particular pane. Lets components surface a URL into
 * a worktree's pane (`open(key, url)`) without re-subscribing to pane state.
 */
export function usePreviewOpen(): (key: string, url: string) => void {
  return useRequiredContext().openUrl;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function PreviewBrowserProvider({ children }: { children: ReactNode }) {
  const available = isControllerAvailable();
  const storeRef = useRef<PreviewBrowserStore | null>(null);
  if (!storeRef.current) storeRef.current = new PreviewBrowserStore();
  const store = storeRef.current;

  usePreviewPaneRegistry(available, store);

  // Live webview elements by pane key, plus the overlay container, kept in refs
  // so positioning never triggers React re-renders.
  const webviewEls = useRef(new Map<string, PreviewWebview>());
  const viewports = useRef(new PreviewViewportStore());
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const activeKeyRef = useRef<string | null>(null);
  const placeholderRef = useRef<HTMLElement | null>(null);
  const onSurfaceRef = useRef<(() => void) | null>(null);

  const syncOverlay = useCallback(() => {
    const activeKey = activeKeyRef.current;
    const placeholder = placeholderRef.current;
    const container = overlayRef.current;
    const parkW = container?.clientWidth ?? window.innerWidth;
    const parkH = container?.clientHeight ?? window.innerHeight;

    const activeTabId = activeKey ? store.getPane(activeKey).activeTabId : null;
    for (const [key, el] of webviewEls.current) {
      const paneKey = key.slice(0, key.lastIndexOf(":"));
      const viewport = viewports.current.get(paneKey);
      el.style.position = "fixed";
      el.style.display = "flex";
      if (key === `${activeKey}:${activeTabId}` && placeholder) {
        const rect = placeholder.getBoundingClientRect();
        el.style.top = `${rect.top}px`;
        el.style.left = `${rect.left}px`;
        el.style.width = `${viewport?.width ?? rect.width}px`;
        el.style.height = `${viewport?.height ?? rect.height}px`;
        el.style.clipPath = viewport
          ? `inset(0px ${Math.max(0, viewport.width - rect.width)}px ${Math.max(0, viewport.height - rect.height)}px 0px)`
          : "";
        el.style.pointerEvents = "auto";
        el.style.zIndex = "20";
      } else {
        // Park inactive panes off-screen at full size so the guest keeps
        // rendering with a realistic viewport (snapshots stay accurate).
        el.style.top = "0px";
        el.style.left = "-100000px";
        el.style.width = `${viewport?.width ?? parkW}px`;
        el.style.height = `${viewport?.height ?? parkH}px`;
        el.style.clipPath = "";
        el.style.pointerEvents = "none";
        el.style.zIndex = "-1";
      }
    }
  }, [store]);

  const setViewport = useCallback((key: string, preset: "default" | "desktop" | "mobile"): BrowserViewport | null => {
    const viewport = viewports.current.set(key, preset);
    syncOverlay();
    return viewport;
  }, [syncOverlay]);

  const registerWebview = useCallback(
    (key: string, tabId: string, el: PreviewWebview | null) => {
      const frameKey = `${key}:${tabId}`;
      if (el) {
        el.style.position = "fixed";
        el.style.left = "-100000px";
        webviewEls.current.set(frameKey, el);
      } else {
        webviewEls.current.delete(frameKey);
      }
      syncOverlay();
    },
    [syncOverlay]
  );

  // Re-position the active webview whenever its placeholder resizes or the
  // window does. Sidebar/terminal drags resize the placeholder, so observing it
  // covers those without a polling loop.
  const observerRef = useRef<ResizeObserver | null>(null);
  const observePlaceholder = useCallback(
    (placeholder: HTMLElement | null) => {
      observerRef.current?.disconnect();
      if (placeholder && typeof ResizeObserver !== "undefined") {
        const observer = new ResizeObserver(() => syncOverlay());
        observer.observe(placeholder);
        observerRef.current = observer;
      }
    },
    [syncOverlay]
  );

  useEffect(() => {
    const onResize = () => syncOverlay();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      observerRef.current?.disconnect();
    };
  }, [syncOverlay]);

  const surface = useCallback((key: string) => {
    if (key === activeKeyRef.current) onSurfaceRef.current?.();
  }, []);

  const openUrl = useCallback(
    async (
      key: string,
      url: string,
      options: { insecure?: boolean } = {},
      tabId?: string
    ): Promise<PreviewOpenResult> => {
      if (!available) {
        toast.error("Preview is only available in the Electron app");
        return { ok: false, error: "Preview is only available in the Electron app" };
      }
      surface(key);
      const targetId = tabId ?? store.getPane(key).activeTabId;
      store.updateTab(key, targetId, {
        input: url, loading: true, error: null, insecure: options.insecure === true,
      });
      // Set this pane's cert policy *before* validation so a self-signed
      // localhost cert doesn't get re-checked at navigation time. We always
      // resolve the previous policy first; the bypass is per-call, not sticky.
      try {
        const policy = await getController().setPreviewCertPolicy({
          browserKey: key,
          insecure: options.insecure === true,
        });
        if (!policy.ok) throw new Error(policy.error ?? "Failed to set preview certificate policy");
        const result = await getController().validatePreviewUrl(url, store.getRoot(key));
        if (!result.allowed || !result.url) {
          const error = result.error ?? "Preview URL is not allowed";
          store.updateTab(key, targetId, { loading: false, error });
          toast.error(error);
          return { ok: false, error };
        }
        const previousSrc = store.getTab(key, targetId)?.src;
        store.updateTab(key, targetId, {
          input: result.url,
          url: result.url,
          src: result.url,
          title: null,
          loading: true,
          error: null,
        });
        // React cannot restart a guest load when its src prop stays the same
        // (for example, reopening the form page after a native POST).
        if (previousSrc === result.url) {
          const webview = webviewEls.current.get(`${key}:${targetId}`);
          if (webview?.loadURL) {
            try {
              await webview.loadURL(result.url);
              return { ok: true, loaded: true };
            } catch (error) {
              // A main-frame redirect cancels this load and starts another
              // validated navigation. The host wait observes that next load.
              const message = error instanceof Error ? error.message : String(error);
              if (!message.includes("ERR_ABORTED")) throw error;
            }
          }
        }
        return { ok: true };
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : "Failed to open preview";
        store.updateTab(key, targetId, { loading: false, error: message });
        toast.error(message);
        return { ok: false, error: message };
      }
    },
    [available, store, surface]
  );

  const clear = useCallback(
    (key: string) => {
      store.closeTab(key, store.getPane(key).activeTabId);
      syncOverlay();
    },
    [store, syncOverlay]
  );

  const reload = useCallback((key: string) => {
    const pane = store.getPane(key);
    const url = pane.url;
    if (!url) return;
    const tabId = pane.activeTabId;
    const webview = webviewEls.current.get(`${key}:${tabId}`);
    // A redirect can leave reload() targeting an obsolete provisional load.
    // Revalidate the committed URL and explicitly navigate the guest instead.
    const insecure = store.getTab(key, tabId)?.insecure === true;
    void getController().setPreviewCertPolicy({ browserKey: key, insecure }).then((policy) => {
      if (!policy.ok) throw new Error(policy.error ?? "Failed to set preview certificate policy");
      return getController().validatePreviewUrl(url, store.getRoot(key));
    }).then((result) => {
      if (!result.allowed || !result.url) {
        store.updateTab(key, tabId, { loading: false, error: result.error ?? "Preview URL is not allowed" });
        return;
      }
      if (webview?.loadURL) {
        store.updateTab(key, tabId, { loading: true, error: null });
        void webview.loadURL(result.url).then(() => {
          store.updateTab(key, tabId, { loading: false });
        }).catch((error: unknown) => {
          store.updateTab(key, tabId, { loading: false, error: error instanceof Error ? error.message : String(error) });
        });
      } else {
        // A detached guest is remounted by changing its src through the store.
        store.updateTab(key, tabId, { url: null, src: null, loading: false });
        openUrl(key, result.url, { insecure }, tabId);
      }
    }).catch((error: unknown) => {
      store.updateTab(key, tabId, { loading: false, error: error instanceof Error ? error.message : String(error) });
    });
  }, [store, openUrl]);

  const selectTab = useCallback((key: string, tabId: string) => {
    store.selectTab(key, tabId);
    syncOverlay();
  }, [store, syncOverlay]);

  const closeTab = useCallback((key: string, tabId: string) => {
    store.closeTab(key, tabId);
    syncOverlay();
  }, [store, syncOverlay]);

  useEffect(() => {
    if (!available) return;
    return getController().onPreviewPopup(({ guestId, url }) => {
      const source = [...webviewEls.current].find(([, webview]) =>
        webviewGuestId(webview) === guestId
      );
      if (!source) return;
      const paneKey = source[0].slice(0, source[0].lastIndexOf(":"));
      void getController().validatePreviewUrl(url, store.getRoot(paneKey)).then((result) => {
        if (!result.allowed || !result.url) {
          toast.error(result.error ?? "Preview popup URL is not allowed");
          return;
        }
        if (webviewEls.current.get(source[0]) !== source[1]) return;
        const tabId = store.addTab(paneKey);
        syncOverlay();
        openUrl(paneKey, result.url, {}, tabId);
      }).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Failed to open preview tab");
      });
    });
  }, [available, store, openUrl, syncOverlay]);

  useEffect(() => {
    if (!available) return;
    return getController().onPreviewNavigation(({ guestId, url, redirect }) => {
      const source = [...webviewEls.current].find(([, webview]) =>
        webviewGuestId(webview) === guestId
      );
      if (!source) return;
      const separator = source[0].lastIndexOf(":");
      const paneKey = source[0].slice(0, separator);
      const tabId = source[0].slice(separator + 1);
      const insecure = redirect && store.getTab(paneKey, tabId)?.insecure === true;
      void openUrl(paneKey, url, { insecure }, tabId);
    });
  }, [available, openUrl, store]);

  const setInput = useCallback(
    (key: string, input: string) => store.update(key, { input }),
    [store]
  );

  const trackPane = useCallback(
    (key: string, projectRoot?: string) => store.track(key, projectRoot),
    [store]
  );

  const setActivePane = useCallback(
    (
      key: string | null,
      placeholder: HTMLElement | null,
      onSurface: (() => void) | null
    ) => {
      activeKeyRef.current = key;
      placeholderRef.current = placeholder;
      onSurfaceRef.current = onSurface;
      observePlaceholder(placeholder);
      syncOverlay();
    },
    [observePlaceholder, syncOverlay]
  );

  const ctx = useMemo<PreviewBrowserContextValue>(
    () => ({
      available,
      store,
      openUrl,
      clear,
      reload,
      selectTab,
      closeTab,
      setInput,
      trackPane,
      setActivePane,
    }),
    [available, store, openUrl, clear, reload, selectTab, closeTab, setInput, trackPane, setActivePane]
  );

  return (
    <PreviewBrowserContext.Provider value={ctx}>
      {children}
      {available && (
        <div ref={overlayRef} className="pointer-events-none fixed inset-0 z-10">
          <PaneFrames
            store={store}
            openUrl={openUrl}
            available={available}
            registerWebview={registerWebview}
            setViewport={setViewport}
          />
        </div>
      )}
    </PreviewBrowserContext.Provider>
  );
}

/**
 * Keep one app-level socket available so the server can request a pane for a
 * worktree that this desktop window has not visited since launch. The normal
 * per-pane host socket is created by PaneFrames after `store.track` updates
 * the topology.
 */
function usePreviewPaneRegistry(
  enabled: boolean,
  store: PreviewBrowserStore
): void {
  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const ws = new WebSocket(previewBrowserWsUrl());
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ kind: "register-controller" }));
      ws.onmessage = (event) => {
        let message: BrowserServerMessage;
        try {
          message = JSON.parse(event.data) as BrowserServerMessage;
        } catch {
          return;
        }
        if (message.kind !== "ensure-pane") return;
        store.track(message.key, message.projectRoot);
      };
      ws.onclose = () => {
        if (disposed) return;
        reconnectTimer = window.setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, store]);
}

// ---------------------------------------------------------------------------
// Webview frames
// ---------------------------------------------------------------------------

/** Renders one frame per tracked pane, re-rendering only when topology changes. */
function PaneFrames({
  store,
  openUrl,
  available,
  registerWebview,
  setViewport,
}: {
  store: PreviewBrowserStore;
  openUrl: (key: string, url: string, options?: { insecure?: boolean }, tabId?: string) => Promise<PreviewOpenResult>;
  available: boolean;
  registerWebview: (key: string, tabId: string, el: PreviewWebview | null) => void;
  setViewport: (key: string, preset: "default" | "desktop" | "mobile") => BrowserViewport | null;
}) {
  const topology = useSyncExternalStore(
    (cb) => store.subscribeTopology(cb),
    () => store.getTopology()
  );

  return (
    <>
      {topology.map((pane) => (
        <PaneFrame
          key={pane.key}
          paneKey={pane.key}
          tabs={pane.tabs}
          activeTabId={pane.activeTabId}
          store={store}
          openUrl={openUrl}
          available={available}
          registerWebview={registerWebview}
          setViewport={setViewport}
        />
      ))}
    </>
  );
}

/**
 * Owns one pane's bridge host and its `<webview>`. The host runs even before a
 * URL is opened so an agent can drive a background worktree's pane; the webview
 * mounts only once a URL exists.
 */
function PaneFrame({
  paneKey,
  tabs,
  activeTabId,
  store,
  openUrl,
  available,
  registerWebview,
  setViewport,
}: {
  paneKey: string;
  tabs: PreviewTab[];
  activeTabId: string;
  store: PreviewBrowserStore;
  openUrl: (key: string, url: string, options?: { insecure?: boolean }, tabId?: string) => Promise<PreviewOpenResult>;
  available: boolean;
  registerWebview: (key: string, tabId: string, el: PreviewWebview | null) => void;
  setViewport: (key: string, preset: "default" | "desktop" | "mobile") => BrowserViewport | null;
}) {
  const webviewsRef = useRef(new Map<string, PreviewWebview>());
  const activeTabRef = useRef(activeTabId);
  activeTabRef.current = activeTabId;
  const diagnostics = useRef(new Map<string, PreviewDiagnosticBuffer>());
  const navigationStartedAt = useRef(new Map<string, string>());

  const diagnosticBuffer = (tabId: string): PreviewDiagnosticBuffer => {
    let buffer = diagnostics.current.get(tabId);
    if (!buffer) {
      buffer = new PreviewDiagnosticBuffer();
      diagnostics.current.set(tabId, buffer);
    }
    return buffer;
  };

  usePreviewBrowserHost({
    enabled: available,
    browserKey: paneKey,
    getWebview: useCallback(() => webviewsRef.current.get(activeTabRef.current) ?? null, []),
    getLoadError: useCallback(() => store.getPane(paneKey).error, [store, paneKey]),
    openUrl: useCallback(
      (next: string, options?: { insecure?: boolean }) =>
        openUrl(paneKey, next, options),
      [openUrl, paneKey]
    ),
    // Issue #356: `setFiles` needs the worktree path so the Electron
    // main process can re-check the path policy at read time.
    projectRoot: store.getRoot(paneKey),
    setViewport: (preset) => setViewport(paneKey, preset),
    getDiagnostics: async (limit) => {
      const tabId = activeTabRef.current;
      const webview = webviewsRef.current.get(tabId);
      const id = webview ? webviewGuestId(webview) : null;
      const requests = id && isControllerAvailable()
        ? await getController().previewRequestFailures(id) : [];
      return [...diagnosticBuffer(tabId).recent(50), ...requests.filter((entry) => entry.timestamp >= (navigationStartedAt.current.get(tabId) ?? ""))]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
    },
  });

  const registerTabWebview = useCallback((key: string, tabId: string, el: PreviewWebview | null) => {
    if (el) webviewsRef.current.set(tabId, el);
    else webviewsRef.current.delete(tabId);
    registerWebview(key, tabId, el);
  }, [registerWebview]);

  return <>{tabs.map((tab) => tab.src && (
    <TabFrame
      key={tab.id}
      paneKey={paneKey}
      tab={tab}
      store={store}
      registerWebview={registerTabWebview}
      onNavigationStart={(tabId, webview) => {
        navigationStartedAt.current.set(tabId, new Date().toISOString());
        diagnosticBuffer(tabId).clear();
        const id = webviewGuestId(webview);
        if (id) void getController().previewRequestFailures(id, true);
      }}
      onDiagnostic={(tabId, entry) => diagnosticBuffer(tabId).add(entry)}
    />
  ))}</>;
}

function TabFrame({ paneKey, tab, store, registerWebview, onNavigationStart, onDiagnostic }: {
  paneKey: string;
  tab: PreviewTab;
  store: PreviewBrowserStore;
  registerWebview: (key: string, tabId: string, el: PreviewWebview | null) => void;
  onNavigationStart: (tabId: string, webview: PreviewWebview) => void;
  onDiagnostic: (tabId: string, entry: BrowserDiagnostic) => void;
}) {
  const cleanupRef = useRef<(() => void) | null>(null);

  // Attach in the ref callback, before a newly mounted guest can finish or
  // fail a fast load. Main-process guards route links and redirects.
  const attachEvents = useCallback((webview: PreviewWebview) => {
    const update = (partial: Partial<PreviewTab>) => store.updateTab(paneKey, tab.id, partial);
    const onStart = () => {
      onNavigationStart(tab.id, webview);
      update({ loading: true, error: null });
    };
    const onConsole = (event: Event) => {
      const info = event as Event & { level?: number | string; message?: string; sourceId?: string };
      if (info.level !== 2 && info.level !== "error") return;
      onDiagnostic(tab.id, { kind: "console", timestamp: new Date().toISOString(),
        url: info.sourceId || webview.getURL(), message: info.message ?? "Console error" });
    };
    const onStop = () => update({ loading: webviewIsLoading(webview) });
    const onFail = (event: Event) => {
      // Chromium emits ERR_ABORTED while routing a link or redirect through validation.
      if (eventNumber(event, "errorCode") === -3) return;
      const url = eventString(event, "validatedURL") ?? webview.getURL();
      onDiagnostic(tab.id, { kind: "request", timestamp: new Date().toISOString(),
        url, message: eventString(event, "errorDescription") ?? "Preview failed to load" });
      update({
        loading: false,
        error: eventString(event, "errorDescription") ?? "Preview failed to load",
      });
    };
    const onTitle = (event: Event) =>
      update({ title: eventString(event, "title") });
    const onNavigated = (event: Event) => {
      const next = eventString(event, "url");
      if (next) update({ url: next, input: next, loading: webviewIsLoading(webview) });
    };

    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("console-message", onConsole);
    webview.addEventListener("did-stop-loading", onStop);
    webview.addEventListener("did-finish-load", onStop);
    webview.addEventListener("did-fail-load", onFail);
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("did-navigate", onNavigated);
    webview.addEventListener("did-navigate-in-page", onNavigated);
    return () => {
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("console-message", onConsole);
      webview.removeEventListener("did-stop-loading", onStop);
      webview.removeEventListener("did-finish-load", onStop);
      webview.removeEventListener("did-fail-load", onFail);
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("did-navigate", onNavigated);
      webview.removeEventListener("did-navigate-in-page", onNavigated);
    };
  }, [paneKey, tab.id, store, onNavigationStart, onDiagnostic]);

  const setWebview = useCallback((el: PreviewWebview | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (el) cleanupRef.current = attachEvents(el);
    registerWebview(paneKey, tab.id, el);
  }, [attachEvents, registerWebview, paneKey, tab.id]);

  return createElement("webview", {
    ref: setWebview,
    src: tab.src,
    partition: previewPartitionForKey(paneKey),
    allowpopups: "true",
    webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PaneTopology {
  key: string;
  tabs: PreviewTab[];
  activeTabId: string;
}

/**
 * External store backing the panes. Granular subscriptions keep webview load
 * churn (loading/title flips) from re-rendering the whole app: chrome consumers
 * subscribe to a single pane, the frame list subscribes to topology (the set of
 * panes and their URLs).
 */
export class PreviewBrowserStore {
  private panes = new Map<string, PreviewPaneState>();
  private roots = new Map<string, string | undefined>();
  private order: string[] = [];
  private paneListeners = new Map<string, Set<() => void>>();
  private topologyListeners = new Set<() => void>();
  private topologySnapshot: PaneTopology[] = [];
  private nextTabId = 0;

  getPane(key: string | null): PreviewPaneState {
    if (!key) return EMPTY_PANE;
    return this.panes.get(key) ?? EMPTY_PANE;
  }

  getRoot(key: string): string | undefined {
    return this.roots.get(key);
  }

  getTab(key: string, tabId: string): PreviewTab | undefined {
    return this.panes.get(key)?.tabs.find((tab) => tab.id === tabId);
  }

  getTopology(): PaneTopology[] {
    return this.topologySnapshot;
  }

  track(key: string, projectRoot?: string): void {
    this.roots.set(key, projectRoot);
    if (this.panes.has(key)) return;
    const tab = this.emptyTab();
    this.panes.set(key, this.paneWithActive([tab], tab.id));
    this.order.push(key);
    this.rebuildTopology();
    this.emitTopology();
    this.emitPane(key);
  }

  update(key: string, partial: Partial<PreviewPaneState>): void {
    this.updateTab(key, this.getPane(key).activeTabId, partial);
  }

  updateTab(key: string, tabId: string, partial: Partial<PreviewTab>): void {
    const prev = this.panes.get(key);
    if (!prev || !prev.tabs.some((tab) => tab.id === tabId)) return;
    const tabs = prev.tabs.map((tab) => tab.id === tabId ? { ...tab, ...partial } : tab);
    this.setPane(key, this.paneWithActive(tabs, prev.activeTabId),
      prev.tabs.find((tab) => tab.id === tabId)?.src !== tabs.find((tab) => tab.id === tabId)?.src);
  }

  addTab(key: string): string {
    const prev = this.getPane(key);
    const tab = this.emptyTab();
    this.setPane(key, this.paneWithActive([...prev.tabs, tab], tab.id), true);
    return tab.id;
  }

  selectTab(key: string, tabId: string): void {
    const prev = this.getPane(key);
    if (!prev.tabs.some((tab) => tab.id === tabId)) return;
    this.setPane(key, this.paneWithActive(prev.tabs, tabId), true);
  }

  closeTab(key: string, tabId: string): void {
    const prev = this.getPane(key);
    const index = prev.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
    if (tabs.length === 0) tabs.push(this.emptyTab());
    const activeId = prev.activeTabId === tabId
      ? tabs[Math.min(index, tabs.length - 1)].id
      : prev.activeTabId;
    this.setPane(key, this.paneWithActive(tabs, activeId), true);
  }

  private emptyTab(): PreviewTab {
    return { id: `tab-${++this.nextTabId}`, input: "", url: null, src: null,
      insecure: false, title: null, loading: false, error: null };
  }

  private paneWithActive(tabs: PreviewTab[], activeTabId: string): PreviewPaneState {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active) throw new Error(`Preview tab ${activeTabId} is missing`);
    return { ...active, tabs, activeTabId };
  }

  private setPane(key: string, next: PreviewPaneState, topologyChanged: boolean): void {
    this.panes.set(key, next);
    if (!this.order.includes(key)) this.order.push(key);
    if (topologyChanged) {
      this.rebuildTopology();
      this.emitTopology();
    }
    this.emitPane(key);
  }

  subscribePane(key: string | null, cb: () => void): () => void {
    if (!key) return () => {};
    let set = this.paneListeners.get(key);
    if (!set) {
      set = new Set();
      this.paneListeners.set(key, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  subscribeTopology(cb: () => void): () => void {
    this.topologyListeners.add(cb);
    return () => this.topologyListeners.delete(cb);
  }

  private rebuildTopology(): void {
    this.topologySnapshot = this.order.map((key) => ({
      key,
      tabs: (this.panes.get(key) ?? EMPTY_PANE).tabs,
      activeTabId: (this.panes.get(key) ?? EMPTY_PANE).activeTabId,
    }));
  }

  private emitPane(key: string): void {
    this.paneListeners.get(key)?.forEach((cb) => cb());
  }

  private emitTopology(): void {
    this.topologyListeners.forEach((cb) => cb());
  }
}

// ---------------------------------------------------------------------------
// Context plumbing
// ---------------------------------------------------------------------------

interface PreviewBrowserContextValue {
  available: boolean;
  store: PreviewBrowserStore;
  openUrl: (key: string, url: string, options?: { insecure?: boolean }) => Promise<PreviewOpenResult>;
  clear: (key: string) => void;
  reload: (key: string) => void;
  selectTab: (key: string, tabId: string) => void;
  closeTab: (key: string, tabId: string) => void;
  setInput: (key: string, input: string) => void;
  trackPane: (key: string, projectRoot?: string) => void;
  setActivePane: (
    key: string | null,
    placeholder: HTMLElement | null,
    onSurface: (() => void) | null
  ) => void;
}

const PreviewBrowserContext = createContext<PreviewBrowserContextValue | null>(
  null
);

function useRequiredContext(): PreviewBrowserContextValue {
  const ctx = useContext(PreviewBrowserContext);
  if (!ctx) {
    throw new Error("Preview browser hooks require <PreviewBrowserProvider>");
  }
  return ctx;
}

function eventString(
  event: Event,
  key: "url" | "validatedURL" | "errorDescription" | "title"
): string | null {
  const value = (event as Event & Record<typeof key, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function eventNumber(event: Event, key: "errorCode"): number | null {
  const value = (event as Event & Record<typeof key, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function webviewGuestId(webview: PreviewWebview): number | null {
  try {
    return webview.getWebContentsId?.() ?? null;
  } catch {
    return null;
  }
}

function webviewIsLoading(webview: PreviewWebview): boolean {
  try {
    return webview.isLoading?.() ?? false;
  } catch {
    return false;
  }
}
