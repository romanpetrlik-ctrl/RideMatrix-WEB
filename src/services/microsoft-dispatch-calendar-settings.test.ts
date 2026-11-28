import assert from "node:assert/strict";
import test from "node:test";
import {
  checkMicrosoftDispatchCalendarAccess,
  type MicrosoftDispatchCalendarCredentials
} from "./microsoft-dispatch-calendar-settings";

const credentials: MicrosoftDispatchCalendarCredentials = {
  tenantId: "tenant.example",
  clientId: "client-id",
  clientSecret: "client-secret-value",
  calendarUser: "dispatch+test@example.test",
  calendarId: "calendar/id"
};

test("Microsoft dispatch calendar access test obtains an app token and checks the selected calendar", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("/oauth2/v2.0/token")) {
      return Response.json({ access_token: "app-token", expires_in: 3600 });
    }
    return new Response("", { status: 200 });
  };

  await checkMicrosoftDispatchCalendarAccess(credentials, fetcher);

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /tenant\.example\/oauth2\/v2\.0\/token$/);
  assert.equal(requests[0].init?.method, "POST");
  assert.match(String(requests[0].init?.body), /grant_type=client_credentials/);
  assert.match(String(requests[0].init?.body), /client_secret=client-secret-value/);
  assert.match(requests[1].url, /users\/dispatch%2Btest%40example\.test\/calendars\/calendar%2Fid\?\$select=id,name$/);
  assert.deepEqual(requests[1].init?.headers, { authorization: "Bearer app-token" });
});

test("Microsoft token rejection reports a safe status without provider response contents", async () => {
  const fetcher: typeof fetch = async () => new Response("sensitive provider details", { status: 401 });
  await assert.rejects(
    () => checkMicrosoftDispatchCalendarAccess(credentials, fetcher),
    (error: Error) => {
      assert.equal(error.message, "Microsoft rejected the calendar application credentials (HTTP 401).");
      assert.doesNotMatch(error.message, /sensitive provider details|client-secret-value/);
      return true;
    }
  );
});

test("Microsoft Graph permission failures do not expose response bodies", async () => {
  const fetcher: typeof fetch = async (input) => String(input).includes("/oauth2/v2.0/token")
    ? Response.json({ access_token: "app-token", expires_in: 3600 })
    : new Response("sensitive Graph response", { status: 403 });
  await assert.rejects(
    () => checkMicrosoftDispatchCalendarAccess(credentials, fetcher),
    (error: Error) => {
      assert.equal(error.message, "Microsoft Graph could not access the configured calendar (HTTP 403).");
      assert.doesNotMatch(error.message, /sensitive Graph response|app-token/);
      return true;
    }
  );
});

test("Microsoft dispatch calendar credentials reject missing fields before network access", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => {
    called = true;
    return Response.json({});
  };
  await assert.rejects(
    () => checkMicrosoftDispatchCalendarAccess({ ...credentials, calendarId: "" }, fetcher),
    /Enter all Microsoft calendar credentials/
  );
  assert.equal(called, false);
});
