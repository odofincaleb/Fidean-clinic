-- Pharmacy phase: widen prescriptions.status to allow dispensing states.
ALTER TABLE prescriptions DROP CONSTRAINT IF EXISTS prescriptions_status_check;
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'issued'::text, 'partially_dispensed'::text, 'dispensed'::text, 'cancelled'::text]));
