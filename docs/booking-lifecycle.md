# Booking lifecycle

Booking workflow status, live journey status, driver availability, and payment status are separate:

- Workflow: `New` → `Under availability review` → `Accepted` → `Driver assigned` → `Completed`; cancellation and no-show are terminal. Assigning a driver records `Driver assigned`; removing the driver returns the booking to `Accepted`.
- Live journey: the assigned driver updates progress in the mobile-friendly `/driver` workspace. The server validates each transition and records an append-only event in `booking_live_status_audit`.
- Availability: the driver board can set a five-minute online lease, renewed while the page remains open. This is separate from any booking's live status.
- Payment: `payment_status` and `payment_due_at` are independent of workflow and live status. Assignment schedules the payment due time for 24 hours before pickup, or immediately when less than 24 hours remain.

At airport pickups, the `Arrived at pickup` event snapshots the configured deferred and fee-covered minutes into its audit details. The driver board shows that allowance and arrival time; it does not calculate or charge waiting-time fees.

Live-status recipients are written to `booking_status_notification_outbox`: the lead passenger receives the first three journey updates, and the booking manager receives updates only when selected on the booking form. The outbox remains `pending_provider`; this project does not send email or SMS. Likewise, payment-link delivery and payment capture require a separately selected provider and are not implemented here.

Superusers can edit the operational row tint and live-status right-side strip at `/bookings/status-colors`. Color changes are validated as six-digit hexadecimal values and recorded in `booking_status_color_audit`.
