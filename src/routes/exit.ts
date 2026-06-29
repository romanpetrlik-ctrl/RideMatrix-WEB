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

      res.redirect("/access");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
