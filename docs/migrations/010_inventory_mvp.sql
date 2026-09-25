-- 010_inventory_mvp.sql
-- Inventory MVP: selling price, suppliers, batch/expiry tracking, movement metadata.

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS selling_price_kobo int NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id);

CREATE TABLE IF NOT EXISTS inventory_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  batch_number text,
  expiry_date date,
  quantity_remaining int NOT NULL DEFAULT 0,
  cost_price_kobo int NOT NULL DEFAULT 0,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_tenant_item ON inventory_batches(tenant_id, item_id);
CREATE INDEX IF NOT EXISTS idx_inventory_batches_expiry ON inventory_batches(tenant_id, expiry_date);

ALTER TABLE inventory_movements
  ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES inventory_batches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS previous_quantity int,
  ADD COLUMN IF NOT EXISTS new_quantity int,
  ADD COLUMN IF NOT EXISTS cost_price_kobo int,
  ADD COLUMN IF NOT EXISTS batch_number text,
  ADD COLUMN IF NOT EXISTS expiry_date date;

ALTER TABLE inventory_movements DROP CONSTRAINT IF EXISTS inventory_movements_movement_type_check;
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_movement_type_check
  CHECK (movement_type IN ('purchase','dispense','usage','adjustment','return','receive','adjust'));
