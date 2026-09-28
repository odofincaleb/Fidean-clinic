-- 011_messaging_wallet.sql
-- Adds wallet and messaging fields to clinic_settings (NAIRA ONLY — no kobo)
-- Creates wallet_transactions table for tracking top-ups and deductions

ALTER TABLE clinic_settings
  ADD COLUMN IF NOT EXISTS wallet_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS messaging_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_cost_per_msg INTEGER NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS sms_cost_per_msg INTEGER NOT NULL DEFAULT 6;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit')),
  reason TEXT NOT NULL CHECK (reason IN ('topup', 'whatsapp_msg', 'sms_msg')),
  message_log_id UUID,
  paystack_reference TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_tenant ON wallet_transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created ON wallet_transactions(created_at DESC);