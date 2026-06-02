import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const DISABLE_MOUSE_TRACKING = "\x1b[?9;1000;1002;1003;1005;1006;1015l";
const MOUSE_TRACKING_MODES = new Set(["9", "1000", "1002", "1003", "1005", "1006", "1015"]);
const PRIVATE_MODE_SEQUENCE = /\x1b\[\?([0-9;]*)([hl])/g;
const SGR_MOUSE_INPUT = /\x1b\[<[0-9;]+[Mm]/g;
const X10_MOUSE_INPUT = /\x1b\[M[\s\S]{3}/g;
const POINTER_SUPPRESSION_MS = 250;
const CURSOR_VERTICAL_INPUT = /^(?:\x1b\[[AB]|\x1bO[AB])+$/;

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

function stripMouseTrackingEnableSequences(data: string): string {
  return data.replace(PRIVATE_MODE_SEQUENCE, (sequence, rawModes: string, command: string) => {
    if (command !== "h") return sequence;

    const modes = rawModes.split(";").filter(Boolean);
    const allowedModes = modes.filter((mode) => !MOUSE_TRACKING_MODES.has(mode));

    if (allowedModes.length === modes.length) return sequence;
    return allowedModes.length > 0 ? `\x1b[?${allowedModes.join(";")}h` : "";
  });
}

function stripMouseTrackingInput(data: string): string {
  return data.replace(SGR_MOUSE_INPUT, "").replace(X10_MOUSE_INPUT, "");
}

function isVerticalCursorInput(data: string): boolean {
  return CURSOR_VERTICAL_INPUT.test(data);
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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal({ projectId, worktreeId, terminalId }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const hasAttachedRef = useRef(false);
    const suppressPointerInputUntilRef = useRef(0);
    const keyboardInputUntilRef = useRef(0);

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
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: "close" }));
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
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      term.write(DISABLE_MOUSE_TRACKING);

      const suppressPointerInput = () => {
        suppressPointerInputUntilRef.current = Date.now() + POINTER_SUPPRESSION_MS;
      };

      term.attachCustomKeyEventHandler((event) => {
        if (
          event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight"
        ) {
          keyboardInputUntilRef.current = Date.now() + POINTER_SUPPRESSION_MS;
        }

        return true;
      });

      container.addEventListener("pointerdown", suppressPointerInput);
      container.addEventListener("pointermove", suppressPointerInput);
      window.addEventListener("pointerup", suppressPointerInput);

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
        container.removeEventListener("pointerdown", suppressPointerInput);
        container.removeEventListener("pointermove", suppressPointerInput);
        window.removeEventListener("pointerup", suppressPointerInput);
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
          ws.send(
            JSON.stringify({
              type: "attach",
              projectId,
              worktreeId,
              terminalId,
              replayBuffer: !hasAttachedRef.current,
            })
          );
          hasAttachedRef.current = true;

          fitAndSendResize();
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === "output") {
            term.write(stripMouseTrackingEnableSequences(String(msg.data)));
          } else if (msg.type === "error") {
            term.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`);
          } else if (msg.type === "attached") {
            term.write(DISABLE_MOUSE_TRACKING);
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
        const input = stripMouseTrackingInput(data);
        if (!input) return;
        if (
          isVerticalCursorInput(input) &&
          Date.now() <= suppressPointerInputUntilRef.current &&
          Date.now() > keyboardInputUntilRef.current
        ) {
          return;
        }

        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: input }));
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
