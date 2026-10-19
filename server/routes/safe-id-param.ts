import type { Router } from "express";
import { InvalidIdError, isSafeId } from "../lib/paths.js";

/*
 * Reject route params that are not safe file-name ids with a 400 before any
 * handler runs (issue #453). Express decodes params, so `..%2F..%2Fx` would
 * otherwise reach the lib layer as `../../x`. The lib-layer path builders
 * enforce the same rule; this maps it to a client error instead of a 500.
 */
export function rejectUnsafeIdParam(router: Router, param: string, kind: string): void {
  router.param(param, (_req, res, next, value: string) => {
    if (isSafeId(value)) {
      next();
      return;
    }
    res.status(400).json({ error: new InvalidIdError(kind, value).message });
  });
}
