import {
  CUSTOMER_PER_PAGE_OPTIONS,
  CustomerRecord,
  deleteCustomer,
  listCustomers
} from "./customers";

export type CleanupResult = {
  processed: number;
  deleted: number;
  errors: number;
};

/**
 * Returns true if a customer is considered inactive:
 * - last_booking_at IS NULL and account created > thresholdMonths ago, OR
 * - last_booking_at is > thresholdMonths ago
 */
function getLatestBookingAt(customer: CustomerRecord): string | null {
  return customer.bookings.reduce<string | null>(
    (latest, booking) => (!latest || booking.serviceDate > latest ? booking.serviceDate : latest),
    customer.lastBookingAt
  );
}

function isInactive(customer: CustomerRecord, thresholdMonths: number): boolean {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - thresholdMonths);

  const latestBookingAt = getLatestBookingAt(customer);

  if (latestBookingAt) {
    return new Date(latestBookingAt) < cutoff;
  }

  return new Date(customer.createdAt) < cutoff;
}

export function findInactiveCustomers(monthsThreshold: number = 12): CustomerRecord[] {
  const allCustomers: CustomerRecord[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const result = listCustomers({
      search: "",
      status: "all",
      page,
      perPage: CUSTOMER_PER_PAGE_OPTIONS[CUSTOMER_PER_PAGE_OPTIONS.length - 1]
    });

    allCustomers.push(...result.customers);
    totalPages = result.totalPages;
    page += 1;
  } while (page <= totalPages);

  return allCustomers.filter((customer) => isInactive(customer, monthsThreshold));
}

function formatInactivityNotificationEmail(customer: CustomerRecord): string {
  const lastBooking = customer.lastBookingAt
    ? new Date(customer.lastBookingAt).toLocaleDateString("en-GB", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
    : "No bookings on record";

  return [
    `Subject: Notice of Account Deletion — RideMatrix`,
    ``,
    `Dear Customer,`,
    ``,
    `This is a formal notice that your RideMatrix account (${customer.email}) is scheduled`,
    `for deletion due to inactivity, in accordance with our Terms & Conditions.`,
    ``,
    `Last booking date: ${lastBooking}`,
    `Account created: ${new Date(customer.createdAt).toLocaleDateString("en-GB", {
      year: "numeric",
      month: "long",
      day: "numeric"
    })}`,
    ``,
    `Your booking history will be retained for legal and compliance purposes,`,
    `but your customer profile will be removed from our systems.`,
    ``,
    `If you have any questions, please contact support.`,
    ``,
    `— The RideMatrix Team`
  ].join("\n");
}

async function sendInactivityNotificationEmail(customer: CustomerRecord): Promise<void> {
  if (!customer.email) {
    console.warn(`[inactivity-cleanup] Skipping email for customer ${customer.id}: no email address.`);
    return;
  }

  const emailBody = formatInactivityNotificationEmail(customer);

  // Email sending is delegated to the backend service.
  // In production, integrate with your email provider here.
  console.log(
    `[inactivity-cleanup] Sending inactivity notification to ${customer.email}:\n${emailBody}`
  );
}

function archiveCustomerBookings(customer: CustomerRecord): void {
  if (customer.bookings.length === 0) {
    return;
  }

  const archive = {
    customerId: customer.id,
    customerEmail: customer.email,
    archivedAt: new Date().toISOString(),
    reason: "customer_deletion",
    bookings: customer.bookings
  };

  // In production, persist this to an archived_bookings table or S3.
  console.log(
    `[inactivity-cleanup] Archived ${customer.bookings.length} bookings for customer ${customer.id}: ${JSON.stringify(archive)}`
  );
}

export async function detectAndCleanupInactiveCustomers(
  monthsThreshold: number = 12
): Promise<CleanupResult> {
  const result: CleanupResult = { processed: 0, deleted: 0, errors: 0 };

  const inactiveCustomers = findInactiveCustomers(monthsThreshold);
  console.log(`[inactivity-cleanup] Found ${inactiveCustomers.length} inactive customer(s).`);

  for (const customer of inactiveCustomers) {
    result.processed++;

    try {
      await sendInactivityNotificationEmail(customer);
    } catch (err) {
      console.error(`[inactivity-cleanup] Failed to send email to ${customer.email}:`, err);
      result.errors++;
    }

    try {
      archiveCustomerBookings(customer);
    } catch (err) {
      console.error(`[inactivity-cleanup] Failed to archive bookings for ${customer.id}:`, err);
      result.errors++;
    }

    const deleted = deleteCustomer(customer.id);
    if (deleted) {
      result.deleted++;
      console.log(`[inactivity-cleanup] Deleted customer ${customer.id} (${customer.email}).`);
    } else {
      console.warn(`[inactivity-cleanup] Could not delete customer ${customer.id}.`);
      result.errors++;
    }
  }

  console.log(
    `[inactivity-cleanup] Run complete. Processed: ${result.processed}, Deleted: ${result.deleted}, Errors: ${result.errors}`
  );

  return result;
}
