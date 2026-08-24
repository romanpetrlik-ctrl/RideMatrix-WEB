-- Phase 0: Customer auto-creation on booking + inactivity cleanup schema

-- Extend customers table with columns required for Phase 0
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_booking_at TIMESTAMP NULL;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS notes TEXT NULL;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_last_booking_at ON customers(last_booking_at);

-- Extend bookings table with customer_id link (if not already present)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS last_booking_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_bookings_customer_id ON bookings(customer_id);

-- Optional: archived bookings table for compliance retention on customer deletion
CREATE TABLE IF NOT EXISTS archived_bookings (
  id TEXT PRIMARY KEY,
  customer_email TEXT NOT NULL,
  customer_id TEXT,
  booking_id TEXT NOT NULL,
  booking_data TEXT, -- JSON snapshot of the booking
  archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  reason TEXT -- e.g. 'customer_deletion'
);
