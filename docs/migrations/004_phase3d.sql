-- Phase 3D idempotent sync operations.
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
