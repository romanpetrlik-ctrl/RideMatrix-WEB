import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import { query, withTransaction } from "../database/connection";
import { recordBookingIntegrationAlert } from "./booking-delivery";
import { serviceLocalToUtc } from "./new-bookings";

export type CalendarProvider = "microsoft" | "google";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
};

function providerValue(value: string): CalendarProvider {
  if (value === "microsoft" || value === "google") return value;
  throw new TypeError("Unsupported calendar provider.");
}

function encryptionKey(): Buffer {
  const configured = String(process.env.CALENDAR_TOKEN_ENCRYPTION_KEY ?? "").trim();
  const key = /^[\da-f]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (key.length !== 32) throw new Error("CALENDAR_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return key;
}

function encryptToken(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(value: string): string {
  const [iv, tag, encrypted] = value.split(".");
  if (!iv || !tag || !encrypted) throw new Error("Stored calendar token is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function clientConfiguration(provider: CalendarProvider): { clientId: string; clientSecret: string; tenantId?: string } {
  if (provider === "google") {
    const clientId = String(process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "").trim();
    const clientSecret = String(process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "").trim();
    if (!clientId || !clientSecret) throw new Error("Google driver calendar OAuth is not configured.");
    return { clientId, clientSecret };
  }
  const clientId = String(process.env.M365_DRIVER_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.M365_DRIVER_CLIENT_SECRET ?? "").trim();
  const tenantId = String(process.env.M365_TENANT_ID ?? "").trim();
  if (!clientId || !clientSecret || !tenantId) throw new Error("Microsoft driver calendar OAuth is not configured.");
  return { clientId, clientSecret, tenantId };
}

function redirectUri(provider: CalendarProvider): string {
  const base = String(process.env.APP_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!base || !/^https:\/\//i.test(base)) throw new Error("APP_BASE_URL must be an HTTPS URL for calendar OAuth.");
  return `${base}/driver/calendar/callback/${provider}`;
}

function authorizeUrl(provider: CalendarProvider, state: string): string {
  const { clientId, tenantId } = clientConfiguration(provider);
  const callback = redirectUri(provider);
  const scopes = provider === "google"
    ? "openid email https://www.googleapis.com/auth/calendar.events"
    : "openid profile offline_access User.Read Calendars.ReadWrite";
  const base = provider === "google"
    ? "https://accounts.google.com/o/oauth2/v2/auth"
    : `https://login.microsoftonline.com/${encodeURIComponent(tenantId!)}/oauth2/v2.0/authorize`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    response_mode: "query",
    scope: scopes,
    state,
    access_type: "offline",
    prompt: "consent"
  });
  return `${base}?${params.toString()}`;
}

export async function beginDriverCalendarOAuth(driverId: string, providerInput: string): Promise<string> {
  const provider = providerValue(providerInput);
  const state = randomBytes(32).toString("hex");
  await query(
    `INSERT INTO driver_calendar_oauth_states (state_hash, driver_id, provider, expires_at)
     VALUES ($1,$2,$3,CURRENT_TIMESTAMP + INTERVAL '10 minutes')`,
    [createHash("sha256").update(state).digest("hex"), driverId, provider]
  );
  return authorizeUrl(provider, state);
}

async function exchangeAuthorizationCode(provider: CalendarProvider, code: string): Promise<TokenResponse> {
  const { clientId, clientSecret, tenantId } = clientConfiguration(provider);
  const endpoint = provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${encodeURIComponent(tenantId!)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri(provider),
    grant_type: "authorization_code"
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Calendar OAuth token exchange returned ${response.status}: ${text.slice(0, 1000)}`);
  const token = JSON.parse(text) as TokenResponse;
  if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error("Calendar OAuth provider returned an invalid token response.");
  return token;
}

async function calendarEmail(provider: CalendarProvider, accessToken: string): Promise<string> {
  const endpoint = provider === "google" ? "https://www.googleapis.com/oauth2/v2/userinfo" : "https://graph.microsoft.com/v1.0/me";
  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Calendar profile lookup returned ${response.status}: ${body.slice(0, 1000)}`);
  const profile = JSON.parse(body) as { email?: string; mail?: string; userPrincipalName?: string };
  const email = String(profile.email ?? profile.mail ?? profile.userPrincipalName ?? "").trim();
  if (!email) throw new Error("Calendar provider did not return an account email.");
  return email;
}

export async function completeDriverCalendarOAuth(input: {
  driverId: string;
  providerInput: string;
  state: string;
  code: string;
}): Promise<void> {
  const provider = providerValue(input.providerInput);
  if (!input.state || !input.code) throw new TypeError("Calendar OAuth callback is incomplete.");
  const stateHash = createHash("sha256").update(input.state).digest("hex");
  const valid = await withTransaction(async (client) => {
    const result = await client.query(
      `SELECT state_hash FROM driver_calendar_oauth_states
        WHERE state_hash = $1 AND driver_id = $2 AND provider = $3
          AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        FOR UPDATE`,
      [stateHash, input.driverId, provider]
    );
    if (!result.rowCount) return false;
    await client.query("UPDATE driver_calendar_oauth_states SET consumed_at = CURRENT_TIMESTAMP WHERE state_hash = $1", [stateHash]);
    return true;
  });
  if (!valid) throw new Error("Calendar OAuth state is invalid or expired.");
  const token = await exchangeAuthorizationCode(provider, input.code);
  const email = await calendarEmail(provider, token.access_token);
  const refreshToken = token.refresh_token;
  if (!refreshToken) throw new Error("Calendar provider did not issue a refresh token; disconnect and reconnect with consent.");
  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
  await disconnectDriverCalendar(input.driverId);
  await query(
    `INSERT INTO driver_calendar_connections (
       driver_id, provider, calendar_email, encrypted_access_token,
       encrypted_refresh_token, access_token_expires_at, connected_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (driver_id) DO UPDATE SET provider = EXCLUDED.provider,
       calendar_email = EXCLUDED.calendar_email,
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
       access_token_expires_at = EXCLUDED.access_token_expires_at,
       updated_at = CURRENT_TIMESTAMP`,
    [input.driverId, provider, email, encryptToken(token.access_token), encryptToken(refreshToken), expiresAt]
  );
}

export async function disconnectDriverCalendar(driverId: string): Promise<void> {
  const events = await query<StoredCalendarEvent>(
    `SELECT id, booking_id, calendar_scope, driver_id, provider, external_event_id
       FROM booking_calendar_events
      WHERE driver_id = $1 AND calendar_scope = 'driver' AND sync_status <> 'deleted'`,
    [driverId]
  );
  if (events.rows.length) {
    const token = await refreshDriverToken(driverId);
    for (const event of events.rows) await deleteStoredEvent(event, token.accessToken);
  }
  await query("DELETE FROM driver_calendar_connections WHERE driver_id = $1", [driverId]);
}

export async function getDriverCalendarConnection(driverId: string): Promise<{ provider: CalendarProvider; email: string } | null> {
  const result = await query<{ provider: CalendarProvider; calendar_email: string }>(
    "SELECT provider, calendar_email FROM driver_calendar_connections WHERE driver_id = $1",
    [driverId]
  );
  const connection = result.rows[0];
  return connection ? { provider: connection.provider, email: connection.calendar_email } : null;
}

let microsoftApplicationToken: { value: string; expiresAt: number } | null = null;
async function getMicrosoftApplicationToken(): Promise<string> {
  if (microsoftApplicationToken && microsoftApplicationToken.expiresAt > Date.now() + 60_000) {
    return microsoftApplicationToken.value;
  }
  const tenantId = String(process.env.M365_TENANT_ID ?? "").trim();
  const clientId = String(process.env.M365_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.M365_CLIENT_SECRET ?? "").trim();
  if (!tenantId || !clientId || !clientSecret) throw new Error("Microsoft 365 dispatch calendar credentials are not configured.");
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "https://graph.microsoft.com/.default"
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Microsoft 365 token request returned ${response.status}: ${text.slice(0, 1000)}`);
  const token = JSON.parse(text) as TokenResponse;
  if (!token.access_token || !Number.isFinite(token.expires_in)) {
    throw new Error("Microsoft 365 returned an invalid application token response.");
  }
  microsoftApplicationToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return token.access_token;
}

async function refreshDriverToken(driverId: string): Promise<{ provider: CalendarProvider; accessToken: string }> {
  const result = await query<{
    provider: CalendarProvider;
    encrypted_access_token: string;
    encrypted_refresh_token: string;
    access_token_expires_at: string;
  }>(
    `SELECT provider, encrypted_access_token, encrypted_refresh_token, access_token_expires_at
       FROM driver_calendar_connections WHERE driver_id = $1`,
    [driverId]
  );
  const connection = result.rows[0];
  if (!connection) throw new Error("Driver calendar connection is no longer available.");
  if (new Date(connection.access_token_expires_at).getTime() > Date.now() + 60_000) {
    return { provider: connection.provider, accessToken: decryptToken(connection.encrypted_access_token) };
  }
  const { clientId, clientSecret, tenantId } = clientConfiguration(connection.provider);
  const endpoint = connection.provider === "google"
    ? "https://oauth2.googleapis.com/token"
    : `https://login.microsoftonline.com/${encodeURIComponent(tenantId!)}/oauth2/v2.0/token`;
  const tokenResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: decryptToken(connection.encrypted_refresh_token),
      ...(connection.provider === "microsoft" ? { scope: "offline_access User.Read Calendars.ReadWrite" } : {})
    }),
    signal: AbortSignal.timeout(15_000)
  });
  const body = await tokenResponse.text();
  if (!tokenResponse.ok) throw new Error(`Calendar token refresh returned ${tokenResponse.status}: ${body.slice(0, 1000)}`);
  const token = JSON.parse(body) as TokenResponse;
  if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error("Calendar refresh returned an invalid token response.");
  await query(
    `UPDATE driver_calendar_connections
        SET encrypted_access_token = $2,
            encrypted_refresh_token = $3,
            access_token_expires_at = $4, updated_at = CURRENT_TIMESTAMP
      WHERE driver_id = $1`,
    [driverId, encryptToken(token.access_token),
      encryptToken(token.refresh_token || decryptToken(connection.encrypted_refresh_token)),
      new Date(Date.now() + token.expires_in * 1000).toISOString()]
  );
  return { provider: connection.provider, accessToken: token.access_token };
}

