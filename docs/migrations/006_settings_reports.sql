-- Fidean Clinic SaaS v0.8.0
-- Phase: Settings, Reports, Paystack, Email/SMS

-- 1. Clinic settings
CREATE TABLE IF NOT EXISTS clinic_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  clinic_name text NOT NULL DEFAULT '',
  clinic_address text NOT NULL DEFAULT '',
  clinic_logo_url text NOT NULL DEFAULT '',
  brand_primary_color text NOT NULL DEFAULT '#66f2ea',
  brand_accent_color text NOT NULL DEFAULT '#3b82f6',
  notification_templates jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id)
);

-- 2. Paystack transactions
CREATE TABLE IF NOT EXISTS paystack_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  reference text NOT NULL UNIQUE,
  amount_kobo integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  channel text,
  paid_at timestamptz,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Email/SMS log
CREATE TABLE IF NOT EXISTS message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel text NOT NULL, -- 'email' | 'sms' | 'whatsapp'
  recipient text NOT NULL,
  subject text,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  provider text,
  provider_message_id text,
  sent_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE clinic_settings IS 'Tenant clinic profile, branding, notification templates';
COMMENT ON TABLE paystack_transactions IS 'Paystack payment attempt records';
COMMENT ON TABLE message_logs IS 'Email/SMS delivery audit trail';