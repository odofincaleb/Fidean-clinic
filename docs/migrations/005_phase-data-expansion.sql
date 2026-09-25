-- Fidean Clinic SaaS v0.7.0 → v0.7.1
-- Phase: Data expansion — KiviCare parity for patient and staff fields
-- Applies to any existing clinic database.

-- 1. Add new columns to tenant_memberships
ALTER TABLE tenant_memberships
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS specialization text,
  ADD COLUMN IF NOT EXISTS qualifications text,
  ADD COLUMN IF NOT EXISTS license_number text;

-- 2. Add new columns to patients
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS alt_phone text,
  ADD COLUMN IF NOT EXISTS blood_group text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS medical_history text,
  ADD COLUMN IF NOT EXISTS dob date;

-- 3. Update schema version comment
COMMENT ON TABLE tenants IS 'Fidean Clinic SaaS v0.7.1 — data expansion';
