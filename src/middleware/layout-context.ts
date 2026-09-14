import type { RequestHandler } from "express";

export const CHILD_LAYOUT = "child";

export function isChildWindowLayout(value: unknown): boolean {
  return value === CHILD_LAYOUT;
}

export function createLayoutContextMiddleware(): RequestHandler {
  return (req, res, next) => {
    res.locals.isChildWindow = isChildWindowLayout(req.query.layout);
    next();
  };
}
