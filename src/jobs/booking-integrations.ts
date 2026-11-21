import dotenv from "dotenv";
import { closeDatabase } from "../database/connection";
import {
  reconcileBookingPaymentDeadlines,
  scheduleBookingReminders,
  scheduleDueBookingPaymentLinks
} from "../services/booking-automation";
import { deliverPendingBookingMessages } from "../services/booking-delivery";
import { syncBookingCalendars } from "../services/booking-calendars";

dotenv.config();

async function run(): Promise<void> {
  try {
    const paymentLinks = await scheduleDueBookingPaymentLinks();
    const cancelledBookings = await reconcileBookingPaymentDeadlines();
    const reminders = await scheduleBookingReminders();
    const calendarEvents = await syncBookingCalendars();
    const deliveredMessages = await deliverPendingBookingMessages();
    console.log(`[booking-integrations] Payment links: ${paymentLinks}; cancelled: ${cancelledBookings}; reminders queued: ${reminders}; calendar events synced: ${calendarEvents}; messages delivered: ${deliveredMessages}.`);
  } finally {
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error("[booking-integrations] Job failed:", error);
  process.exit(1);
});
