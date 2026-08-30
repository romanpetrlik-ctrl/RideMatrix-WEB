import { Request, Response, Router } from "express";
import { SessionAccount, getSessionAccount, submitAccessRequest } from "../services/api";
import {
  AssignableRole,
  DuplicateStaffUserEmailError,
  SUPERUSER_ROLE,
  StaffUserActor,
  UnauthorizedRoleDelegationError,
  UnknownRoleError,
  canDelegateRole,
  canManageStaffUsers,
  createStaffUser,
  getInternalRoleLabel,
  getPermissionsForRoles,
  isValidUserEmail,
  listAssignableRoles,
  normalizeUserEmail
} from "../services/staff-users";

type StaffRouterOptions = {
  appTitle: string;
  /** Overridable for tests so no external auth service call is required. */
  loadSession?: (cookieHeader?: string) => Promise<SessionAccount>;
  /**
   * Overridable for tests. Defaults to the existing access-request (login
   * code) flow so no new authentication mechanism is introduced.
   */
  requestAccessCode?: (email: string) => Promise<void>;
};

type InviteFormData = {
  email: string;
  roles: string[];
};

type SuccessNotice = {
  email: string;
  roleLabels: string[];
  invitationSent: boolean;
};

function toRoleList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }

  const single = String(value ?? "").trim();
  return single ? [single] : [];
}

export function createStaffRouter(options: StaffRouterOptions): Router {
  const router = Router();
  const loadSession = options.loadSession ?? getSessionAccount;
  const requestAccessCode = options.requestAccessCode ?? submitAccessRequest;

  async function resolveActor(
    req: Request
  ): Promise<{ actor: StaffUserActor; roles: AssignableRole[] } | "unauthenticated" | "forbidden"> {
    const session = await loadSession(req.headers.cookie);

    if (!session.authenticated || !session.user) {
      return "unauthenticated";
    }

    const sessionRoles = Array.isArray(session.user.roles) ? session.user.roles : [];
    const permissions = await getPermissionsForRoles(sessionRoles);
    const actor: StaffUserActor = {
      email: session.user.email,
      roles: sessionRoles,
      permissions
    };

    if (!canManageStaffUsers(actor)) {
      return "forbidden";
    }

    const roles = await listAssignableRoles();
    return { actor, roles };
  }

  function renderForm(
    res: Response,
    context: {
      actor: StaffUserActor;
      roles: AssignableRole[];
      formData: InviteFormData;
      errors: string[];
      success?: SuccessNotice;
      status?: number;
    }
  ) {
    const assignableRoles = context.roles.map((role) => ({
      ...role,
      canDelegate: canDelegateRole(context.actor, role.name)
    }));

    return res.status(context.status ?? 200).render("pages/staff/invite", {
      title: "Create / Invite user",
      appTitle: options.appTitle,
      email: context.actor.email,
      assignableRoles,
      superuserRole: SUPERUSER_ROLE,
      formData: context.formData,
      errors: context.errors,
      success: context.success ?? null
    });
  }

  function renderUnavailable(res: Response) {
    return res.status(403).render("pages/unavailable", {
      title: "Unavailable",
      appTitle: options.appTitle
    });
  }

  router.get("/staff/invite", async (req, res, next) => {
    try {
      const resolved = await resolveActor(req);

      if (resolved === "unauthenticated") {
        return res.redirect("/access");
      }

      if (resolved === "forbidden") {
        return renderUnavailable(res);
      }

      return renderForm(res, {
        actor: resolved.actor,
        roles: resolved.roles,
        formData: { email: "", roles: [] },
        errors: []
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/staff/invite", async (req, res, next) => {
    try {
      const resolved = await resolveActor(req);

      if (resolved === "unauthenticated") {
        return res.redirect("/access");
      }

      if (resolved === "forbidden") {
        return renderUnavailable(res);
      }

      const { actor, roles } = resolved;
      const email = normalizeUserEmail(req.body.email);
      const selectedRoles = toRoleList(req.body.roles);
      const formData: InviteFormData = { email, roles: selectedRoles };
      const errors: string[] = [];

      if (!email) {
        errors.push("Email is required.");
      } else if (!isValidUserEmail(email)) {
        errors.push("Enter a valid email address.");
      }

      if (selectedRoles.length === 0) {
        errors.push("Select at least one role for the invited account.");
      }

      for (const role of selectedRoles) {
        const known = roles.find((candidate) => candidate.name === role);

        if (!known) {
          errors.push(`Role "${role}" is not available for internal staff accounts.`);
          continue;
        }

        if (!canDelegateRole(actor, known.name)) {
          errors.push(`You are not authorized to delegate the ${known.label} role.`);
        }
      }

      if (
        selectedRoles.includes(SUPERUSER_ROLE) &&
        String(req.body.confirmSuperuser || "") !== "yes"
      ) {
        errors.push(
          `Confirm the superuser delegation warning before creating a ${getInternalRoleLabel(
            SUPERUSER_ROLE
          )} account.`
        );
      }

      if (errors.length > 0) {
        return renderForm(res, { actor, roles, formData, errors, status: 400 });
      }

      let created;

      try {
        created = await createStaffUser({ email, roles: selectedRoles, actor });
      } catch (error) {
        if (error instanceof DuplicateStaffUserEmailError) {
          return renderForm(res, {
            actor,
            roles,
            formData,
            errors: ["An account with this email address already exists."],
            status: 400
          });
        }

        if (error instanceof UnknownRoleError || error instanceof UnauthorizedRoleDelegationError) {
          return renderForm(res, {
            actor,
            roles,
            formData,
            errors: ["The selected roles could not be assigned."],
            status: 400
          });
        }

        throw error;
      }

      let invitationSent = false;

      try {
        await requestAccessCode(created.email);
        invitationSent = true;
      } catch {
        // Login-code delivery is not configured or unavailable. The account is
        // created and can still be accessed through the normal /access flow;
        // no reusable secret is generated, stored, or logged here.
        invitationSent = false;
      }

      return renderForm(res, {
        actor,
        roles,
        formData: { email: "", roles: [] },
        errors: [],
        success: {
          email: created.email,
          roleLabels: created.roles.map((role) => getInternalRoleLabel(role)),
          invitationSent
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