type BookingCalendarEvent = {
  id: string;
  booking_id: string;
  reference: string;
  status: string;
  archived_at: string | null;
  driver_id: string | null;
  service_date: string;
  service_time: string | null;
  service_timezone: string | null;
  pickup: string;
  dropoff: string;
};

type StoredCalendarEvent = {
  id: string;
  booking_id: string;
  calendar_scope: "dispatch" | "driver";
  driver_id: string | null;
  provider: CalendarProvider;
  external_event_id: string | null;
};

function calendarPayload(booking: BookingCalendarEvent) {
  const start = serviceLocalToUtc(booking.service_date, booking.service_time || "00:00");
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    subject: `RideMatrix booking ${booking.reference}`,
    body: {
      contentType: "text",
      content: `Pickup: ${booking.pickup}\nDestination: ${booking.dropoff}\nBooking reference: ${booking.reference}`
    },
    start: { dateTime: start.toISOString(), timeZone: "UTC" },
    end: { dateTime: end.toISOString(), timeZone: "UTC" },
    showAs: "busy"
  };
}

async function calendarApiRequest(
  provider: CalendarProvider,
  accessToken: string,
  eventId: string | null,
  method: "POST" | "PATCH" | "DELETE",
  payload?: Record<string, unknown>,
  scope: "dispatch" | "driver" = "driver"
): Promise<string | null> {
  let endpoint: string;
  if (provider === "google") {
    const path = eventId
      ? `events/${encodeURIComponent(eventId)}`
      : "events";
    endpoint = `https://www.googleapis.com/calendar/v3/calendars/primary/${path}`;
  } else {
    const calendarUser = scope === "dispatch"
      ? String(process.env.M365_CALENDAR_USER ?? "").trim()
      : "me";
    const calendarId = scope === "dispatch" ? String(process.env.M365_CALENDAR_ID ?? "").trim() : "";
    if (scope === "dispatch" && (!calendarUser || !calendarId)) {
      throw new Error("M365_CALENDAR_USER and M365_CALENDAR_ID are required for the dispatch calendar.");
    }
    const collection = scope === "dispatch"
      ? `users/${encodeURIComponent(calendarUser)}/calendars/${encodeURIComponent(calendarId)}/events`
      : "me/events";
    endpoint = `https://graph.microsoft.com/v1.0/${collection}${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
  }
  const response = await fetch(endpoint, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(payload ? { "content-type": "application/json" } : {})
    },
    ...(payload ? {
      body: JSON.stringify(provider === "google" ? {
        summary: payload.subject,
        description: (payload.body as { content?: string }).content ?? "",
        start: payload.start,
        end: payload.end,
        visibility: "private"
      } : { ...payload, sensitivity: "private" })
    } : {}),
    signal: AbortSignal.timeout(15_000)
  });
  if (method === "DELETE" && response.status === 404) return null;
  const body = await response.text();
  if (!response.ok) throw new Error(`Calendar API returned ${response.status}: ${body.slice(0, 1000)}`);
  if (method === "DELETE" || !body) return null;
  const result = JSON.parse(body) as { id?: string };
  if (!eventId && !result.id) throw new Error("Calendar provider did not return an event ID.");
  return result.id ?? eventId;
}

async function upsertStoredEvent(booking: BookingCalendarEvent, scope: "dispatch" | "driver", driverId: string | null, provider: CalendarProvider): Promise<StoredCalendarEvent> {
  const id = randomUUID();
  const result = scope === "dispatch"
    ? await query<StoredCalendarEvent>(
      `INSERT INTO booking_calendar_events (id, booking_id, calendar_scope, provider)
       VALUES ($1,$2,'dispatch',$3)
       ON CONFLICT (booking_id) WHERE calendar_scope = 'dispatch'
       DO UPDATE SET provider = EXCLUDED.provider, sync_status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP
       RETURNING id, booking_id, calendar_scope, driver_id, provider, external_event_id`,
      [id, booking.id, provider]
    )
    : await query<StoredCalendarEvent>(
      `INSERT INTO booking_calendar_events (id, booking_id, calendar_scope, driver_id, provider)
       VALUES ($1,$2,'driver',$3,$4)
       ON CONFLICT (booking_id, driver_id) WHERE calendar_scope = 'driver'
       DO UPDATE SET provider = EXCLUDED.provider, sync_status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP
       RETURNING id, booking_id, calendar_scope, driver_id, provider, external_event_id`,
      [id, booking.id, driverId, provider]
    );
  if (!result.rows[0]) throw new Error(`Could not persist calendar event mapping for booking ${booking.id}.`);
  return result.rows[0];
}

async function syncOneEvent(booking: BookingCalendarEvent, scope: "dispatch" | "driver", driverId: string | null, provider: CalendarProvider, accessToken: string): Promise<void> {
  const stored = await upsertStoredEvent(booking, scope, driverId, provider);
  try {
    const externalId = await calendarApiRequest(
      provider, accessToken, stored.external_event_id, stored.external_event_id ? "PATCH" : "POST",
      calendarPayload(booking), scope
    );
    await query(
      `UPDATE booking_calendar_events
          SET external_event_id = $2, sync_status = 'synced', last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [stored.id, externalId]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown calendar synchronization failure.";
    await query(
      `UPDATE booking_calendar_events
          SET sync_status = 'failed', last_error = $2, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [stored.id, message.slice(0, 1000)]
    );
    throw error;
  }
}

async function deleteStoredEvent(event: StoredCalendarEvent, accessToken: string): Promise<void> {
  if (event.external_event_id) {
    await calendarApiRequest(event.provider, accessToken, event.external_event_id, "DELETE", undefined, event.calendar_scope);
  }
  await query(
    `UPDATE booking_calendar_events
        SET sync_status = 'deleted', external_event_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [event.id]
  );
}

export async function syncBookingCalendars(limit = 250): Promise<number> {
  const bookings = await query<BookingCalendarEvent>(
    `SELECT id, id AS booking_id, reference, status, archived_at, driver_id,
            service_date, service_time, service_timezone, pickup, dropoff
       FROM customer_bookings
      WHERE service_date::date >= CURRENT_DATE - 1
      ORDER BY service_date, service_time, id
      LIMIT $1`,
    [limit]
  );
  const dispatchTokenReady = Boolean(
    String(process.env.M365_TENANT_ID ?? "").trim() &&
    String(process.env.M365_CLIENT_ID ?? "").trim() &&
    String(process.env.M365_CLIENT_SECRET ?? "").trim() &&
    String(process.env.M365_CALENDAR_USER ?? "").trim() &&
    String(process.env.M365_CALENDAR_ID ?? "").trim()
  );
  let synced = 0;
  for (const booking of bookings.rows) {
    const active = !booking.archived_at && !["Cancelled", "Completed", "No Show"].includes(booking.status);
    if (dispatchTokenReady) {
      if (active) {
        try {
          await syncOneEvent(booking, "dispatch", null, "microsoft", await getMicrosoftApplicationToken());
          synced += 1;
        } catch (error) {
          await recordBookingIntegrationAlert({
            bookingId: booking.id,
            alertType: "dispatch-calendar-sync-failed",
            details: { message: error instanceof Error ? error.message : "Unknown calendar error." }
          });
        }
      } else {
        const existing = await query<StoredCalendarEvent>(
          `SELECT id, booking_id, calendar_scope, driver_id, provider, external_event_id
             FROM booking_calendar_events WHERE booking_id = $1 AND calendar_scope = 'dispatch' AND sync_status <> 'deleted'`,
          [booking.id]
        );
        for (const event of existing.rows) {
          try {
            await deleteStoredEvent(event, await getMicrosoftApplicationToken());
          } catch (error) {
            await query(`UPDATE booking_calendar_events SET sync_status = 'failed', last_error = $2 WHERE id = $1`,
              [event.id, (error instanceof Error ? error.message : "Calendar deletion failed.").slice(0, 1000)]);
          }
        }
      }
    }

    const oldDriverEvents = await query<StoredCalendarEvent>(
      `SELECT id, booking_id, calendar_scope, driver_id, provider, external_event_id
         FROM booking_calendar_events
        WHERE booking_id = $1 AND calendar_scope = 'driver' AND sync_status <> 'deleted'
          AND (driver_id IS DISTINCT FROM $2 OR NOT $3)`,
      [booking.id, active ? booking.driver_id : null, Boolean(active && booking.driver_id)]
    );
    for (const event of oldDriverEvents.rows) {
      try {
        const token = await refreshDriverToken(event.driver_id || "");
        await deleteStoredEvent(event, token.accessToken);
      } catch (error) {
        await query(`UPDATE booking_calendar_events SET sync_status = 'failed', last_error = $2 WHERE id = $1`,
          [event.id, (error instanceof Error ? error.message : "Calendar deletion failed.").slice(0, 1000)]);
      }
    }
    if (active && booking.driver_id) {
      const connection = await query<{ provider: CalendarProvider }>(
        "SELECT provider FROM driver_calendar_connections WHERE driver_id = $1",
        [booking.driver_id]
      );
      if (connection.rows[0]) {
        try {
          const token = await refreshDriverToken(booking.driver_id);
          await syncOneEvent(booking, "driver", booking.driver_id, token.provider, token.accessToken);
          synced += 1;
        } catch (error) {
          await recordBookingIntegrationAlert({
            bookingId: booking.id,
            alertType: "driver-calendar-sync-failed",
            details: { message: error instanceof Error ? error.message : "Unknown calendar error." }
          });
        }
      }
    }
  }
  return synced;
}

export function calendarOAuthProvider(value: string): CalendarProvider {
  return providerValue(value);
}
