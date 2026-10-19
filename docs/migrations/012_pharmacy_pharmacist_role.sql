-- Pharmacy phase: add `pharmacist` role + backfill missing `store_manager` to the
-- clinic_role enum. Postgres ALTER TYPE ADD VALUE cannot run inside a transaction,
-- so each statement is idempotent and run ad-hoc (no wrapping BEGIN/COMMIT).
-- NOTE: added to the END of the enum to preserve existing sort order values.

-- store_manager was referenced by the app but missing from the DB enum (pre-existing
-- gap) — backfill it now that we are editing the same enum.
DO $$ BEGIN
  ALTER TYPE clinic_role ADD VALUE IF NOT EXISTS 'store_manager';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE clinic_role ADD VALUE IF NOT EXISTS 'pharmacist';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;