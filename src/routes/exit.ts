import { Router } from "express";
import { logoutSession } from "../services/api";

export function createExitRouter(): Router {
  const router = Router();

  router.post("/exit", async (req, res, next) => {
    try {
      const result = await logoutSession(req.headers.cookie);

      for (const cookie of result.setCookie) {
        res.append("Set-Cookie", cookie);
      }

      if (!result.ok) {
        console.warn(`Logout API returned HTTP ${result.status}; redirecting to access`);
      }

      res.redirect("/access");
    } catch (error) {
      // Do not expose an upstream error, cookie, or session identifier to the
      // client. The local response is deterministic even if the API is down.
      console.warn("Logout API request failed; redirecting to access");
      res.redirect("/access");
    }
  });

  router.get("/exit", (_req, res) => {
    res.redirect("/access");
  });

  return router;
}
