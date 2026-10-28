import { getPool, withTransaction } from "../database/connection";
import { createCustomer, type CustomerRecord, updateCustomer } from "./customers";
import { normalizePhoneToE164 } from "./phone-numbers";

export type BusinessFormData = Record<string, string>;

export type BusinessAddress = {
  houseNameNumber: string;
  addressLine1: string;
  addressLine2: string;
  addressLine3: string;
  cityTown: string;
  postcode: string;
  county: string;
  state: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
};

export type BusinessCustomerInput = {
  registeredName: string;
  registeredAddress: BusinessAddress;
  operationalAddress: BusinessAddress;
  officePhone: string;
  officeEmail: string;
  bookerFullName: string;
  bookerEmail: string;
  bookerPhone: string;
  bookingAuthRequired: boolean;
  bookingAuthChannel: "email" | "whatsapp" | "both" | null;
  accountsFullName: string;
  accountsEmail: string;
  accountsPhone: string | null;
};

const ADDRESS_FIELDS = [
  "houseNameNumber", "addressLine1", "addressLine2", "addressLine3",
  "cityTown", "postcode", "county", "state", "country", "latitude", "longitude"
] as const;

const CONTACT_FIELDS = [
  "registeredName", "officePhone", "officeEmail", "bookerFullName", "bookerEmail",
  "bookerPhone", "bookingAuthRequired", "bookingAuthChannel",
  "accountsFullName", "accountsEmail", "accountsPhone"
] as const;

function addressFormKey(prefix: string, field: string): string {
  return prefix + field[0].toUpperCase() + field.slice(1);
}

function businessInputToFormData(input: BusinessCustomerInput): BusinessFormData {
  const form: BusinessFormData = {};
  for (const field of CONTACT_FIELDS) {
    form[field] = field === "bookingAuthRequired"
      ? (input[field] === true ? "yes" : input[field] === false ? "no" : "")
      : String(input[field] ?? "");
  }
  for (const prefix of ["registered", "operational"] as const) {
    for (const field of ADDRESS_FIELDS) {
      form[addressFormKey(prefix, field)] = String(input[`${prefix}Address`]?.[field] ?? "");
    }
  }
  return form;
}

function formatBusinessAddress(address: BusinessAddress): string {
  return [
    address.houseNameNumber, address.addressLine1, address.addressLine2, address.addressLine3,
    address.cityTown, address.county, address.state, address.postcode, address.country
  ].filter((part, index, parts) => part && parts.indexOf(part) === index).join(", ");
}

const ADDRESS_FIELD_LABELS: Record<string, string> = {
  houseNameNumber: "Building/unit name or number",
  addressLine1: "Address line 1",
  cityTown: "Town/City",
  postcode: "Postcode/ZIP",
  country: "Country",
  latitude: "Latitude",
  longitude: "Longitude"
};

export type BusinessFieldError = { field: string; message: string };

