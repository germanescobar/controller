import { useEffect, useRef } from "react";

import { isControllerAvailable } from "./controller.ts";

/**
 * App-wide approval notification delivered over the `/api/events` stream when an
 * agent blocks on a tool/plan approval. Mirrors the server's `RuntimeNotification`.
 */
export interface ApprovalNotification {
  kind: "needs_input";
  sessionId: string;
  projectId?: string;
  worktreeId?: string;
  provider?: string;
  toolName: string;
  requestId: string;
}

interface UseApprovalNotificationsOptions {
  /** Session currently shown in the foreground; used to suppress self-alerts. */
  activeSessionId?: string;
  /** Open the session a clicked notification refers to. */
  onActivate: (notification: ApprovalNotification) => void;
}

/*
 * Subscribes once (for the app lifetime) to the server's app-wide event stream
 * and raises an OS notification when an agent needs an approval. The stream is
 * independent of which session view is mounted, so the alert fires even when the
 * user is on another session or has the window in the background — which is
 * exactly when it's useful.
 */
export function useApprovalNotifications({
  activeSessionId,
  onActivate,
}: UseApprovalNotificationsOptions): void {
  // Keep the latest values in refs so the EventSource subscription can stay
  // mounted for the app lifetime without reconnecting on every render.
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    // Browser builds need explicit permission; Electron grants it implicitly.
    if (Notification.permission === "default") {
      void Notification.requestPermission();
    }

    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      let data: ApprovalNotification;
      try {
        data = JSON.parse(event.data) as ApprovalNotification;
      } catch {
        return;
      }
      if (data.kind !== "needs_input") return;

      // Nothing to alert about if the user is already watching this session in
      // a focused window.
      const isForeground =
        data.sessionId === activeSessionIdRef.current && document.hasFocus();
      if (isForeground) return;

      if (Notification.permission !== "granted") return;

      const notification = new Notification("Approval needed", {
        body: `A ${data.provider ?? "Claude"} session is waiting to run ${data.toolName}.`,
        // Collapse repeated alerts for the same session into one.
        tag: data.sessionId,
      });
      notification.onclick = () => {
        if (isControllerAvailable()) {
          window.controller?.showWindow();
        }
        window.focus();
        onActivateRef.current(data);
      };
    };

    return () => source.close();
  }, []);
}
