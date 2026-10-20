import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { installTerminalTouchScroll } from "@/lib/terminal-touch-scroll";
import { isReplayDeviceResponse } from "@/lib/terminal-replay";
import "@xterm/xterm/css/xterm.css";

export type TerminalSpecialKey =
  | "escape"
  | "tab"
  | "enter"
  | "backspace"
  | "ctrl-c"
  | "ctrl-d"
  | "left"
  | "up"
  | "down"
  | "right";

export interface TerminalHandle {
  sendSpecialKey: (key: TerminalSpecialKey) => void;
  focus: () => void;
  close: () => void;
}

interface TerminalProps {
  projectId: string;
  worktreeId?: string;
  terminalId: string;
}

function encodeSpecialKey(term: XTerm, key: TerminalSpecialKey): string {
  switch (key) {
    case "escape":
      return "\u001b";
    case "tab":
      return "\t";
    case "enter":
      return "\r";
    case "backspace":
      return "\u007f";
    case "ctrl-c":
      return "\u0003";
    case "ctrl-d":
      return "\u0004";
    case "left":
      return term.modes.applicationCursorKeysMode ? "\u001bOD" : "\u001b[D";
    case "up":
      return term.modes.applicationCursorKeysMode ? "\u001bOA" : "\u001b[A";
    case "down":
      return term.modes.applicationCursorKeysMode ? "\u001bOB" : "\u001b[B";
    case "right":
      return term.modes.applicationCursorKeysMode ? "\u001bOC" : "\u001b[C";
  }
}

function forceSelectionMouseEvent(event: MouseEvent): void {
  if (event.button !== 0) return;

  Object.defineProperties(event, {
    altKey: { configurable: true, value: true },
    shiftKey: { configurable: true, value: true },
  });
}

function isMobileTerminal(): boolean {
  return window.matchMedia("(pointer: coarse), (max-width: 767px)").matches;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal({ projectId, worktreeId, terminalId }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const hasAttachedRef = useRef(false);
    const replayingRef = useRef(false);
    // Issue #296: when the user clicks X while the WebSocket is still
    // CONNECTING, the imperative `close()` is a no-op (it requires OPEN).
    // Track that intent here so the `onopen` handler can deliver the `close`
    // message the moment the connection is up. The server fix (PUT
    // /terminal-tabs calls ptyManager.kill) is the authoritative one; this
    // just keeps the WS handshake from stranding an attached tmux session
    // for ~50–200ms on slow networks.
    const pendingCloseRef = useRef(false);

    useImperativeHandle(ref, () => ({
      sendSpecialKey(key: TerminalSpecialKey) {
        const term = termRef.current;
        const ws = wsRef.current;
        if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
        const encoded = encodeSpecialKey(term, key);
        ws.send(JSON.stringify({ type: "input", data: encoded }));
      },
      focus() {
        termRef.current?.focus();
      },
      close() {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "close" }));
          return;
        }
        // WS not yet OPEN (still CONNECTING, reconnecting, or null). Mark the
        // intent so `onopen` delivers the `close` as soon as it can; otherwise
        // the server would see only a plain disconnect and the tmux session
        // would survive, getting re-merged into the tab list on the next poll
        // (issue #296).
        pendingCloseRef.current = true;
      },
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const term = new XTerm({
        theme: {
          background: "#1c1c1e",
          foreground: "#f5f5f7",
          cursor: "#f5f5f7",
          selectionBackground: "#3a3a3c",
          selectionInactiveBackground: "#3a3a3c",
        },
        fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
        fontSize: 13,
        cursorBlink: true,
        scrollback: 50000,
        allowProposedApi: true,
        macOptionClickForcesSelection: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      container.addEventListener("mousedown", forceSelectionMouseEvent, { capture: true });

      // xterm's screen sits above its scrollable viewport. Handle a finger
      // drag there directly so it scrolls history without reaching tmux as
      // mouse tracking or a synthetic click.
      const removeTouchScroll = installTerminalTouchScroll(container, term);

      requestAnimationFrame(() => {
        fitAddon.fit();
      });

      termRef.current = term;
      fitRef.current = fitAddon;

      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (container.clientWidth === 0 || container.clientHeight === 0) return;
          fitAddon.fit();
        });
      });
      resizeObserver.observe(container);

      return () => {
        resizeObserver.disconnect();
        container.removeEventListener("mousedown", forceSelectionMouseEvent, { capture: true });
        removeTouchScroll();
        term.dispose();
        termRef.current = null;
        fitRef.current = null;
      };
    }, []);

    // Handle WebSocket connection (per worktree terminal)
    useEffect(() => {
      const term = termRef.current;
      if (!term || !projectId) return;

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      // In dev, connect directly to the Express server to avoid
      // Vite proxy issues with WebSocket upgrades from external devices.
      const host = window.location.hostname;
      const port = import.meta.env.DEV
        ? (import.meta.env.VITE_API_PORT ?? "3100")
        : window.location.port;
      const wsUrl = `${protocol}//${host}:${port}/ws/terminal`;
      let reconnectTimer: number | null = null;
      let disposed = false;

      const fitAndSendResize = () => {
        const fitAddon = fitRef.current;
        const ws = wsRef.current;
        if (!fitAddon || !ws || ws.readyState !== WebSocket.OPEN) return;
        fitAddon.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          })
        );
      };

      const connect = () => {
        if (disposed) return;
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          // Issue #296: if the user clicked X while we were still CONNECTING,
          // deliver the close now instead of attaching a tmux session that the
          // server's `ws.on(close, …)` would otherwise leave alive.
          if (pendingCloseRef.current) {
            ws.send(JSON.stringify({ type: "close" }));
            ws.close(1000);
            return;
          }
          ws.send(
            JSON.stringify({
              type: "attach",
              projectId,
              worktreeId,
              terminalId,
              replayBuffer: !hasAttachedRef.current,
              canResize: !isMobileTerminal(),
            })
          );
          hasAttachedRef.current = true;

          fitAndSendResize();
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            term.write(String(msg.data));
          } else if (msg.type === "replay") {
            // Old terminal queries must not send fresh device responses to
            // the shell, which can print them as literal escape sequences.
            replayingRef.current = true;
            term.write(String(msg.data), () => { replayingRef.current = false; });
          } else if (msg.type === "error") {
            term.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`);
          } else if (msg.type === "attached") {
            fitAndSendResize();
          }
        };

        ws.onerror = () => {
          if (!disposed) {
            term.writeln("\x1b[31mWebSocket connection failed.\x1b[0m");
          }
        };

        ws.onclose = (event) => {
          if (wsRef.current === ws) {
            wsRef.current = null;
          }
          if (disposed || event.code === 1000) return;
          term.writeln(`\x1b[31mConnection lost (code ${event.code}). Reconnecting...\x1b[0m`);
          reconnectTimer = window.setTimeout(connect, 1000);
        };
      };

      connect();

      const inputDisposable = term.onData((data: string) => {
        if (replayingRef.current && isReplayDeviceResponse(data)) return;
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      const resizeDisposable = term.onResize(
        ({ cols, rows }: { cols: number; rows: number }) => {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }
      );

      return () => {
        disposed = true;
        if (reconnectTimer !== null) {
          window.clearTimeout(reconnectTimer);
        }
        inputDisposable.dispose();
        resizeDisposable.dispose();
        wsRef.current?.close();
        wsRef.current = null;
      };
    }, [projectId, worktreeId, terminalId]);

    return (
      <div
        ref={containerRef}
        className="terminal-panel h-full w-full"
        style={{ backgroundColor: "#1c1c1e" }}
      />
    );
  }
);