export function validateBusinessCustomer(input: unknown): {
  data: BusinessFormData;
  errors: string[];
  fieldErrors: BusinessFieldError[];
  input?: BusinessCustomerInput;
} {
  const source = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const errors: string[] = [];
  const fieldErrors: BusinessFieldError[] = [];
  const normalizedEmails: Record<string, string> = {};
  const normalizedPhones: Record<string, string> = {};
  const fail = (field: string, message: string) => {
    errors.push(message);
    fieldErrors.push({ field, message });
  };
  const data: BusinessFormData = {};
  const keys = [
    ...CONTACT_FIELDS,
    ...(["registered", "operational"] as const).flatMap((prefix) =>
      [...ADDRESS_FIELDS.map((field) => addressFormKey(prefix, field)), prefix + "AddressSearch", prefix + "Address"])
  ];
  for (const key of keys) {
    const value = source[key];
    data[key] = typeof value === "string" ? value.trim() : "";
    if (value !== undefined && value !== null && typeof value !== "string") {
      fail(key, `${key} must be a single text value.`);
    }
  }

  for (const [field, label] of [
    ["registeredName", "Registered business name"],
    ["officePhone", "Office phone"], ["officeEmail", "Office email"],
    ["bookerFullName", "Booker full name"], ["bookerEmail", "Booker email"],
    ["bookerPhone", "Booker phone"],
    ["accountsFullName", "Accounts full name"], ["accountsEmail", "Accounts email"]
  ]) {
    if (!data[field]) fail(field, `${label} is required.`);
  }

  for (const [field, label] of [
    ["officeEmail", "Office email"], ["bookerEmail", "Booker email"], ["accountsEmail", "Accounts email"]
  ]) {
    if (data[field] && (data[field].length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data[field]))) {
      fail(field, `${label} must be a valid email address.`);
    }
    normalizedEmails[field] = data[field].toLowerCase();
  }
  for (const [field, label] of [
    ["officePhone", "Office phone"], ["bookerPhone", "Booker phone"], ["accountsPhone", "Accounts phone"]
  ]) {
    if (!data[field]) continue;
    const normalized = normalizePhoneToE164(data[field]);
    if (normalized) normalizedPhones[field] = normalized;
    else fail(field, `${label} must be a valid phone number, for example +44 1202 353570 or 01202 353570.`);
  }

  function address(prefix: "registered" | "operational"): BusinessAddress {
    const label = prefix === "registered" ? "Registered address" : "Operational address";
    const hasData = ADDRESS_FIELDS.some((field) => data[addressFormKey(prefix, field)] !== "");
    if (prefix === "registered" || hasData) {
      const required = prefix === "registered"
        ? ["houseNameNumber", "addressLine1", "cityTown", "postcode", "country"]
        : ["addressLine1", "cityTown", "postcode", "country"];
      for (const field of required) {
        if (!data[addressFormKey(prefix, field)]) {
          fail(addressFormKey(prefix, field), `${label}: ${ADDRESS_FIELD_LABELS[field]} is required.`);
        }
      }
    }
    const latitudeText = data[addressFormKey(prefix, "latitude")];
    const longitudeText = data[addressFormKey(prefix, "longitude")];
    if (Boolean(latitudeText) !== Boolean(longitudeText)) {
      fail(addressFormKey(prefix, latitudeText ? "longitude" : "latitude"),
        `${label}: latitude and longitude must be provided together.`);
    }
    function coordinate(text: string, field: string, limit: number): number | null {
      if (!text) return null;
      // Decimal notation only: reject coercions such as hexadecimal and partial numbers.
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)
        || !Number.isFinite(Number(text)) || Math.abs(Number(text)) > limit) {
        fail(addressFormKey(prefix, field), `${label}: ${field} must be a finite number between -${limit} and ${limit}.`);
        return null;
      }
      return Number(text);
    }
    return {
      houseNameNumber: data[addressFormKey(prefix, "houseNameNumber")],
      addressLine1: data[addressFormKey(prefix, "addressLine1")],
      addressLine2: data[addressFormKey(prefix, "addressLine2")],
      addressLine3: data[addressFormKey(prefix, "addressLine3")],
      cityTown: data[addressFormKey(prefix, "cityTown")],
      postcode: data[addressFormKey(prefix, "postcode")],
      county: data[addressFormKey(prefix, "county")],
      state: data[addressFormKey(prefix, "state")],
      country: data[addressFormKey(prefix, "country")],
      latitude: coordinate(latitudeText, "latitude", 90),
      longitude: coordinate(longitudeText, "longitude", 180)
    };
  }
  const registeredAddress = address("registered");
  const operationalAddress = address("operational");
  if (data.bookingAuthRequired !== "yes" && data.bookingAuthRequired !== "no") {
    fail("bookingAuthRequired", "Booking authorization required must explicitly be yes or no.");
  }
  let bookingAuthChannel: BusinessCustomerInput["bookingAuthChannel"] = null;
  if (data.bookingAuthRequired === "yes") {
    const channel = data.bookingAuthChannel;
    if (channel === "email" || channel === "whatsapp" || channel === "both") bookingAuthChannel = channel;
    else fail("bookingAuthChannel", "Choose a booking authorization channel: email, whatsapp or both.");
  } else if (data.bookingAuthRequired === "no") {
    data.bookingAuthChannel = "";
  }
  if (errors.length) return { data, errors, fieldErrors };
  return {
    data, errors, fieldErrors,
    input: {
      registeredName: data.registeredName,
      registeredAddress, operationalAddress,
      officePhone: normalizedPhones.officePhone, officeEmail: normalizedEmails.officeEmail,
      bookerFullName: data.bookerFullName, bookerEmail: normalizedEmails.bookerEmail,
      bookerPhone: normalizedPhones.bookerPhone,
      bookingAuthRequired: data.bookingAuthRequired === "yes", bookingAuthChannel,
      accountsFullName: data.accountsFullName,
      accountsEmail: normalizedEmails.accountsEmail,
      accountsPhone: normalizedPhones.accountsPhone || null
    }
  };
}

