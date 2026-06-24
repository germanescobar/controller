import { Router, type Response } from "express";
import { getProject } from "../lib/projects.js";
import { subscribeProjectEvents, type ProjectEvent } from "../lib/events.js";

/*
 * Project-scoped event stream (issue #210).
 *
 * Streams `projectEvents` from `server/lib/events.ts` over SSE, filtered
 * to the active project. The app shell opens one `EventSource` per
 * active project and refetches when it sees a relevant event.
 *
 * Heartbeat matches the per-session stream
 * (`SSE_HEARTBEAT_INTERVAL_MS = 15s` in routes/sessions.ts) so existing
 * proxy / load-balancer timeouts don't tear down quiet connections.
 */

export const eventsRouter = Router({ mergeParams: true });

const SSE_HEARTBEAT_INTERVAL_MS = 15 * 1000;

/**
 * Returns true when the event should be delivered to a stream
 * subscribed for `projectId`. Per-project events (`worktree_*`,
 * `session_*`) are scoped to the project that owns them. Project-
 * lifecycle events (`project_added/updated/removed`) are broadcast on
 * every project's stream: the app shell needs to learn about
 * out-of-band project creates/renames/deletes happening on *other*
 * projects too, and `App.tsx` already routes those events through
 * `loadProjects()` (issue #210 review feedback).
 */
function shouldDeliver(event: ProjectEvent, projectId: string): boolean {
  if (
    event.type === "project_added" ||
    event.type === "project_updated" ||
    event.type === "project_removed"
  ) {
    return true;
  }
  return event.projectId === projectId;
}

eventsRouter.get("/:projectId/events", async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const projectId = project.id;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  function send(obj: ProjectEvent): void {
    if (!clientConnected) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // Initial comment line so the client's `EventSource` flips to `OPEN`
  // immediately and the UI doesn't sit on `CONNECTING` until the first
  // lifecycle event lands.
  res.write(": connected\n\n");

  let clientConnected = true;
  req.on("close", () => {
    clientConnected = false;
  });

  const unsubscribe = subscribeProjectEvents((event) => {
    if (!shouldDeliver(event, projectId)) return;
    send(event);
  });

  const heartbeat = setInterval(() => {
    if (clientConnected) res.write(": ping\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);

  // If a response handle outlives the route (Express shouldn't, but be
  // defensive) the heartbeat + subscriber would leak. Funnel cleanup
  // through one place so we don't double-clear.
  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
});
