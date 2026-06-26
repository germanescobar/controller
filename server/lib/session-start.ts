import type { Response } from "express";

/*
 * In-process session start (issue #243).
 *
 * The scheduler fires a schedule by starting a brand-new session, but it
 * runs inside the server process — it shouldn't loop back through HTTP just
 * to reach the same pipeline the `POST /sessions` route already exposes.
 *
 * This module reuses that route's headless machinery directly: it builds the
 * same request shim the headless POST endpoint uses, pairs it with a capturing
 * response that resolves a promise once the shim flushes `{ sessionId, url }`,
 * and awaits the shared `handleSessionStream` pipeline (validation → spawn →
 * event stream → persistence). The result is identical to what the CLI's
 * `sessions start` produces, minus the network hop.
 *
 * `routes/sessions.ts` is imported dynamically to avoid a load-time import
 * cycle (the routes import plenty of lib modules already).
 */

export interface StartSessionInProcessParams {
  projectId: string;
  worktreeId: string;
  prompt: string;
  provider?: string;
  model?: string;
  mode?: "default" | "plan";
}

export async function startSessionInProcess(
  params: StartSessionInProcessParams
): Promise<{ sessionId: string; url: string }> {
  const { handleSessionStream, makeHeadlessSessionStartRequest, makeSessionStartShim } =
    await import("../routes/sessions.js");

  const { res: capturingRes, settled } = makeCapturingResponse();
  const shim = makeSessionStartShim(params.projectId, params.worktreeId, capturingRes);

  const req = makeHeadlessSessionStartRequest(undefined, params.projectId, params.worktreeId, {
    message: params.prompt,
    provider: params.provider,
    model: params.model,
    mode: params.mode ?? "default",
    attachmentIds: [],
  });

  // The shim resolves `settled` via the capturing response; surface any
  // synchronous handler failure through the same channel.
  handleSessionStream(req, shim.res).catch((error: unknown) => {
    shim.fail(error instanceof Error ? error.message : String(error));
  });

  const { status, body } = await settled;
  if (status >= 400 || typeof body.sessionId !== "string" || !body.sessionId) {
    throw new Error(body.error ?? `Failed to start scheduled session (HTTP ${status})`);
  }
  return { sessionId: body.sessionId, url: body.url ?? "" };
}

interface CapturedBody {
  sessionId?: string;
  url?: string;
  error?: string;
}

/*
 * A minimal Express `Response` that captures the first `status().json()` /
 * `json()` the shim writes and resolves `settled`. Only the methods the
 * session-start shim touches (`status`, `json`, `end`, `writableEnded`) are
 * implemented; everything else is irrelevant on this path.
 */
function makeCapturingResponse(): {
  res: Response;
  settled: Promise<{ status: number; body: CapturedBody }>;
} {
  let resolve!: (value: { status: number; body: CapturedBody }) => void;
  const settled = new Promise<{ status: number; body: CapturedBody }>((r) => {
    resolve = r;
  });
  let done = false;
  let ended = false;

  function capture(status: number, body: unknown) {
    if (done) return;
    done = true;
    resolve({ status, body: (body ?? {}) as CapturedBody });
  }

  const res = {
    status(code: number) {
      return {
        json: (body: unknown) => {
          capture(code, body);
          return res;
        },
      };
    },
    json(body: unknown) {
      capture(200, body);
      return res;
    },
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
      // If the pipeline closed without ever flushing a response, surface a
      // generic failure so the awaiter never hangs.
      capture(500, { error: "Session start ended without a result" });
      return res;
    },
    on() {
      return res;
    },
  } as unknown as Response;

  return { res, settled };
}