export async function createBusinessCustomer(input: BusinessCustomerInput): Promise<CustomerRecord> {
  const validation = validateBusinessCustomer(businessInputToFormData(input));
  if (!validation.input) throw new Error(validation.errors.join(" "));
  const business = validation.input;
  return withTransaction(async (client) => {
    const address = business.registeredAddress;
    const customer = await createCustomer({
      givenName: business.registeredName, surname: "", company: business.registeredName,
      email: business.officeEmail, phone: business.officePhone,
      ...address,
      address: formatBusinessAddress(address),
      source: "business"
    }, client);
    await client.query(
      `INSERT INTO business_customers (
        customer_id, registered_name, registered_address, operational_address,
        office_phone, office_email, booker_full_name, booker_email, booker_phone,
        booking_auth_required, booking_auth_channel, accounts_full_name, accounts_email, accounts_phone
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        customer.id, business.registeredName, JSON.stringify(business.registeredAddress),
        JSON.stringify(business.operationalAddress), business.officePhone, business.officeEmail,
        business.bookerFullName, business.bookerEmail, business.bookerPhone,
        business.bookingAuthRequired, business.bookingAuthChannel,
        business.accountsFullName, business.accountsEmail, business.accountsPhone
      ]
    );
    return customer;
  });
}

export async function updateBusinessCustomer(
  customerId: string,
  input: BusinessCustomerInput
): Promise<CustomerRecord | undefined> {
  const validation = validateBusinessCustomer(businessInputToFormData(input));
  if (!validation.input) throw new Error(validation.errors.join(" "));
  const business = validation.input;

  return withTransaction(async (client) => {
    const address = business.registeredAddress;
    const customer = await updateCustomer(customerId, {
      givenName: business.registeredName,
      company: business.registeredName,
      email: business.officeEmail,
      phone: business.officePhone,
      ...address,
      address: formatBusinessAddress(address)
    }, client);
    if (!customer) return undefined;

    const result = await client.query(
      `UPDATE business_customers SET
        registered_name = $2, registered_address = $3::jsonb, operational_address = $4::jsonb,
        office_phone = $5, office_email = $6, booker_full_name = $7, booker_email = $8,
        booker_phone = $9, booking_auth_required = $10, booking_auth_channel = $11,
        accounts_full_name = $12, accounts_email = $13, accounts_phone = $14
       WHERE customer_id = $1`,
      [
        customerId, business.registeredName, JSON.stringify(business.registeredAddress),
        JSON.stringify(business.operationalAddress), business.officePhone, business.officeEmail,
        business.bookerFullName, business.bookerEmail, business.bookerPhone,
        business.bookingAuthRequired, business.bookingAuthChannel,
        business.accountsFullName, business.accountsEmail, business.accountsPhone
      ]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(`Business profile for customer ${customerId} could not be updated.`);
    }
    return customer;
  });
}

export async function getBusinessCustomer(customerId: string): Promise<BusinessCustomerInput | null> {
  const result = await getPool().query<{
    registered_name: string; registered_address: BusinessAddress; operational_address: BusinessAddress;
    office_phone: string; office_email: string; booker_full_name: string; booker_email: string; booker_phone: string;
    booking_auth_required: boolean; booking_auth_channel: BusinessCustomerInput["bookingAuthChannel"];
    accounts_full_name: string; accounts_email: string; accounts_phone: string | null;
  }>(
    `SELECT bc.* FROM business_customers bc
     JOIN customers c ON c.id = bc.customer_id
     WHERE bc.customer_id = $1 AND c.deleted_at IS NULL AND c.anonymized_at IS NULL`,
    [customerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    registeredName: row.registered_name,
    registeredAddress: row.registered_address, operationalAddress: row.operational_address,
    officePhone: row.office_phone, officeEmail: row.office_email,
    bookerFullName: row.booker_full_name, bookerEmail: row.booker_email, bookerPhone: row.booker_phone,
    bookingAuthRequired: row.booking_auth_required, bookingAuthChannel: row.booking_auth_channel,
    accountsFullName: row.accounts_full_name, accountsEmail: row.accounts_email, accountsPhone: row.accounts_phone
  };
}
