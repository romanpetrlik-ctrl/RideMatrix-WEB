export type SessionAccount = {
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    roles: string[];
    active_role?: string;
  };
};

const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:4000";

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

export async function submitAccessRequest(email: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/auth/magic-link/request`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email })
  });

  if (!response.ok) {
    throw new Error(`Access request failed with status ${response.status}`);
  }
}

export async function getSessionAccount(cookieHeader?: string): Promise<SessionAccount> {
  const response = await fetch(`${apiBaseUrl}/auth/session`, {
    method: "GET",
    headers: cookieHeader
      ? {
          cookie: cookieHeader
        }
      : undefined
  });

  if (!response.ok) {
    throw new Error(`Session request failed with status ${response.status}`);
  }

  return (await response.json()) as SessionAccount;
}

export async function selectActiveRole(
  role: string,
  cookieHeader?: string
): Promise<{ ok: true; activeRole: string; setCookie: string[] }> {
  const response = await fetch(`${apiBaseUrl}/auth/role/select`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookieHeader
        ? {
            cookie: cookieHeader
          }
        : {})
    },
    body: JSON.stringify({ role })
  });

  if (!response.ok) {
    throw new Error(`Role select failed with status ${response.status}`);
  }

  const payload = (await response.json()) as { ok: true; activeRole: string };
  const setCookie = response.headers.getSetCookie?.() ?? [];

  return {
    ...payload,
    setCookie
  };
}

export type LogoutSessionResult = {
  ok: boolean;
  setCookie: string[];
  status: number;
};

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers.getSetCookie?.();
  if (headers && headers.length > 0) {
    return headers;
  }

  const combinedHeader = response.headers.get("set-cookie");
  return combinedHeader ? [combinedHeader] : [];
}

export async function logoutSession(cookieHeader?: string): Promise<LogoutSessionResult> {
  const response = await fetch(`${apiBaseUrl}/auth/logout`, {
    method: "POST",
    headers: cookieHeader
      ? {
          cookie: cookieHeader
        }
      : undefined
  });

  return {
    ok: response.ok,
    setCookie: getSetCookieHeaders(response),
    status: response.status
  };
}
