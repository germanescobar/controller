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
  usePreviewBrowserHost,
  type PreviewWebview,
} from "@/lib/usePreviewBrowserHost";

/** Per-pane preview chrome state, mirrored from the live webview. */
export interface PreviewPaneState {
  input: string;
  url: string | null;
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
}

const EMPTY_PANE: PreviewPaneState = {
  input: "",
  url: null,
  title: null,
  loading: false,
  error: null,
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

  // Live webview elements by pane key, plus the overlay container, kept in refs
  // so positioning never triggers React re-renders.
  const webviewEls = useRef(new Map<string, PreviewWebview>());
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

    for (const [key, el] of webviewEls.current) {
      el.style.position = "fixed";
      el.style.display = "flex";
      if (key === activeKey && placeholder) {
        const rect = placeholder.getBoundingClientRect();
        el.style.top = `${rect.top}px`;
        el.style.left = `${rect.left}px`;
        el.style.width = `${rect.width}px`;
        el.style.height = `${rect.height}px`;
        el.style.pointerEvents = "auto";
        el.style.zIndex = "20";
      } else {
        // Park inactive panes off-screen at full size so the guest keeps
        // rendering with a realistic viewport (snapshots stay accurate).
        el.style.top = "0px";
        el.style.left = "-100000px";
        el.style.width = `${parkW}px`;
        el.style.height = `${parkH}px`;
        el.style.pointerEvents = "none";
        el.style.zIndex = "-1";
      }
    }
  }, []);

  const registerWebview = useCallback(
    (key: string, el: PreviewWebview | null) => {
      if (el) {
        el.style.position = "fixed";
        el.style.left = "-100000px";
        webviewEls.current.set(key, el);
      } else {
        webviewEls.current.delete(key);
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
    (key: string, url: string) => {
      if (!available) {
        toast.error("Preview is only available in the Electron app");
        return;
      }
      surface(key);
      store.update(key, { input: url, loading: true, error: null });
      getController()
        .validatePreviewUrl(url, store.getRoot(key))
        .then((result) => {
          if (!result.allowed || !result.url) {
            const error = result.error ?? "Preview URL is not allowed";
            store.update(key, { loading: false, error });
            toast.error(error);
            return;
          }
          store.update(key, {
            input: result.url,
            url: result.url,
            title: null,
            loading: true,
            error: null,
          });
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : "Failed to open preview";
          store.update(key, { loading: false, error: message });
          toast.error(message);
        });
    },
    [available, store, surface]
  );

  const clear = useCallback(
    (key: string) => {
      store.update(key, { url: null, title: null, loading: false, error: null });
    },
    [store]
  );

  const reload = useCallback((key: string) => {
    webviewEls.current.get(key)?.reload?.();
  }, []);

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
      setInput,
      trackPane,
      setActivePane,
    }),
    [available, store, openUrl, clear, reload, setInput, trackPane, setActivePane]
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
          />
        </div>
      )}
    </PreviewBrowserContext.Provider>
  );
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
}: {
  store: PreviewBrowserStore;
  openUrl: (key: string, url: string) => void;
  available: boolean;
  registerWebview: (key: string, el: PreviewWebview | null) => void;
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
          url={pane.url}
          store={store}
          openUrl={openUrl}
          available={available}
          registerWebview={registerWebview}
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
  url,
  store,
  openUrl,
  available,
  registerWebview,
}: {
  paneKey: string;
  url: string | null;
  store: PreviewBrowserStore;
  openUrl: (key: string, url: string) => void;
  available: boolean;
  registerWebview: (key: string, el: PreviewWebview | null) => void;
}) {
  const webviewRef = useRef<PreviewWebview | null>(null);

  usePreviewBrowserHost({
    enabled: available,
    browserKey: paneKey,
    getWebview: useCallback(() => webviewRef.current, []),
    openUrl: useCallback((next: string) => openUrl(paneKey, next), [openUrl, paneKey]),
  });

  // Mirror the live page's load lifecycle into pane state. Intercept in-page
  // navigations so they flow through the validated open path.
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onStart = () => store.update(paneKey, { loading: true, error: null });
    const onStop = () => store.update(paneKey, { loading: false });
    const onFail = (event: Event) =>
      store.update(paneKey, {
        loading: false,
        error: eventString(event, "errorDescription") ?? "Preview failed to load",
      });
    const onTitle = (event: Event) =>
      store.update(paneKey, { title: eventString(event, "title") });
    const onWillNavigate = (event: Event) => {
      const next = eventString(event, "url");
      if (!next || next === store.getPane(paneKey).url) return;
      event.preventDefault();
      openUrl(paneKey, next);
    };

    webview.addEventListener("did-start-loading", onStart);
    webview.addEventListener("did-stop-loading", onStop);
    webview.addEventListener("did-fail-load", onFail);
    webview.addEventListener("page-title-updated", onTitle);
    webview.addEventListener("will-navigate", onWillNavigate);
    return () => {
      webview.removeEventListener("did-start-loading", onStart);
      webview.removeEventListener("did-stop-loading", onStop);
      webview.removeEventListener("did-fail-load", onFail);
      webview.removeEventListener("page-title-updated", onTitle);
      webview.removeEventListener("will-navigate", onWillNavigate);
    };
  }, [paneKey, store, openUrl, url]);

  if (!url) return null;

  return createElement("webview", {
    ref: (el: PreviewWebview | null) => {
      webviewRef.current = el;
      registerWebview(paneKey, el);
    },
    src: url,
    partition: "controller-preview",
    webpreferences: "contextIsolation=yes,nodeIntegration=no,sandbox=yes",
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface PaneTopology {
  key: string;
  url: string | null;
}

/**
 * External store backing the panes. Granular subscriptions keep webview load
 * churn (loading/title flips) from re-rendering the whole app: chrome consumers
 * subscribe to a single pane, the frame list subscribes to topology (the set of
 * panes and their URLs).
 */
class PreviewBrowserStore {
  private panes = new Map<string, PreviewPaneState>();
  private roots = new Map<string, string | undefined>();
  private order: string[] = [];
  private paneListeners = new Map<string, Set<() => void>>();
  private topologyListeners = new Set<() => void>();
  private topologySnapshot: PaneTopology[] = [];

  getPane(key: string | null): PreviewPaneState {
    if (!key) return EMPTY_PANE;
    return this.panes.get(key) ?? EMPTY_PANE;
  }

  getRoot(key: string): string | undefined {
    return this.roots.get(key);
  }

  getTopology(): PaneTopology[] {
    return this.topologySnapshot;
  }

  track(key: string, projectRoot?: string): void {
    this.roots.set(key, projectRoot);
    if (this.panes.has(key)) return;
    this.panes.set(key, EMPTY_PANE);
    this.order.push(key);
    this.rebuildTopology();
    this.emitTopology();
  }

  update(key: string, partial: Partial<PreviewPaneState>): void {
    const prev = this.panes.get(key) ?? EMPTY_PANE;
    const next = { ...prev, ...partial };
    this.panes.set(key, next);
    if (!this.order.includes(key)) {
      this.order.push(key);
      this.rebuildTopology();
      this.emitTopology();
    } else if (prev.url !== next.url) {
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
      url: (this.panes.get(key) ?? EMPTY_PANE).url,
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
  openUrl: (key: string, url: string) => void;
  clear: (key: string) => void;
  reload: (key: string) => void;
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
  key: "url" | "errorDescription" | "title"
): string | null {
  const value = (event as Event & Record<typeof key, unknown>)[key];
  return typeof value === "string" ? value : null;
}
