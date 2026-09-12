import type { RequestHandler } from "express";
import { getSessionAccount } from "../services/api";
import { availableWorkspaceModules } from "../routes/role-sections";

export type SystemStatusBarViewModel = {
  authenticated: boolean;
  currentUserEmail: string | null;
  availableWorkspaceModuleCount: number;
  hideWorkspaceSwitch: boolean;
};

export function createSystemStatusBarViewModelMiddleware(): RequestHandler {
  return async (req, res, next) => {
    try {
      const session = await getSessionAccount(req.headers.cookie);
      const authenticated = Boolean(session.authenticated && session.user);
      const roles = authenticated && session.user && Array.isArray(session.user.roles)
        ? session.user.roles
        : [];

      res.locals.systemStatusBar = {
        authenticated,
        currentUserEmail: authenticated && session.user ? session.user.email : null,
        availableWorkspaceModuleCount: availableWorkspaceModules(roles).length,
        hideWorkspaceSwitch: req.path === "/choose-role"
      } satisfies SystemStatusBarViewModel;
      next();
    } catch (error) {
      next(error);
    }
  };
}
