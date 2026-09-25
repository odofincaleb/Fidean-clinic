import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth, requirePatientAuth, signPatientToken } from '../auth/context.js';
import { ACTIVATION_TTL_MS, PASSWORD_RESET_TTL_MS, expiresAt, hashToken, newDevToken } from '../auth/tokens.js';
import { assertCan, canPerform } from '../auth/rbac.js';
import { toPublicPatientAccount } from '../domain/clinical.js';
import { audit, patientAudit, staffAudit } from '../domain/clinicEvents.js';
import { httpError } from '../http/errors.js';
import { sendNotification } from '../notifications/provider.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';
import type { NotificationJob } from '../domain/types.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';

const notificationType = z.enum([
  'patient_portal_invite',
  'appointment_created',
  'appointment_reminder',
  'prescription_issued',
  'invoice_issued',
  'invoice_payment_received',
  'patient_password_reset',
]);

function canInvitePatient(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'receptionist' || role === 'doctor';
}

function canManageNotifications(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

export function registerPortalRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/patient-accounts', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canInvitePatient(auth.member.role) || !canPerform(auth.member.role, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const accounts = await repo.listPatientAccounts(auth.tenantId);
    return { ok: true, accounts: accounts.map(toPublicPatientAccount) };
  });

  app.post('/api/patient-auth/invite', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canInvitePatient(auth.member.role) || !canPerform(auth.member.role, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const input = z.object({ tenantId: z.string(), patientId: z.string(), email: z.string().email() }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const patient = await repo.getPatient(input.patientId);
    if (!patient || patient.tenantId !== auth.tenantId) throw httpError('PATIENT_NOT_FOUND', 404);
    const email = input.email.toLowerCase();
    if (await repo.findPatientAccountByEmail(auth.tenantId, email)) throw httpError('PATIENT_EMAIL_TAKEN', 409);
    const activationToken = newDevToken();
    const account = await repo.createPatientAccount({
      tenantId: auth.tenantId,
      patientId: patient.id,
      email,
      status: 'invited',
      activationTokenHash: hashToken(activationToken),
      activationTokenExpiresAt: expiresAt(ACTIVATION_TTL_MS),
    });
    await repo.queueNotification({
      tenantId: auth.tenantId,
      patientId: patient.id,
      memberId: auth.member.id,
      channel: 'email',
      type: 'patient_portal_invite',
      recipient: email,
      subject: 'Activate your clinic portal',
      body: `Click the link below to activate your patient portal:\n\nhttp://169.58.111.70:4310/activate?token=${activationToken}\n\nThis link expires in 48 hours.`,
    });
    // Send immediately via SMTP
    try {
      const settings = await repo.getSettings(auth.tenantId);
      const { sendNotification } = await import('../notifications/provider.js');
      await sendNotification({
        tenantId: auth.tenantId,
        channel: 'email',
        to: email,
        recipient: email,
        subject: 'Activate your clinic portal',
        body: `Click the link below to activate your patient portal:\n\nhttp://169.58.111.70:4310/activate?token=${activationToken}\n\nThis link expires in 48 hours.`,
      }, settings);
    } catch (_) {}
    await audit(repo, {
      tenantId: auth.tenantId,
      ...staffAudit(auth.member.id),
      action: 'patient_account_invite',
      objectType: 'patient_account',
      objectId: account.id,
      details: { patientId: patient.id, email },
    });
    return reply.code(201).send({ ok: true, account: toPublicPatientAccount(account), activationToken });
  });

  app.post('/api/patient-auth/bulk-invite', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canInvitePatient(auth.member.role) || !canPerform(auth.member.role, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const input = z.object({ tenantId: z.string(), patientIds: z.array(z.string()).min(1).max(200) }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);

    const invited: Array<{ patientId: string; email: string; activationToken?: string }> = [];
    const skipped: Array<{ patientId: string; reason: string }> = [];
    let sentNotifications = 0;

    for (const patientId of input.patientIds) {
      const patient = await repo.getPatient(patientId);
      if (!patient || patient.tenantId !== auth.tenantId) {
        skipped.push({ patientId, reason: 'PATIENT_NOT_FOUND' });
        continue;
      }
      const email = (patient.email || '').toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        skipped.push({ patientId, reason: 'NO_VALID_EMAIL' });
        continue;
      }
      const existing = await repo.findPatientAccountByEmail(auth.tenantId, email);
      if (existing) {
        skipped.push({ patientId, reason: existing.status === 'invited' ? 'ALREADY_INVITED' : 'ACCOUNT_ACTIVE' });
        continue;
      }
      const activationToken = newDevToken();
      const account = await repo.createPatientAccount({
        tenantId: auth.tenantId,
        patientId: patient.id,
        email,
        status: 'invited',
        activationTokenHash: hashToken(activationToken),
        activationTokenExpiresAt: expiresAt(ACTIVATION_TTL_MS),
      });
      await repo.queueNotification({
        tenantId: auth.tenantId,
        patientId: patient.id,
        memberId: auth.member.id,
        channel: 'email',
        type: 'patient_portal_invite',
        recipient: email,
        subject: 'Activate your clinic portal',
        body: `Click the link below to activate your patient portal:\n\nhttp://169.58.111.70:4310/activate?token=${activationToken}\n\nThis link expires in 48 hours.`,
      });
      // Send immediately via SMTP
      try {
        const settings = await repo.getSettings(auth.tenantId);
        const { sendNotification } = await import('../notifications/provider.js');
        await sendNotification({
          tenantId: auth.tenantId,
          channel: 'email',
          to: email,
          recipient: email,
          subject: 'Activate your clinic portal',
          body: `Click the link below to activate your patient portal:\n\nhttp://169.58.111.70:4310/activate?token=${activationToken}\n\nThis link expires in 48 hours.`,
        }, settings);
      } catch (_) {}
      sentNotifications += 1;
      invited.push({ patientId: patient.id, email, activationToken });
    }

    await audit(repo, {
      tenantId: auth.tenantId,
      ...staffAudit(auth.member.id),
      action: 'patient_account_bulk_invite',
      objectType: 'patient',
      details: { total: input.patientIds.length, invited: invited.length, skipped: skipped.length },
    });
    return reply.code(201).send({ ok: true, summary: { total: input.patientIds.length, invited: invited.length, skipped: skipped.length }, invited, skipped });
  });

  app.post('/api/patient-auth/:accountId/resend-invite', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canInvitePatient(auth.member.role) || !canPerform(auth.member.role, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const account = await repo.getPatientAccount(params.accountId);
    if (!account || account.tenantId !== auth.tenantId) throw httpError('PATIENT_ACCOUNT_NOT_FOUND', 404);
    if (account.status !== 'invited') throw httpError('PATIENT_ACCOUNT_NOT_INVITED', 409);
    const activationToken = newDevToken();
    const updated = await repo.updatePatientAccount(account.id, {
      activationTokenHash: hashToken(activationToken),
      activationTokenExpiresAt: expiresAt(ACTIVATION_TTL_MS),
      activationTokenUsedAt: undefined,
    });
    const activationLink = `http://169.58.111.70:4310/activate?token=${activationToken}`;
    await repo.queueNotification({
      tenantId: auth.tenantId,
      patientId: account.patientId,
      memberId: auth.member.id,
      channel: 'email',
      type: 'patient_portal_invite',
      recipient: account.email,
      subject: 'Activate your clinic portal',
      body: `Click the link below to activate your patient portal:\n\n${activationLink}\n\nThis link expires in 48 hours.`,
    });
    // Send immediately using SMTP
    try {
      const settings = await repo.getSettings(auth.tenantId);
      await sendNotification({
        tenantId: auth.tenantId,
        channel: 'email',
        to: account.email,
        recipient: account.email,
        subject: 'Activate your clinic portal',
        body: `Click the link below to activate your patient portal:\n\n${activationLink}\n\nThis link expires in 48 hours.`,
      }, settings);
    } catch (e: any) {
      // SMTP may not be configured — that's okay, queue handles it
    }
    await audit(repo, {
      tenantId: auth.tenantId,
      ...staffAudit(auth.member.id),
      action: 'patient_account_resend_invite',
      objectType: 'patient_account',
      objectId: account.id,
    });
    return { ok: true, account: toPublicPatientAccount(updated), activationToken };
  });

  app.post('/api/patient-auth/:accountId/disable', async (request) => {
    const auth = await requireAuth(request, repo);
    if (auth.member.role !== 'owner' && auth.member.role !== 'admin') throw httpError('FORBIDDEN', 403);
    const params = z.object({ accountId: z.string() }).parse(request.params);
    const account = await repo.getPatientAccount(params.accountId);
    if (!account || account.tenantId !== auth.tenantId) throw httpError('PATIENT_ACCOUNT_NOT_FOUND', 404);
    const updated = await repo.updatePatientAccount(account.id, { status: 'disabled' });
    await audit(repo, {
      tenantId: auth.tenantId,
      ...staffAudit(auth.member.id),
      action: 'patient_account_disable',
      objectType: 'patient_account',
      objectId: account.id,
    });
    return { ok: true, account: toPublicPatientAccount(updated) };
  });

  app.post('/api/patient-auth/activate', async (request) => {
    const input = z.object({ token: z.string().min(8), password: z.string().min(8) }).parse(request.body);
    const account = await repo.findPatientAccountByActivationTokenHash(hashToken(input.token));
    if (!account) throw httpError('INVALID_ACTIVATION_TOKEN', 401);
    if (account.status === 'disabled') throw httpError('PATIENT_ACCOUNT_DISABLED', 403);
    if (account.activationTokenUsedAt) throw httpError('ACTIVATION_TOKEN_USED', 409);
    if (account.activationTokenExpiresAt && new Date(account.activationTokenExpiresAt).getTime() < Date.now()) {
      throw httpError('ACTIVATION_TOKEN_EXPIRED', 410);
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    const active = await repo.updatePatientAccount(account.id, {
      status: 'active',
      passwordHash,
      activationTokenUsedAt: new Date().toISOString(),
    });
    await audit(repo, {
      tenantId: account.tenantId,
      ...patientAudit(account.id),
      action: 'patient_account_activation',
      objectType: 'patient_account',
      objectId: account.id,
    });
    const tenant = await repo.getTenant(account.tenantId);
    const patient = await repo.getPatient(account.patientId);
    const token = signPatientToken({
      patientAccountId: active.id,
      tenantId: active.tenantId,
      patientId: active.patientId,
      email: active.email,
    });
    return { ok: true, token, account: toPublicPatientAccount(active), tenant, patient };
  });

  app.post('/api/patient-auth/password-reset/request', async (request) => {
    const input = z.object({ tenantSlug: z.string(), email: z.string().email() }).parse(request.body);
    const tenant = await repo.getTenantBySlug(input.tenantSlug);
    const account = tenant ? await repo.findPatientAccountByEmail(tenant.id, input.email) : undefined;
    let resetToken: string | undefined;
    if (tenant && account?.status === 'active') {
      resetToken = newDevToken();
      await repo.updatePatientAccount(account.id, {
        passwordResetTokenHash: hashToken(resetToken),
        passwordResetTokenExpiresAt: expiresAt(PASSWORD_RESET_TTL_MS),
        passwordResetTokenUsedAt: undefined,
      });
      await repo.queueNotification({
        tenantId: tenant.id,
        patientId: account.patientId,
        channel: 'email',
        type: 'patient_password_reset',
        recipient: account.email,
        subject: 'Reset your clinic portal password',
        body: 'Use the password reset token. Sending providers are not connected yet.',
      });
      await audit(repo, {
        tenantId: tenant.id,
        ...patientAudit(account.id),
        action: 'patient_password_reset_request',
        objectType: 'patient_account',
        objectId: account.id,
      });
    }
    return { ok: true, resetToken };
  });

  app.post('/api/patient-auth/password-reset/complete', async (request) => {
    const input = z.object({ token: z.string().min(8), password: z.string().min(8) }).parse(request.body);
    const account = await repo.findPatientAccountByPasswordResetTokenHash(hashToken(input.token));
    if (!account) throw httpError('INVALID_PASSWORD_RESET_TOKEN', 401);
    if (account.status === 'disabled') throw httpError('PATIENT_ACCOUNT_DISABLED', 403);
    if (account.passwordResetTokenUsedAt) throw httpError('PASSWORD_RESET_TOKEN_USED', 409);
    if (account.passwordResetTokenExpiresAt && new Date(account.passwordResetTokenExpiresAt).getTime() < Date.now()) {
      throw httpError('PASSWORD_RESET_TOKEN_EXPIRED', 410);
    }
    await repo.updatePatientAccount(account.id, {
      passwordHash: await bcrypt.hash(input.password, 10),
      passwordResetTokenUsedAt: new Date().toISOString(),
    });
    await audit(repo, {
      tenantId: account.tenantId,
      ...patientAudit(account.id),
      action: 'patient_password_reset_complete',
      objectType: 'patient_account',
      objectId: account.id,
    });
    return { ok: true };
  });

  app.post('/api/patient-auth/login', async (request) => {
    const input = z.object({ tenantSlug: z.string(), email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const tenant = await repo.getTenantBySlug(input.tenantSlug);
    if (!tenant) throw httpError('INVALID_CREDENTIALS', 401);
    const account = await repo.findPatientAccountByEmail(tenant.id, input.email);
    if (!account?.passwordHash || !(await bcrypt.compare(input.password, account.passwordHash))) {
      throw httpError('INVALID_CREDENTIALS', 401);
    }
    if (account.status === 'disabled') throw httpError('PATIENT_ACCOUNT_DISABLED', 403);
    if (account.status !== 'active') throw httpError('PATIENT_ACCOUNT_INACTIVE', 403);
    await repo.updatePatientAccount(account.id, { lastLoginAt: new Date().toISOString() });
    const patient = await repo.getPatient(account.patientId);
    const token = signPatientToken({
      patientAccountId: account.id,
      tenantId: account.tenantId,
      patientId: account.patientId,
      email: account.email,
    });
    return { ok: true, token, account: toPublicPatientAccount(account), tenant, patient };
  });

  app.get('/api/patient-auth/me', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    const tenant = await repo.getTenant(auth.tenantId);
    const patient = await repo.getPatient(auth.patientId);
    const account = await repo.getPatientAccount(auth.patientAccountId);
    if (!tenant || !patient || !account) throw httpError('NOT_FOUND', 404);
    return { ok: true, account: toPublicPatientAccount(account), tenant, patient };
  });

  app.get('/api/patient-portal/summary', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    const tenant = await repo.getTenant(auth.tenantId);
    const patient = await repo.getPatient(auth.patientId);
    const appointments = await repo.listAppointments(auth.tenantId);
    const mineAppts = appointments.filter((item) => item.patientId === auth.patientId);
    const prescriptions = (await repo.listPrescriptions(auth.tenantId, { patientId: auth.patientId }));
    const invoices = (await repo.listInvoices(auth.tenantId, { patientId: auth.patientId }));
    const documents = (await repo.listPatientDocuments(auth.tenantId, { patientId: auth.patientId }));
    const clinicSettings = await repo.getSettings(auth.tenantId);
    return {
      ok: true,
      tenant,
      patient,
      settings: {
        bankName: clinicSettings?.bankName,
        bankAccountName: clinicSettings?.bankAccountName,
        bankAccountNumber: clinicSettings?.bankAccountNumber,
        bankTransferEnabled: clinicSettings?.bankTransferEnabled,
      },
      counts: {
        appointments: mineAppts.length,
        prescriptions: prescriptions.length,
        invoices: invoices.length,
        documents: documents.length,
      },
      upcomingAppointments: mineAppts.slice(-5),
      recentPrescriptions: prescriptions.slice(-5),
      openInvoices: invoices.filter((item) => item.status === 'issued' || item.status === 'part_paid' || item.status === 'draft'),
      documents: documents.slice(-5),
    };
  });

  app.get('/api/patient-portal/appointments', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    const appointments = (await repo.listAppointments(auth.tenantId)).filter((item) => item.patientId === auth.patientId);
    return { ok: true, appointments };
  });

  app.get('/api/patient-portal/prescriptions', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    return { ok: true, prescriptions: await repo.listPrescriptions(auth.tenantId, { patientId: auth.patientId }) };
  });

  app.get('/api/patient-portal/invoices', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    return { ok: true, invoices: await repo.listInvoices(auth.tenantId, { patientId: auth.patientId }) };
  });

  app.get('/api/patient-portal/documents', async (request) => {
    const auth = await requirePatientAuth(request, repo);
    return { ok: true, documents: await repo.listPatientDocuments(auth.tenantId, { patientId: auth.patientId }) };
  });

  app.get('/api/notifications', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageNotifications(auth.member.role) && auth.member.role !== 'receptionist' && auth.member.role !== 'accountant') {
      throw httpError('FORBIDDEN', 403);
    }
    const query = z.object({
      status: z.enum(['queued', 'sent', 'failed', 'cancelled']).optional(),
      type: z.string().optional(),
    }).parse(request.query);
    const jobs = await repo.listNotificationJobs(auth.tenantId, {
      status: query.status,
      type: query.type as NotificationJob['type'] | undefined,
    });
    return { ok: true, notifications: jobs };
  });

  app.post('/api/notifications', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const input = z.object({
      patientId: z.string().optional(),
      channel: z.enum(['email', 'sms', 'whatsapp']),
      type: notificationType,
      recipient: z.string().min(3),
      subject: z.string().optional(),
      body: z.string().min(1),
    }).parse(request.body);
    if (!canManageNotifications(auth.member.role)) {
      const receptionistOk = auth.member.role === 'receptionist' && (input.type === 'appointment_created' || input.type === 'patient_portal_invite' || input.type === 'appointment_reminder');
      const accountantOk = auth.member.role === 'accountant' && (input.type === 'invoice_issued' || input.type === 'invoice_payment_received');
      if (!receptionistOk && !accountantOk) throw httpError('FORBIDDEN', 403);
    }
    const job = await repo.queueNotification({
      tenantId: auth.tenantId,
      patientId: input.patientId,
      memberId: auth.member.id,
      channel: input.channel,
      type: input.type,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
    });
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'notification_queued', objectType: 'notification_job', objectId: job.id });
    return reply.code(201).send({ ok: true, notification: job });
  });

  app.post('/api/notifications/:jobId/send-dry-run', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageNotifications(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ jobId: z.string() }).parse(request.params);
    const job = await repo.getNotificationJob(params.jobId);
    if (!job || job.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    if (job.status !== 'queued') throw httpError('NOTIFICATION_NOT_QUEUED', 409);
    const settings = await repo.getSettings(auth.tenantId);
    const result = await sendNotification(job, settings || { smtpHost: '' } as never);
    const updated = result.ok
      ? await repo.markNotificationSent(job.id, { provider: result.provider, providerMessageId: result.providerMessageId })
      : await repo.markNotificationFailed(job.id, result.error || 'SEND_FAILED');
    await audit(repo, {
      tenantId: auth.tenantId,
      ...staffAudit(auth.member.id),
      action: result.ok ? 'notification_sent' : 'notification_failed',
      objectType: 'notification_job',
      objectId: job.id,
      details: result,
    });
    return { ok: result.ok, notification: updated, providerResult: result };
  });

  app.post('/api/notifications/:jobId/mark-sent', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageNotifications(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ jobId: z.string() }).parse(request.params);
    const job = await repo.getNotificationJob(params.jobId);
    if (!job || job.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const updated = await repo.markNotificationSent(params.jobId);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'notification_sent', objectType: 'notification_job', objectId: job.id });
    return { ok: true, notification: updated };
  });

  app.post('/api/notifications/:jobId/mark-failed', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageNotifications(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ jobId: z.string() }).parse(request.params);
    const body = z.object({ error: z.string().min(1) }).parse(request.body ?? { error: 'failed' });
    const job = await repo.getNotificationJob(params.jobId);
    if (!job || job.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const updated = await repo.markNotificationFailed(params.jobId, body.error);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'notification_failed', objectType: 'notification_job', objectId: job.id });
    return { ok: true, notification: updated };
  });

  app.post('/api/notifications/:jobId/cancel', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageNotifications(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ jobId: z.string() }).parse(request.params);
    const job = await repo.getNotificationJob(params.jobId);
    if (!job || job.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const updated = await repo.cancelNotification(params.jobId);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'notification_cancelled', objectType: 'notification_job', objectId: job.id });
    return { ok: true, notification: updated };
  });

  app.get('/api/audit-logs', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_staff');
    if (auth.member.role !== 'owner' && auth.member.role !== 'admin') throw httpError('FORBIDDEN', 403);
    const query = z.object({
      objectType: z.string().optional(),
      objectId: z.string().optional(),
      action: z.string().optional(),
    }).parse(request.query);
    return { ok: true, auditLogs: await repo.listAuditLogs(auth.tenantId, query) };
  });

  app.get('/api/system/status', async (request) => {
    const auth = await requireAuth(request, repo);
    if (auth.member.role !== 'owner' && auth.member.role !== 'admin') throw httpError('FORBIDDEN', 403);
    return {
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      databaseMode: repo.storageMode(),
      notificationProvider: 'dry_run',
      time: new Date().toISOString(),
      features: {
        patientPortal: true,
        notificationsQueue: true,
        dryRunNotifications: true,
        paymentGateway: false,
        realFileUploads: false,
        aiClinicalAssistant: false,
        offlineSync: true,
      },
    };
  });
}
