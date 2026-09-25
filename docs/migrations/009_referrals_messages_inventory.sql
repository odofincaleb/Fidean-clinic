-- 009_referrals_messages_inventory.sql
-- Referrals between doctors and to external clinics, staff messaging, and inventory management.

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