import type { NextFunction, Request, Response } from "express";

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("ridematrix-web error:", error);

  res.status(500).render("pages/unavailable", {
    title: "Access",
    appTitle: process.env.APP_TITLE || "RideMatrix"
  });
}
