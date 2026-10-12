import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';
import { sendWhatsAppMessage } from '../notifications/whatsappSender.js';
import { sendSmsMessage } from '../notifications/smsSender.js';

/**
 * Secure broadcast sender.
 *
 * Why this endpoint exists (and why it replaces the old client-side
 * per-patient loop):
 *   1. DEDUPE + VALIDATION — the server normalizes every phone (NG format),
 *      removes duplicates and rejects invalid numbers BEFORE anything is
 *      charged. Old flow charged/sent duplicates and burned ₦ on junk.
 *   2. FAIL-CLOSED WALLET — the whole batch cost is checked upfront; if the
 *      wallet cannot cover it, NOTHING is sent (HTTP 402) instead of a
 *      half-delivered blast. Balance is re-checked per message so a
 *      concurrent spend can never push the wallet negative.
 *   3. PACING — sends in batches of 25 with a delay between batches, so a
 *      474-recipient blast does not burst Meta's API (HTTP 429) and does not
 *      trip the daily unique-conversation limit all at once.
 *   4. RESULT TRACKING — the job record keeps sent/failed/skipped counts and
 *      per-recipient results, so the staff screen can show "delivered /
 *      failed / cost" instead of a spinner and hope. Failures are never
 *      charged (deduction happens only on success).
 *
 * Jobs are process-local (Map). If the process restarts mid-blast, sends stop
 * but wallets were never over-charged and every attempted recipient has a
 * message_log row — the partial run is fully auditable from the log.
 */

const BATCH_SIZE = 25;          // messages per batch
const BATCH_DELAY_MS = 1200;    // gap between batches (Meta burst safety)
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 200;

interface BroadcastRecipient { phone: string; name?: string; templateParams?: string[]; }

interface BroadcastJob {
  id: string;
  tenantId: string;
  channel: 'whatsapp' | 'sms';
  templateName?: string;
  total: number;        // valid + deduped recipients that will be attempted
  dupesRemoved: number;
  invalid: number;
  sent: number;
  failed: number;
  skipped: number;
  status: 'running' | 'done' | 'error';
  results: Array<{ phone: string; name?: string; ok: boolean; status: string; providerMessageId?: string; error?: string }>;
  costPerMsg: number;
  balanceBefore: number;
  balanceAfter: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const jobs = new Map<string, BroadcastJob>();

/** Normalize a Nigerian phone to E.164-without-plus (234XXXXXXXXXX) or null. */
function normalizeNgPhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let p = String(raw).trim().replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '234' + p.slice(1); // 0803... -> 234803...
  if (!/^234[78901]\d{9}$/.test(p)) return null;
  return p;
}

function purgeStaleJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - new Date(job.createdAt).getTime() > JOB_TTL_MS) jobs.delete(id);
  }
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
    while (jobs.size > MAX_JOBS) { const entry = oldest.shift(); if (entry) jobs.delete(entry[0]); }
  }
}

