import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal({ projectId, worktreeId, terminalId }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<XTerm | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);

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
      // In dev, connect directly to the Express server (port 3100) to avoid
      // Vite proxy issues with WebSocket upgrades from external devices.
      const host = window.location.hostname;
      const port = import.meta.env.DEV ? "3100" : window.location.port;
      const wsUrl = `${protocol}//${host}:${port}/ws/terminal`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "attach", projectId, worktreeId, terminalId }));

        const fitAddon = fitRef.current;
        if (fitAddon) {
          fitAddon.fit();
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "error") {
          term.writeln(`\x1b[31mError: ${msg.message}\x1b[0m`);
        }
      };

      ws.onerror = () => {
        term.writeln("\x1b[31mWebSocket connection failed.\x1b[0m");
      };

      ws.onclose = (event) => {
        if (event.code !== 1000) {
          term.writeln(`\x1b[31mConnection lost (code ${event.code}).\x1b[0m`);
        }
      };

      const inputDisposable = term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      const resizeDisposable = term.onResize(
        ({ cols, rows }: { cols: number; rows: number }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        }
      );

      return () => {
        inputDisposable.dispose();
        resizeDisposable.dispose();
        ws.close();
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
