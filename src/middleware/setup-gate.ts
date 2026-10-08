import type { NextFunction, Request, RequestHandler, Response } from "express";
import { SessionAccount, getSessionAccount } from "../services/api";
import { getSetupOverview } from "../services/system-setup";

type SetupGateOptions = {
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  loadSetupOverview?: typeof getSetupOverview;
};

const BYPASS_PREFIXES = ["/setup", "/exit"];
const PROTECTED_PREFIXES = [
  "/account",
  "/choose-role",
  "/dashboard",
  "/admin",
  "/customers",
  "/staff",
  "/vehicles",
  "/settings",
  "/tech-support",
  "/vps"
];

function startsWithAny(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function createSetupGateMiddleware(options: SetupGateOptions = {}): RequestHandler {
  const loadSession = options.loadSession ?? getSessionAccount;
  const loadSetupOverview = options.loadSetupOverview ?? getSetupOverview;
  const enabled = process.env.INITIAL_SETUP_GATE_ENABLED === "true";

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!enabled) {
      return next();
    }

    try {
      const pathname = req.path;

      if (startsWithAny(pathname, BYPASS_PREFIXES)) {
        return next();
      }

      const session = await loadSession(req.headers.cookie);
      if (!session.authenticated || !session.user) {
        return next();
      }

      const setup = await loadSetupOverview();
      if (setup.setupCompleted) {
        return next();
      }

      const shouldGate =
        startsWithAny(pathname, PROTECTED_PREFIXES) ||
        pathname === "/entry";

      if (shouldGate) {
        return res.redirect("/setup");
      }

      return next();
    } catch {
      return next();
    }
  };
}
