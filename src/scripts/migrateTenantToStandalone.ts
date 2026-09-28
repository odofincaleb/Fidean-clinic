/**
 * migrateTenantToStandalone.ts
 *
 * Exports all data for a single tenant as standalone SQL that can be
 * imported into a fresh Postgres instance — enabling a clinic to start
 * on the SaaS and later self-host.
 *
 * Usage:
 *   npx tsx src/scripts/migrateTenantToStandalone.ts --slug=<tenant-slug> [--out=./migration.sql]
 *
 * The tenant is marked `status = 'migrated'` on the source after export.
 * Wallet balance is NOT transferred — it's a per-tenant ledger; the
 * clinic sets it up fresh on their own instance.
 */

import 'dotenv/config';
import pg from 'pg';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const { Pool } = pg;

// ── CLI args ──
const slugArg = process.argv.find((a) => a.startsWith('--slug='));
const outArg = process.argv.find((a) => a.startsWith('--out='));
const TENANT_SLUG = slugArg ? slugArg.split('=')[1] : '';
const OUT_PATH = outArg ? resolve(outArg.split('=')[1]) : resolve(`./migration-${TENANT_SLUG || 'unknown'}.sql`);

if (!TENANT_SLUG) {
  console.error('Usage: npx tsx src/scripts/migrateTenantToStandalone.ts --slug=<tenant-slug> [--out=./path.sql]');
  process.exit(1);
}

// ── DB connection (reads from DATABASE_URL env) ──
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Helpers ──
function esc(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) {
    // Postgres timestamps: ISO string without quotes
    return `'${val.toISOString().replace(/'/g, "''")}'`;
  }
  if (typeof val === 'object') {
    // JSONB columns — serialize as valid JSON literal
    const json = JSON.stringify(val);
    return `'${json.replace(/'/g, "''")}'`;
  }
  // string / uuid / date — escape single quotes
  return `'${String(val).replace(/'/g, "''")}'`;
}

function rowToInsert(table: string, row: Record<string, unknown>, skipCols: string[] = []): string {
  const cols = Object.keys(row).filter((k) => !skipCols.includes(k));
  const vals = cols.map((k) => esc(row[k]));
  return `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')});`;
}

function sqlComment(msg: string): string {
  return `\n-- ${msg}`;
}