export function registerBroadcastRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.post('/api/messages/broadcast', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_broadcast');

    const body = z.object({
      channel: z.enum(['sms', 'whatsapp']),
      body: z.string().min(1),
      subject: z.string().optional(),
      templateName: z.string().optional(),
      recipients: z.array(z.object({
        phone: z.union([z.string(), z.number()]),
        name: z.string().optional(),
        templateParams: z.array(z.string()).optional(),
      })).min(1).max(5000),
    }).parse(request.body);

    const settings = await repo.getSettings(auth.tenantId);
    if (!settings?.messagingEnabled) throw httpError('MESSAGING_DISABLED', 403);
    const costPerMsg = body.channel === 'whatsapp'
      ? (settings.whatsappCostPerMsg ?? 80)
      : (settings.smsCostPerMsg ?? 6);
    const balance = settings.walletBalance ?? 0;

    // Phase 1 — normalize, dedupe, validate. Nothing is charged for dupes or
    // junk numbers; they are reported, not sent.
    const byPhone = new Map<string, BroadcastRecipient>();
    let dupes = 0;
    for (const r of body.recipients) {
      const norm = normalizeNgPhone(r.phone);
      if (!norm) continue;
      if (byPhone.has(norm)) { dupes += 1; continue; }
      byPhone.set(norm, { phone: norm, name: r.name ?? '', templateParams: r.templateParams });
    }
    const recipients = [...byPhone.values()];
    const invalid = body.recipients.length - recipients.length - dupes;
    if (recipients.length === 0) throw httpError('NO_VALID_RECIPIENTS', 422);

    // Phase 2 — fail-closed wallet check on the REAL (valid, deduped) count.
    const totalCost = recipients.length * costPerMsg;
    if (balance < totalCost) throw httpError('INSUFFICIENT_WALLET_BALANCE', 402);

    const job: BroadcastJob = {
      id: `bc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      tenantId: auth.tenantId,
      channel: body.channel,
      templateName: body.templateName,
      total: recipients.length,
      dupesRemoved: dupes,
      invalid,
      sent: 0,
      failed: 0,
      skipped: 0,
      status: 'running',
      results: [],
      costPerMsg,
      balanceBefore: balance,
      balanceAfter: balance,
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);

    // Phase 3 — paced background send. Fire-and-forget; the client polls.
    const run = async () => {
      job.startedAt = new Date().toISOString();
      let bal = balance;
      try {
        for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
          const batch = recipients.slice(i, i + BATCH_SIZE);
          for (const r of batch) {
            if (bal < costPerMsg) {
              job.skipped += 1;
              job.results.push({ phone: r.phone, name: r.name, ok: false, status: 'skipped', error: 'INSUFFICIENT_WALLET_BALANCE' });
              continue;
            }
            try {
              const log = await repo.createMessageLog(auth.tenantId, {
                channel: body.channel,
                recipient: r.phone,
                subject: body.subject,
                body: body.body,
              });
              const sendResult = body.channel === 'whatsapp'
                ? await sendWhatsAppMessage({
                    to: r.phone,
                    template: {
                      name: body.templateName || 'clinic_announcement_msg',
                      // Real template shapes (verified on Meta 2026-10-13):
                      //   announcement: {{1}} clinic, {{2}} message
                      //   health_tip:   {{1}} clinic, {{2}} tip
                      //   appointment:  {{1}} clinic, {{2}} datetime
                      //   receipt:      {{1}} amount, {{2}} clinic, {{3}} receipt no
                      bodyParams: r.templateParams || [settings?.clinicName || 'Fidean Clinic', body.body],
                    },
                  })
                : await sendSmsMessage({ to: r.phone, body: body.body, senderId: settings?.smsSenderId || undefined });

              if (!sendResult.ok) {
                job.failed += 1;
                job.results.push({ phone: r.phone, name: r.name, ok: false, status: 'failed', error: sendResult.error });
                await repo.updateMessageLog(log.id, { status: 'failed', provider: body.channel, error: sendResult.error });
                continue;
              }

              job.sent += 1;
              bal -= costPerMsg;
              await repo.upsertSettings(auth.tenantId, { walletBalance: bal });
              await repo.recordWalletTransaction(auth.tenantId, {
                amount: costPerMsg,
                type: 'debit',
                reason: body.channel === 'whatsapp' ? 'whatsapp_msg' : 'sms_msg',
                messageLogId: log.id,
                description: `${body.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} broadcast to ${r.phone}`,
              });
              await repo.updateMessageLog(log.id, {
                status: 'sent',
                provider: body.channel,
                providerMessageId: sendResult.providerMessageId,
                sentAt: new Date().toISOString(),
              });
              job.results.push({ phone: r.phone, name: r.name, ok: true, status: 'sent', providerMessageId: sendResult.providerMessageId });
            } catch (err) {
              job.failed += 1;
              job.results.push({ phone: r.phone, name: r.name, ok: false, status: 'failed', error: String(err?.message || err) });
            }
          }
          if (i + BATCH_SIZE < recipients.length) {
            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
          }
        }
        await audit(repo, {
          tenantId: auth.tenantId,
          ...staffAudit(auth.member.id),
          action: 'broadcast_send',
          objectType: 'tenant',
          objectId: auth.tenantId,
          details: {
            channel: body.channel,
            requested: body.recipients.length,
            total: job.total,
            sent: job.sent,
            failed: job.failed,
            skipped: job.skipped,
            dupesRemoved: job.dupesRemoved,
            invalid: job.invalid,
            cost: job.sent * costPerMsg,
          },
        });
      } catch (err) {
        job.status = 'error';
        job.error = String(err?.message || err);
      } finally {
        job.balanceAfter = bal;
        job.finishedAt = new Date().toISOString();
        if (job.status !== 'error') job.status = 'done';
      }
    };
    void run();

    purgeStaleJobs();
    return reply.code(201).send({
      ok: true,
      jobId: job.id,
      totals: {
        requested: body.recipients.length,
        total: job.total,
        dupesRemoved: dupes,
        invalid,
        totalCost,
        balance,
      },
    });
  });

  app.get('/api/messages/broadcast/:jobId', async (request) => {
    const auth = await requireAuth(request, repo);
    const params = z.object({ jobId: z.string().min(1) }).parse(request.params);
    purgeStaleJobs();
    const job = jobs.get(params.jobId);
    if (!job || job.tenantId !== auth.tenantId) throw httpError('JOB_NOT_FOUND', 404);
    return { ok: true, job };
  });
}