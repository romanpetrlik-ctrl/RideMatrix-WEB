CREATE TABLE IF NOT EXISTS business_customers (
  customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  registered_name TEXT NOT NULL,
  registered_address JSONB NOT NULL CHECK (jsonb_typeof(registered_address) = 'object'),
  operational_address JSONB NOT NULL CHECK (jsonb_typeof(operational_address) = 'object'),
  office_phone TEXT NOT NULL,
  office_email TEXT NOT NULL,
  booker_full_name TEXT NOT NULL,
  booker_email TEXT NOT NULL,
  booker_phone TEXT NOT NULL,
  booking_auth_required BOOLEAN NOT NULL,
  booking_auth_channel TEXT,
  accounts_full_name TEXT NOT NULL CHECK (btrim(accounts_full_name) <> ''),
  accounts_email TEXT NOT NULL CHECK (btrim(accounts_email) <> ''),
  accounts_phone TEXT,
  CONSTRAINT business_customers_auth_channel_check CHECK (
    (booking_auth_required = FALSE AND booking_auth_channel IS NULL)
    OR (booking_auth_required = TRUE AND booking_auth_channel IS NOT NULL
      AND booking_auth_channel IN ('email', 'whatsapp', 'both'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_bookings_customer_id_id
  ON customer_bookings (customer_id, id);

CREATE TABLE IF NOT EXISTS booking_authorization_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES business_customers(customer_id) ON DELETE CASCADE,
  booking_id TEXT NOT NULL REFERENCES customer_bookings(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_channel TEXT CHECK (decided_by_channel IN ('email', 'whatsapp')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_authorization_requests_customer_booking_fk
    FOREIGN KEY (customer_id, booking_id) REFERENCES customer_bookings(customer_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booking_authorization_requests_customer_id
  ON booking_authorization_requests (customer_id);
CREATE INDEX IF NOT EXISTS idx_booking_authorization_requests_booking_id
  ON booking_authorization_requests (booking_id);
