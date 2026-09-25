-- Fidean Clinic SaaS PostgreSQL draft schema v0.1.0
-- Apply in a fresh database only after review.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE clinic_role AS ENUM ('owner','admin','branch_manager','doctor','receptionist','nurse','accountant','viewer');
CREATE TYPE appointment_status AS ENUM ('requested','confirmed','checked_in','completed','cancelled','no_show');

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'trial',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text,
  phone text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext UNIQUE NOT NULL,
  display_name text,
  password_hash text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email citext NOT NULL,
  display_name text,
  role clinic_role NOT NULL,
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'invited',
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user_status ON tenant_memberships(user_id, status);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_code text NOT NULL,
  clinic_patient_id text,
  first_name text NOT NULL,
  last_name text,
  phone text NOT NULL,
  email citext,
  gender text,
  date_of_birth date,
  address text,
  emergency_contact jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, patient_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_tenant_clinic_patient_id ON patients(tenant_id, clinic_patient_id) WHERE clinic_patient_id IS NOT NULL AND clinic_patient_id <> '';
CREATE INDEX IF NOT EXISTS idx_patients_tenant_phone ON patients(tenant_id, phone);

CREATE TABLE IF NOT EXISTS services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  duration_minutes int NOT NULL DEFAULT 30,
  price_kobo int NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  service_name text NOT NULL,
  starts_at timestamptz NOT NULL,
  status appointment_status NOT NULL DEFAULT 'requested',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointments_calendar ON appointments(tenant_id, branch_id, starts_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  object_type text,
  object_id uuid,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS doctor_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  doctor_member_id uuid NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at text NOT NULL,
  ends_at text NOT NULL,
  slot_minutes int NOT NULL DEFAULT 30 CHECK (slot_minutes >= 5),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_doctor_schedules_tenant_branch_doctor ON doctor_schedules(tenant_id, branch_id, doctor_member_id);

CREATE TABLE IF NOT EXISTS encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  doctor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','signed','cancelled')),
  reason text,
  diagnosis text,
  clinical_notes text,
  vitals jsonb,
  specialist_data jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_encounters_tenant_patient ON encounters(tenant_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_encounters_tenant_branch ON encounters(tenant_id, branch_id);

CREATE TABLE IF NOT EXISTS prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  doctor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  items jsonb NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prescriptions_tenant_patient ON prescriptions(tenant_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_encounter ON prescriptions(encounter_id);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  lines jsonb NOT NULL,
  subtotal_kobo int NOT NULL DEFAULT 0,
  discount_kobo int NOT NULL DEFAULT 0,
  tax_kobo int NOT NULL DEFAULT 0,
  total_kobo int NOT NULL DEFAULT 0,
  amount_paid_kobo int NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','part_paid','paid','void')),
  issued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_patient_status ON invoices(tenant_id, patient_id, status);

CREATE TABLE IF NOT EXISTS patient_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  title text NOT NULL,
  document_type text NOT NULL CHECK (document_type IN ('report','scan','lab','consent','other')),
  file_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patient_documents_tenant_patient ON patient_documents(tenant_id, patient_id);

CREATE TABLE IF NOT EXISTS patient_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  email citext NOT NULL,
  password_hash text,
  activation_token_hash text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','disabled')),
  last_login_at timestamptz,
  activation_token_expires_at timestamptz,
  activation_token_used_at timestamptz,
  password_reset_token_hash text,
  password_reset_token_expires_at timestamptz,
  password_reset_token_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, patient_id)
);
CREATE INDEX IF NOT EXISTS idx_patient_accounts_tenant_email ON patient_accounts(tenant_id, email);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES patients(id) ON DELETE SET NULL,
  member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  type text NOT NULL,
  recipient text NOT NULL,
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  error text,
  provider text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_tenant_status ON notification_jobs(tenant_id, status, type);

CREATE TABLE IF NOT EXISTS sync_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_operation_id text NOT NULL,
  entity_type text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('synced','failed','conflict')),
  server_object_type text,
  server_object_id uuid,
  error text,
  payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_operation_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_operations_tenant ON sync_operations(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  from_doctor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  to_doctor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  referral_type text NOT NULL CHECK (referral_type IN ('inhouse_specialist','external_clinic')),
  specialty text,
  external_clinic_name text,
  external_clinic_contact text,
  reason text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referrals_tenant_patient ON referrals(tenant_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_referrals_tenant_encounter ON referrals(tenant_id, encounter_id);
CREATE INDEX IF NOT EXISTS idx_referrals_tenant_to_doctor ON referrals(tenant_id, to_doctor_member_id);

CREATE TABLE IF NOT EXISTS staff_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_member_id uuid NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  recipient_member_id uuid NOT NULL REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES patients(id) ON DELETE SET NULL,
  encounter_id uuid REFERENCES encounters(id) ON DELETE SET NULL,
  referral_id uuid REFERENCES referrals(id) ON DELETE SET NULL,
  subject text,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_messages_tenant_recipient ON staff_messages(tenant_id, recipient_member_id);
CREATE INDEX IF NOT EXISTS idx_staff_messages_tenant_sender ON staff_messages(tenant_id, sender_member_id);

CREATE TABLE IF NOT EXISTS inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sku text,
  category text,
  unit text,
  current_stock int NOT NULL DEFAULT 0,
  reorder_level int NOT NULL DEFAULT 0,
  unit_cost_kobo int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant ON inventory_items(tenant_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN ('receive','dispense','adjust')),
  quantity int NOT NULL,
  notes text,
  created_by_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_tenant_item ON inventory_movements(tenant_id, item_id);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_patient_account_id uuid REFERENCES patient_accounts(id) ON DELETE SET NULL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type text;

