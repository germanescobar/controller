import type { startSession } from "../api.ts";

export interface SteerStream {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface BackgroundEmulatedSteer {
  projectId: string;
  sessionId: string;
  text: string;
  options: NonNullable<Parameters<typeof startSession>[2]>;
  stopRequest: Promise<void>;
}

/** Finish a stopped run and start its steer on the original session after navigation. */
export function continueEmulatedSteerInBackground(
  source: SteerStream,
  pending: BackgroundEmulatedSteer,
  start: (projectId: string, text: string, options: BackgroundEmulatedSteer["options"]) => SteerStream,
  onComplete: (sessionId: string) => void,
  onError: (error: Error) => void,
): void {
  let sourceFinished = false;
  const fail = (error: Error) => {
    if (sourceFinished) return;
    sourceFinished = true;
    source.close();
    onError(error);
  };

  void pending.stopRequest.catch((error: unknown) => {
    fail(error instanceof Error ? error : new Error(String(error)));
  });

  source.onmessage = (event) => {
    if (sourceFinished) return;
    const status = readTerminalStatus(event.data);
    if (!status) return;
    if (status.type === "error") {
      fail(new Error(status.text));
      return;
    }
    sourceFinished = true;
    source.close();
    void pending.stopRequest.then(() => {
      const resumed = start(pending.projectId, pending.text, {
        ...pending.options,
        resumeSessionId: pending.sessionId,
      });
      let resumedFinished = false;
      const finish = (error?: Error) => {
        if (resumedFinished) return;
        resumedFinished = true;
        resumed.close();
        if (error) onError(error);
        else onComplete(pending.sessionId);
      };
      resumed.onmessage = (resumedEvent) => {
        const result = readTerminalStatus(resumedEvent.data);
        if (result?.type === "done") finish();
        else if (result?.type === "error") finish(new Error(result.text));
      };
      resumed.onerror = () => finish(new Error("Steered run disconnected"));
    }).catch((error: unknown) => {
      onError(error instanceof Error ? error : new Error(String(error)));
    });
  };
  source.onerror = () => fail(new Error("Stopped run disconnected before steer resumed"));
}

function readTerminalStatus(data: string): { type: "done" } | { type: "error"; text: string } | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    if (value.type === "done") return { type: "done" };
    if (value.type === "error") {
      return {
        type: "error",
        text: "text" in value && typeof value.text === "string" ? value.text : "Agent error",
      };
    }
  } catch {
    // Ignore malformed progress events; only terminal events affect this handoff.
  }
  return null;
}
