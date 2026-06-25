import { Router } from "express";
import { findSessionLocation } from "../lib/sessions.js";

/*
 * Resolution for `controller://` internal links.
 *
 * The full-form URI carries project/worktree/session and needs no server
 * round trip, but the short form `controller://session/<id>` names only the
 * session. This route maps that id back to its owning project/worktree so the
 * renderer can navigate. Returns 404 when the session can't be found (deleted,
 * archived, or never existed) so the UI can fall back to a toast.
 */
export const linksRouter = Router();

linksRouter.get("/sessions/:sessionId", async (req, res) => {
  const location = await findSessionLocation(req.params.sessionId);
  if (!location) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json(location);
});