// ── Collect rows (ordered by FK dependency) ──
async function collect(slug: string): Promise<string> {
  const lines: string[] = [];
  lines.push(`-- ============================================================`);
  lines.push(`-- Migration: Tenant "${slug}" → Standalone Instance`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(`-- ============================================================\n`);

  // Resolve tenant
  const { rows: tenants } = await pool.query(`SELECT * FROM tenants WHERE slug = $1`, [slug]);
  if (tenants.length === 0) {
    console.error(`Tenant not found: "${slug}"`);
    process.exit(1);
  }
  const tenant = tenants[0];
  const tid = tenant.id;
  console.log(`Exporting tenant: ${tenant.name} (${tenant.slug}) — ID: ${tid}`);

  lines.push(sqlComment('1. Tenants'));
  tenants.forEach((r) => lines.push(rowToInsert('tenants', r)));

  // Branches
  const { rows: branches } = await pool.query(`SELECT * FROM branches WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`2. Branches (${branches.length})`));
  branches.forEach((r) => lines.push(rowToInsert('branches', r)));

  // Services
  const { rows: services } = await pool.query(`SELECT * FROM services WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`3. Services (${services.length})`));
  services.forEach((r) => lines.push(rowToInsert('services', r)));

  // Suppliers
  const { rows: suppliers } = await pool.query(`SELECT * FROM suppliers WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`4. Suppliers (${suppliers.length})`));
  suppliers.forEach((r) => lines.push(rowToInsert('suppliers', r)));

  // Inventory items
  const { rows: inventoryItems } = await pool.query(`SELECT * FROM inventory_items WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`5. Inventory items (${inventoryItems.length})`));
  inventoryItems.forEach((r) => lines.push(rowToInsert('inventory_items', r)));

  // Inventory batches
  const { rows: inventoryBatches } = await pool.query(`SELECT * FROM inventory_batches WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`6. Inventory batches (${inventoryBatches.length})`));
  inventoryBatches.forEach((r) => lines.push(rowToInsert('inventory_batches', r)));

  // Patients
  const { rows: patients } = await pool.query(`SELECT * FROM patients WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`7. Patients (${patients.length})`));
  patients.forEach((r) => lines.push(rowToInsert('patients', r)));

  // Patient accounts (portal)
  const { rows: patientAccounts } = await pool.query(`SELECT * FROM patient_accounts WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`8. Patient portal accounts (${patientAccounts.length})`));
  patientAccounts.forEach((r) => lines.push(rowToInsert('patient_accounts', r, ['password_hash' as string])));

  // Doctor schedules
  const { rows: schedules } = await pool.query(`SELECT * FROM doctor_schedules WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`9. Doctor schedules (${schedules.length})`));
  schedules.forEach((r) => lines.push(rowToInsert('doctor_schedules', r)));

  // Appointments
  const { rows: appointments } = await pool.query(`SELECT * FROM appointments WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`10. Appointments (${appointments.length})`));
  appointments.forEach((r) => lines.push(rowToInsert('appointments', r)));

  // Encounters
  const { rows: encounters } = await pool.query(`SELECT * FROM encounters WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`11. Encounters (${encounters.length})`));
  encounters.forEach((r) => lines.push(rowToInsert('encounters', r)));

  // Prescriptions
  const { rows: prescriptions } = await pool.query(`SELECT * FROM prescriptions WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`12. Prescriptions (${prescriptions.length})`));
  prescriptions.forEach((r) => lines.push(rowToInsert('prescriptions', r)));

  // Invoices
  const { rows: invoices } = await pool.query(`SELECT * FROM invoices WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`13. Invoices (${invoices.length})`));
  invoices.forEach((r) => lines.push(rowToInsert('invoices', r)));

  // Paystack transactions
  const { rows: paystackTxs } = await pool.query(`SELECT * FROM paystack_transactions WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`14. Paystack transactions (${paystackTxs.length})`));
  paystackTxs.forEach((r) => lines.push(rowToInsert('paystack_transactions', r)));

  // HMO insurances
  const { rows: hmos } = await pool.query(`SELECT * FROM hmo_insurances WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`15. HMO insurances (${hmos.length})`));
  hmos.forEach((r) => lines.push(rowToInsert('hmo_insurances', r)));

  // Inventory movements
  const { rows: invMoves } = await pool.query(`SELECT * FROM inventory_movements WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`16. Inventory movements (${invMoves.length})`));
  invMoves.forEach((r) => lines.push(rowToInsert('inventory_movements', r)));

  // Notification jobs
  const { rows: notifJobs } = await pool.query(`SELECT * FROM notification_jobs WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`17. Notification jobs (${notifJobs.length})`));
  notifJobs.forEach((r) => lines.push(rowToInsert('notification_jobs', r)));

  // Patient documents
  const { rows: docs } = await pool.query(`SELECT * FROM patient_documents WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`18. Patient documents (${docs.length})`));
  docs.forEach((r) => lines.push(rowToInsert('patient_documents', r)));

  // Referrals
  const { rows: referrals } = await pool.query(`SELECT * FROM referrals WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`19. Referrals (${referrals.length})`));
  referrals.forEach((r) => lines.push(rowToInsert('referrals', r)));

  // Staff messages
  const { rows: staffMsgs } = await pool.query(`SELECT * FROM staff_messages WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`20. Staff messages (${staffMsgs.length})`));
  staffMsgs.forEach((r) => lines.push(rowToInsert('staff_messages', r)));

  // Message logs
  const { rows: msgLogs } = await pool.query(`SELECT * FROM message_logs WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`21. Message logs (${msgLogs.length})`));
  msgLogs.forEach((r) => lines.push(rowToInsert('message_logs', r)));

  // Wallet transactions
  const { rows: walletTxs } = await pool.query(`SELECT * FROM wallet_transactions WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`22. Wallet transactions (${walletTxs.length})`));
  walletTxs.forEach((r) => lines.push(rowToInsert('wallet_transactions', r)));

  // Sync operations
  const { rows: syncOps } = await pool.query(`SELECT * FROM sync_operations WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`23. Sync operations (${syncOps.length})`));
  syncOps.forEach((r) => lines.push(rowToInsert('sync_operations', r)));

  // Audit logs
  const { rows: auditLogs } = await pool.query(`SELECT * FROM audit_logs WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`24. Audit logs (${auditLogs.length})`));
  auditLogs.forEach((r) => lines.push(rowToInsert('audit_logs', r)));

  // Clinic settings
  const { rows: settings } = await pool.query(`SELECT * FROM clinic_settings WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`25. Clinic settings`));
  settings.forEach((r) => lines.push(rowToInsert('clinic_settings', r)));

  // Tenant memberships + their users
  const { rows: memberships } = await pool.query(`SELECT * FROM tenant_memberships WHERE tenant_id = $1`, [tid]);
  lines.push(sqlComment(`26. Tenant memberships / staff (${memberships.length})`));
  // Collect user IDs for these members
  const userIds = memberships.map((m: any) => m.user_id).filter(Boolean);
  if (userIds.length > 0) {
    const { rows: users } = await pool.query(`SELECT * FROM users WHERE id = ANY($1)`, [userIds]);
    lines.push(sqlComment(`    Users (${users.length})`));
    users.forEach((r) => lines.push(rowToInsert('users', r, [])));
  }
  memberships.forEach((r) => lines.push(rowToInsert('tenant_memberships', r)));

  // ── Final instructions ──
  lines.push(``);
  lines.push(`-- ============================================================`);
  lines.push(`-- Migration complete. Import this SQL into the target DB:`);
  lines.push(`--   psql -U <user> -d <standalone_db> -f migration.sql`);
  lines.push(`-- Then:`);
  lines.push(`--   UPDATE clinic_settings SET clinic_logo_url = REPLACE(clinic_logo_url,`);
  lines.push(`--     'old-saas.com', 'new-standalone.com');`);
  lines.push(`--   UPDATE tenants SET status = 'active';  -- if migrated source had it`);
  lines.push(`-- ============================================================`);

  return lines.join('\n');
}

// ── Main ──
try {
  const sql = await collect(TENANT_SLUG);
  writeFileSync(OUT_PATH, sql, 'utf-8');
  console.log(`\n✅ Migration SQL written to: ${OUT_PATH}`);
  console.log(`   File size: ${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB`);

  // Mark tenant as migrated on source
  await pool.query(`UPDATE tenants SET status = 'migrated', updated_at = NOW() WHERE slug = $1`, [TENANT_SLUG]);
  console.log(`   Tenant "${TENANT_SLUG}" marked as "migrated" on source.`);

} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
} finally {
  await pool.end();
}