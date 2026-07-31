-- Phase 1 historical data ingestion schema (Cabcher cleaned bookings)

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL,
  total_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  full_name TEXT NOT NULL,
  given_name TEXT,
  surname TEXT,
  booking_count_total INTEGER NOT NULL DEFAULT 0,
  booking_count_past INTEGER NOT NULL DEFAULT 0,
  booking_count_upcoming INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT,
  next_booking_at TEXT,
  last_pickup_text TEXT,
  last_dropoff_text TEXT,
  preferred_vehicle_raw TEXT,
  last_payment_method_raw TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_reference_raw TEXT,
  source_account_raw TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  customer_name_raw TEXT NOT NULL,
  customer_given_name TEXT,
  customer_surname TEXT,
  service_date_time TEXT NOT NULL,
  pickup_text TEXT NOT NULL,
  dropoff_text TEXT NOT NULL,
  vehicle_class_raw TEXT,
  payment_method_raw TEXT,
  total_fare_amount REAL,
  currency TEXT,
  is_future INTEGER NOT NULL,
  inferred_temporal_status TEXT NOT NULL,
  customer_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_batch_id) REFERENCES import_batches (id),
  FOREIGN KEY (customer_id) REFERENCES customers (id)
);
