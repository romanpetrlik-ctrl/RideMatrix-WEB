import { createCustomer, getCustomerByEmail } from "./customers";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type GetOrCreateCustomerResult = {
  customerId: string;
  isNew: boolean;
};

/**
 * Returns an existing customer for the given email, or creates a new one.
 * Email is normalized (lowercased, trimmed) before lookup/insert.
 */
export async function getOrCreateCustomer(
  email: string,
  fullName?: string | null,
  phone?: string | null
): Promise<GetOrCreateCustomerResult> {
  const normalizedEmail = normalizeEmail(email);

  const existing = await getCustomerByEmail(normalizedEmail);
  if (existing) {
    return { customerId: existing.id, isNew: false };
  }

  let givenName = "Guest";
  let surname = "Customer";

  if (fullName) {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      givenName = parts.slice(0, -1).join(" ");
      surname = parts[parts.length - 1];
    } else if (parts.length === 1 && parts[0]) {
      givenName = parts[0];
      surname = "";
    }
  }

  const newCustomer = await createCustomer({
    givenName,
    surname,
    email: normalizedEmail,
    phone: phone ?? null,
    status: "Active",
    // Distinct origin marker so booking-driven records can be told apart from
    // manually registered customers, Cabcher imports ("import") and demo seed
    // data ("seed") — see docs/customer-persistence.md.
    source: "booking"
  });

  console.log(`[customer-auto-creation] Created customer ${newCustomer.id} for email ${normalizedEmail}`);

  return { customerId: newCustomer.id, isNew: true };
}
