-- Phase 3C additive columns for existing databases.
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS activation_token_expires_at timestamptz;
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS activation_token_used_at timestamptz;
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS password_reset_token_hash text;
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS password_reset_token_expires_at timestamptz;
ALTER TABLE patient_accounts ADD COLUMN IF NOT EXISTS password_reset_token_used_at timestamptz;

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_patient_account_id uuid REFERENCES patient_accounts(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type text;

ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE notification_jobs ADD COLUMN IF NOT EXISTS provider_message_id text;
