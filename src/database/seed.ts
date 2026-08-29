import type { Database } from "better-sqlite3";

const SEED_KEY = "customers_seed_v1";

type SeedBooking = {
  id: string;
  reference: string;
  serviceDate: string;
  pickup: string;
  dropoff: string;
  status: "Scheduled" | "Completed" | "Cancelled";
};

type SeedCustomer = {
  id: string;
  givenName: string;
  surname: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  lastBookingAt: string | null;
  status: "Active" | "Suspended" | "Pending" | "Delete Pending";
  notes: string | null;
  address: string | null;
  company: string | null;
  preferredContact: "WhatsApp" | "Email" | "Phone" | "Unknown";
  bookings: SeedBooking[];
};

export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    id: "cust-001",
    givenName: "Lina",
    surname: "Adams",
    email: "lina.adams@example.com",
    phone: "+44 7700 900101",
    createdAt: "2024-01-12T09:30:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-29T11:45:00Z",
    status: "Active",
    notes: "Prefers airport pickup confirmations on WhatsApp.",
    address: "12 Station Road, Manchester",
    company: "Aster Logistics",
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1001",
        reference: "RM-1001",
        serviceDate: "2026-08-01T08:15:00Z",
        pickup: "Manchester Piccadilly",
        dropoff: "MAN Terminal 2",
        status: "Scheduled"
      },
      {
        id: "book-1002",
        reference: "RM-0951",
        serviceDate: "2026-07-16T18:20:00Z",
        pickup: "Salford Quays",
        dropoff: "Manchester Victoria",
        status: "Completed"
      }
    ]
  },
  {
    id: "cust-002",
    givenName: "George",
    surname: "Baker",
    email: "george.baker@example.com",
    phone: "+44 7700 900102",
    createdAt: "2023-11-05T13:10:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-25T07:20:00Z",
    status: "Active",
    notes: null,
    address: "4 King Street, Leeds",
    company: null,
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1003",
        reference: "RM-1003",
        serviceDate: "2026-08-03T14:00:00Z",
        pickup: "Leeds Station",
        dropoff: "Leeds Bradford Airport",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-003",
    givenName: "Noah",
    surname: "Bennett",
    email: null,
    phone: "+44 7700 900103",
    createdAt: "2025-02-18T15:55:00Z",
    lastBookingAt: null,
    lastLoginAt: null,
    status: "Pending",
    notes: "Awaiting email confirmation.",
    address: null,
    company: null,
    preferredContact: "Phone",
    bookings: []
  },
  {
    id: "cust-004",
    givenName: "Emma",
    surname: "Clark",
    email: "emma.clark@example.com",
    phone: null,
    createdAt: "2024-03-09T10:05:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-06-14T16:10:00Z",
    status: "Suspended",
    notes: "Temporarily suspended while chargeback review is open.",
    address: "88 Riverside Drive, York",
    company: "Clark & Co",
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1004",
        reference: "RM-1004",
        serviceDate: "2026-06-01T09:00:00Z",
        pickup: "York Station",
        dropoff: "The Grand York",
        status: "Cancelled"
      }
    ]
  },
  {
    id: "cust-005",
    givenName: "Isla",
    surname: "Dawson",
    email: "isla.dawson@example.com",
    phone: "+44 7700 900105",
    createdAt: "2025-07-11T12:00:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-30T20:15:00Z",
    status: "Active",
    notes: null,
    address: "25 Prince Street, Liverpool",
    company: null,
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1005",
        reference: "RM-1005",
        serviceDate: "2026-08-05T06:45:00Z",
        pickup: "Liverpool Lime Street",
        dropoff: "LPL Departures",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-006",
    givenName: "Mason",
    surname: "Evans",
    email: "mason.evans@example.com",
    phone: "+44 7700 900106",
    createdAt: "2024-08-20T08:40:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-17T12:05:00Z",
    status: "Delete Pending",
    notes: "Customer requested record removal after final invoice.",
    address: "102 High Street, Bristol",
    company: null,
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1006",
        reference: "RM-1006",
        serviceDate: "2026-07-02T11:30:00Z",
        pickup: "Temple Meads",
        dropoff: "Bristol Harbourside",
        status: "Completed"
      }
    ]
  },
  {
    id: "cust-007",
    givenName: "Amelia",
    surname: "Fisher",
    email: "amelia.fisher@example.com",
    phone: "+44 7700 900107",
    createdAt: "2024-05-15T17:22:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-01T19:10:00Z",
    status: "Active",
    notes: "VIP account with monthly invoicing.",
    address: "5 Queen Square, Bath",
    company: "Fisher Events",
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1007",
        reference: "RM-1007",
        serviceDate: "2026-08-08T09:30:00Z",
        pickup: "Bath Spa",
        dropoff: "Bristol Airport",
        status: "Scheduled"
      },
      {
        id: "book-1008",
        reference: "RM-0988",
        serviceDate: "2026-07-08T09:30:00Z",
        pickup: "Bath Spa",
        dropoff: "Bristol Airport",
        status: "Completed"
      }
    ]
  },
  {
    id: "cust-008",
    givenName: "Oliver",
    surname: "Green",
    email: "oliver.green@example.com",
    phone: "+44 7700 900108",
    createdAt: "2023-09-03T11:14:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-04-22T09:45:00Z",
    status: "Suspended",
    notes: null,
    address: "17 Elm Court, Sheffield",
    company: null,
    preferredContact: "Phone",
    bookings: []
  },
  {
    id: "cust-009",
    givenName: "Sophia",
    surname: "Hall",
    email: "sophia.hall@example.com",
    phone: "+44 7700 900109",
    createdAt: "2024-10-01T14:12:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-30T05:40:00Z",
    status: "Active",
    notes: null,
    address: "2 Wellington Terrace, Newcastle",
    company: "Hall Design",
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1009",
        reference: "RM-1009",
        serviceDate: "2026-08-09T16:40:00Z",
        pickup: "Newcastle Central",
        dropoff: "NE1 Business Quarter",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-010",
    givenName: "Ethan",
    surname: "Irwin",
    email: null,
    phone: null,
    createdAt: "2026-01-21T07:55:00Z",
    lastBookingAt: null,
    lastLoginAt: null,
    status: "Pending",
    notes: "Lead imported from concierge partner.",
    address: null,
    company: "North Concierge",
    preferredContact: "Unknown",
    bookings: []
  },
  {
    id: "cust-011",
    givenName: "Harper",
    surname: "Johnson",
    email: "harper.johnson@example.com",
    phone: "+44 7700 900111",
    createdAt: "2024-02-27T16:45:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-05-10T13:20:00Z",
    status: "Active",
    notes: "Requires child seat requests to be flagged manually.",
    address: "61 Castle Street, Edinburgh",
    company: null,
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1010",
        reference: "RM-1010",
        serviceDate: "2026-08-10T08:00:00Z",
        pickup: "Edinburgh Waverley",
        dropoff: "EDI Airport",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-012",
    givenName: "Jack",
    surname: "King",
    email: "jack.king@example.com",
    phone: "+44 7700 900112",
    createdAt: "2023-12-11T10:22:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-11T08:22:00Z",
    status: "Delete Pending",
    notes: null,
    address: "9 Market Lane, Nottingham",
    company: null,
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1011",
        reference: "RM-1011",
        serviceDate: "2026-06-20T15:15:00Z",
        pickup: "Nottingham Station",
        dropoff: "East Midlands Airport",
        status: "Completed"
      }
    ]
  },
  {
    id: "cust-013",
    givenName: "Ella",
    surname: "Lewis",
    email: "ella.lewis@example.com",
    phone: "+44 7700 900113",
    createdAt: "2024-07-02T09:05:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-28T09:55:00Z",
    status: "Active",
    notes: "Frequent early-morning rail station transfers.",
    address: "44 Broad Street, Birmingham",
    company: "Lewis Retail",
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1012",
        reference: "RM-1012",
        serviceDate: "2026-08-12T05:55:00Z",
        pickup: "Birmingham New Street",
        dropoff: "BHX Airport",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-014",
    givenName: "Leo",
    surname: "Mitchell",
    email: "leo.mitchell@example.com",
    phone: "+44 7700 900114",
    createdAt: "2025-04-19T18:40:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-24T21:00:00Z",
    status: "Active",
    notes: null,
    address: "3 Pier View, Brighton",
    company: null,
    preferredContact: "Phone",
    bookings: []
  },
  {
    id: "cust-015",
    givenName: "Mia",
    surname: "Nolan",
    email: "mia.nolan@example.com",
    phone: "+44 7700 900115",
    createdAt: "2025-09-14T11:50:00Z",
    lastBookingAt: null,
    lastLoginAt: null,
    status: "Pending",
    notes: "Signup incomplete after quote request.",
    address: "72 Seaside Road, Portsmouth",
    company: null,
    preferredContact: "Email",
    bookings: []
  },
  {
    id: "cust-016",
    givenName: "James",
    surname: "Owens",
    email: "james.owens@example.com",
    phone: "+44 7700 900116",
    createdAt: "2024-06-23T13:33:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-20T10:18:00Z",
    status: "Suspended",
    notes: "Manual review required before reactivation.",
    address: "18 Old Town Road, Cardiff",
    company: "Owens Advisory",
    preferredContact: "Phone",
    bookings: [
      {
        id: "book-1013",
        reference: "RM-1013",
        serviceDate: "2026-05-18T09:10:00Z",
        pickup: "Cardiff Central",
        dropoff: "CF10 Bay",
        status: "Cancelled"
      }
    ]
  },
  {
    id: "cust-017",
    givenName: "Ava",
    surname: "Parker",
    email: "ava.parker@example.com",
    phone: "+44 7700 900117",
    createdAt: "2024-04-08T08:08:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-31T06:50:00Z",
    status: "Active",
    notes: "Often books return journeys in the same session.",
    address: "11 Regent Place, Oxford",
    company: null,
    preferredContact: "WhatsApp",
    bookings: [
      {
        id: "book-1014",
        reference: "RM-1014",
        serviceDate: "2026-08-14T12:20:00Z",
        pickup: "Oxford Parkway",
        dropoff: "Heathrow Terminal 5",
        status: "Scheduled"
      }
    ]
  },
  {
    id: "cust-018",
    givenName: "Lucas",
    surname: "Quinn",
    email: "lucas.quinn@example.com",
    phone: "+44 7700 900118",
    createdAt: "2025-06-28T15:05:00Z",
    lastBookingAt: null,
    lastLoginAt: "2026-07-18T14:15:00Z",
    status: "Active",
    notes: null,
    address: "1 Park Avenue, Cambridge",
    company: "Quinn Labs",
    preferredContact: "Email",
    bookings: [
      {
        id: "book-1015",
        reference: "RM-1015",
        serviceDate: "2026-08-18T17:10:00Z",
        pickup: "Cambridge North",
        dropoff: "Stansted Airport",
        status: "Scheduled"
      }
    ]
  }
];

