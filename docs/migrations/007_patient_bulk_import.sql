-- Phase 5: preserve clinic-assigned Patient IDs and support safe bulk onboarding imports.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS clinic_patient_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_tenant_clinic_patient_id
  ON patients(tenant_id, clinic_patient_id)
  WHERE clinic_patient_id IS NOT NULL AND clinic_patient_id <> '';

COMMENT ON COLUMN patients.clinic_patient_id IS 'Patient ID already assigned by the clinic/hospital before onboarding into Fidean Clinic SaaS.';
