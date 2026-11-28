# Public customer booking

The public booking flow starts at `/public-booking`. A customer enters an email
address, follows a one-time verification link, reviews the details prefilled from
an active customer profile (if one exists), then submits a booking after the
server calculates its price. The form never exposes the internal customer list
or staff session.

The API and WEB must use the same PostgreSQL database. Set
`PUBLIC_BOOKING_BASE_URL` in the API environment to the public WEB origin, for
example `https://bookings.example.com`; if it is omitted, verification links
use `APP_BASE_URL`. Email verification requires the API SMTP delivery settings.
Booking-received and new-customer welcome messages are placed in WEB's existing
booking delivery outbox and require Email messaging to be enabled and tested in
Settings → Messaging → Email.

The final booking creates an active customer profile and, when needed, a user
account with the `customer` role in the same transaction. The booking starts in
`New`, and the customer confirmation states that availability is being checked.
Public session tokens are short-lived and separate from the staff `rm_session`
cookie.