/**
 * Inserts the original demo customer records once, so the customer list keeps
 * its existing content on a fresh database. The marker in `bootstrap_state`
 * makes the seed idempotent: restarts never duplicate records and never
 * resurrect customers that an administrator has deleted.
 */
export function seedCustomers(database: Database): boolean {
  const alreadySeeded = database
    .prepare("SELECT key FROM bootstrap_state WHERE key = ?")
    .get(SEED_KEY);

  if (alreadySeeded) {
    return false;
  }

  const insertCustomer = database.prepare(`
    INSERT OR IGNORE INTO customers (
      id, title, given_name, surname, email, email_normalized, phone, company, address,
      house_name_number, address_line1, address_line2, address_line3,
      city_town, county, state, postcode,
      preferred_contact, notes, status, source,
      created_at, updated_at, last_login_at, last_booking_at, deleted_at
    ) VALUES (
      @id, NULL, @givenName, @surname, @email, @emailNormalized, @phone, @company, @address,
      NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      @preferredContact, @notes, @status, 'seed',
      @createdAt, @createdAt, @lastLoginAt, @lastBookingAt, NULL
    )
  `);

  const insertBooking = database.prepare(`
    INSERT OR IGNORE INTO customer_bookings (
      id, customer_id, reference, service_date, pickup, dropoff, status, created_at
    ) VALUES (@id, @customerId, @reference, @serviceDate, @pickup, @dropoff, @status, @createdAt)
  `);

  const apply = database.transaction(() => {
    for (const customer of SEED_CUSTOMERS) {
      insertCustomer.run({
        id: customer.id,
        givenName: customer.givenName,
        surname: customer.surname,
        email: customer.email,
        emailNormalized: customer.email ? customer.email.trim().toLowerCase() : null,
        phone: customer.phone,
        company: customer.company,
        address: customer.address,
        preferredContact: customer.preferredContact,
        notes: customer.notes,
        status: customer.status,
        createdAt: customer.createdAt,
        lastLoginAt: customer.lastLoginAt,
        lastBookingAt: customer.lastBookingAt
      });

      for (const booking of customer.bookings) {
        insertBooking.run({
          id: booking.id,
          customerId: customer.id,
          reference: booking.reference,
          serviceDate: booking.serviceDate,
          pickup: booking.pickup,
          dropoff: booking.dropoff,
          status: booking.status,
          createdAt: customer.createdAt
        });
      }
    }

    database
      .prepare("INSERT INTO bootstrap_state (key, applied_at) VALUES (?, ?)")
      .run(SEED_KEY, new Date().toISOString());
  });

  apply();

  return true;
}
