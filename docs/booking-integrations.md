# Automated booking integrations

The application stores integration work durably in PostgreSQL. Run
`npm run bookings:integrations` from the application directory once per minute
with the production environment loaded. The job schedules payment links and
24-hour reminders, reconciles payment deadlines directly against Stripe,
synchronizes calendars, and delivers due outbox messages. It is safe to run on
more than one worker: Stripe requests use idempotency keys, outbox records are
unique, and message claims use PostgreSQL row locks.

## Stripe payments

Configure `APP_BASE_URL` and `STRIPE_CONFIG_ENCRYPTION_KEY` in the server
environment. Generate the encryption key with `openssl rand -base64 32` and
keep it stable: Stripe credentials saved in Settings cannot be decrypted if
this key is lost or replaced. Enter test/live publishable keys, secret keys,
and webhook signing secrets at Settings → Payments → Stripe. In Stripe
Dashboard, create a webhook endpoint at
`https://<APP_BASE_URL>/webhooks/stripe` for
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, and
`checkout.session.expired`, then paste its signing secret into the matching
mode in Settings. Test the connection before enabling payments; start in test
mode. Secret values are encrypted at rest and are never displayed again.
Disable Stripe and resolve outstanding payment sessions before changing mode or
credentials. Webhook signature verification uses the raw request body; do not
proxy this endpoint through a body-transforming middleware.

The payment link is generated from the saved GBP booking total after driver
assignment, due at pickup minus 24 hours (or immediately if that time has
passed). The payment deadline is pickup minus three hours. At the deadline the
job retrieves the Checkout Session from Stripe and expires an unpaid open
session before cancelling the booking. Bookings assigned less than three hours
before pickup have no automatic cancellation deadline.

## Email and WhatsApp

Set `SES_SMTP_HOST`, `SES_SMTP_PORT`, `SES_SMTP_USERNAME`,
`SES_SMTP_PASSWORD`, and `SES_FROM_EMAIL` for Amazon SES SMTP. Development can
use Mailpit by setting the same variables to the local SMTP endpoint.
Email delivery is switched on separately in Settings → Messaging → Email.
Payment link, payment confirmation, and non-payment cancellation messages use
editable plain-text templates at Settings → Messaging → Email → Templates.
Email delivery remains queued while the global email switch is off.

Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_API_VERSION`
in the server environment only; they are never shown in the UI or logs. Approved
Meta template names and languages are configured per event in Settings →
Messaging → WhatsApp → Booking Notifications. Each notification is disabled by
default, and a disabled or unconfigured event never sends. Template text is
managed in WhatsApp Manager. Template body parameters are passed in this order:

- Booking received, under availability review, accepted, customer reminder:
  booking reference, local service date/time, pickup, destination.
- Driver reminder: booking reference, local service date/time, pickup.
- Driver status update: booking reference, status.

Lifecycle WhatsApp messages go only to the lead passenger, and each status sends
at most once per booking. WhatsApp is only queued when the contact has explicitly
opted in. Missing consent or contact details create a booking integration alert
and do not block the booking or driver assignment. Email reminders go to the lead passenger and,
when requested, the booking manager unless the manager is also the lead
passenger.

## Calendars

The shared dispatch calendar uses Microsoft Graph application credentials:
`M365_TENANT_ID`, `M365_CLIENT_ID`, `M365_CLIENT_SECRET`,
`M365_CALENDAR_USER`, and `M365_CALENDAR_ID`. Grant the app the required
calendar write permission and admin consent. It must be authorized to access the
configured mailbox and calendar.

Driver OAuth uses `M365_DRIVER_CLIENT_ID` / `M365_DRIVER_CLIENT_SECRET` and
`GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET`. Register the
callback URLs `https://<APP_BASE_URL>/driver/calendar/callback/microsoft` and
`https://<APP_BASE_URL>/driver/calendar/callback/google` with the respective
providers. The drivers connect or disconnect their own account from the driver
journey board. OAuth tokens are encrypted at rest; configure
`CALENDAR_TOKEN_ENCRYPTION_KEY` as base64 encoding of 32 random bytes (for
example, generate one with `openssl rand -base64 32`).

Calendar events are refreshed by the scheduled job. The current event window
uses the local service time and a one-hour event duration. Assignment changes
move the driver event; cancellation, completion, no-show, and archiving remove
active external events.

## Online booking advance notice

System Settings stores a 6-, 12-, or 24-hour minimum, defaulting to 12 hours.
The repository does not contain the public booking widget or its booking
creation endpoint. That external endpoint must call
`isOnlineBookingAllowed({ serviceDate, serviceTime })` before accepting an
online booking; the setting does not restrict dispatcher-created bookings.
