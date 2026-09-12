import type { RequestHandler } from "express";

/**
 * Prevent authenticated HTML and other protected responses from being restored
 * from a browser cache after the session has been invalidated.
 */
export const noStoreProtectedResponse: RequestHandler = (_req, res, next) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    Expires: "0"
  });
  next();
};
