import { describe, expect, it } from 'vitest';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { buildServer } from '../src/server.js';
import { SERVICE_VERSION } from '../src/version.js';

async function clinic() {
  const repo = new MemoryClinicRepository();
  const tenant = await repo.createTenant({ name: 'Clinic', slug: `p3c-${Date.now()}${Math.random().toString(16).slice(2)}` });
  const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
  const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@x.com', role: 'owner' });
  const receptionist = await repo.addMember({ tenantId: tenant.id, email: 'desk@x.com', role: 'receptionist', branchIds: [lekki.id] });
  const doctor = await repo.addMember({ tenantId: tenant.id, email: 'doc@x.com', role: 'doctor', branchIds: [lekki.id] });
  const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111', email: 'ada@example.com' });
  await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: lekki.id, doctorMemberId: doctor.id, weekday: 1, startsAt: '09:00', endsAt: '17:00', slotMinutes: 30 });
  const app = buildServer({ repository: repo });
  const staff = { 'x-tenant-id': tenant.id, 'x-member-id': owner.id };
  return { repo, tenant, lekki, owner, receptionist, doctor, patient, app, staff };
}

describe('Phase 3C security, availability, readiness', () => {
  it('Patient activation token expires after 72 hours / expired token rejected with ACTIVATION_TOKEN_EXPIRED', async () => {
    const { app, staff, tenant, patient, repo } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'exp@example.com' } });
    const account = await repo.getPatientAccount(invite.json().account.id);
    await repo.updatePatientAccount(account!.id, { activationTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const activate = await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: invite.json().activationToken, password: 'Passw0rd123' } });
    expect(activate.statusCode).toBe(410);
    expect(activate.json().error).toBe('ACTIVATION_TOKEN_EXPIRED');
    await app.close();
  });

  it('Activation token cannot be reused: ACTIVATION_TOKEN_USED', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'reuse@example.com' } });
    const token = invite.json().activationToken;
    expect((await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token, password: 'Passw0rd123' } })).statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token, password: 'Passw0rd123' } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ACTIVATION_TOKEN_USED');
    await app.close();
  });

  it('Resend invite creates a new activation token and expiry; old token no longer activates', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'resend@example.com' } });
    const oldToken = invite.json().activationToken;
    const resend = await app.inject({ method: 'POST', url: `/api/patient-auth/${invite.json().account.id}/resend-invite`, headers: staff });
    expect(resend.statusCode).toBe(200);
    expect(resend.json().activationToken).not.toBe(oldToken);
    expect((await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: oldToken, password: 'Passw0rd123' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: resend.json().activationToken, password: 'Passw0rd123' } })).statusCode).toBe(200);
    await app.close();
  });

  it('Disabled patient account cannot login and existing patient JWT no longer works', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'dis@example.com' } });
    const activated = await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: invite.json().activationToken, password: 'Passw0rd123' } });
    const disable = await app.inject({ method: 'POST', url: `/api/patient-auth/${invite.json().account.id}/disable`, headers: staff });
    expect(disable.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/patient-auth/login', payload: { tenantSlug: tenant.slug, email: 'dis@example.com', password: 'Passw0rd123' } });
    expect(login.statusCode).toBe(403);
    expect(login.json().error).toBe('PATIENT_ACCOUNT_DISABLED');
    const me = await app.inject({ method: 'GET', url: '/api/patient-auth/me', headers: { authorization: `Bearer ${activated.json().token}` } });
    expect(me.statusCode).toBe(403);
    await app.close();
  });

  it('Password reset request does not reveal missing accounts', async () => {
    const { app, tenant } = await clinic();
    const missing = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/request', payload: { tenantSlug: tenant.slug, email: 'nobody@example.com' } });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().ok).toBe(true);
    expect(missing.json().resetToken).toBeUndefined();
    await app.close();
  });

  it('Password reset complete changes password, rejects old password, accepts new password', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'reset@example.com' } });
    await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: invite.json().activationToken, password: 'Passw0rd123' } });
    const requestReset = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/request', payload: { tenantSlug: tenant.slug, email: 'reset@example.com' } });
    expect(requestReset.json().resetToken).toBeTruthy();
    const complete = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/complete', payload: { token: requestReset.json().resetToken, password: 'NewPassw0rd123' } });
    expect(complete.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/patient-auth/login', payload: { tenantSlug: tenant.slug, email: 'reset@example.com', password: 'Passw0rd123' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/patient-auth/login', payload: { tenantSlug: tenant.slug, email: 'reset@example.com', password: 'NewPassw0rd123' } })).statusCode).toBe(200);
    await app.close();
  });

  it('Password reset token cannot be reused and rejects expired token', async () => {
    const { app, staff, tenant, patient, repo } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'rexp@example.com' } });
    await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: invite.json().activationToken, password: 'Passw0rd123' } });
    const first = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/request', payload: { tenantSlug: tenant.slug, email: 'rexp@example.com' } });
    await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/complete', payload: { token: first.json().resetToken, password: 'NewPassw0rd123' } });
    const reuse = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/complete', payload: { token: first.json().resetToken, password: 'AnotherPass1' } });
    expect(reuse.statusCode).toBe(409);
    const second = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/request', payload: { tenantSlug: tenant.slug, email: 'rexp@example.com' } });
    const account = await repo.findPatientAccountByEmail(tenant.id, 'rexp@example.com');
    await repo.updatePatientAccount(account!.id, { passwordResetTokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await app.inject({ method: 'POST', url: '/api/patient-auth/password-reset/complete', payload: { token: second.json().resetToken, password: 'ExpiredPass1' } });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
    await app.close();
  });

  it('Audit logs include actorType + actorMemberId for staff actions', async () => {
    const { app, staff, tenant, patient } = await clinic();
    await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'act@example.com' } });
    const logs = await app.inject({ method: 'GET', url: '/api/audit-logs?action=patient_account_invite', headers: staff });
    const row = logs.json().auditLogs[0];
    expect(row.actorType).toBe('staff');
    expect(row.actorMemberId).toBeTruthy();
    await app.close();
  });

  it('Audit logs include actorType + actorPatientAccountId for patient action', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({ method: 'POST', url: '/api/patient-auth/invite', headers: staff, payload: { tenantId: tenant.id, patientId: patient.id, email: 'pact@example.com' } });
    await app.inject({ method: 'POST', url: '/api/patient-auth/activate', payload: { token: invite.json().activationToken, password: 'Passw0rd123' } });
    const logs = await app.inject({ method: 'GET', url: '/api/audit-logs?action=patient_account_activation', headers: staff });
    const row = logs.json().auditLogs[0];
    expect(row.actorType).toBe('patient');
    expect(row.actorPatientAccountId).toBe(invite.json().account.id);
    await app.close();
  });

  it('Appointment creation outside doctor schedule rejects DOCTOR_NOT_AVAILABLE', async () => {
    const { app, staff, tenant, lekki, doctor, patient } = await clinic();
    const response = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id, startsAt: '2026-09-15T10:00:00.000Z', serviceName: 'Consult' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('DOCTOR_NOT_AVAILABLE');
    await app.close();
  });

  it('Appointment creation overlapping existing doctor appointment rejects APPOINTMENT_CONFLICT', async () => {
    const { app, staff, tenant, lekki, doctor, patient } = await clinic();
    const first = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id, startsAt: '2026-09-14T09:00:00.000Z', serviceName: 'Consult' },
    });
    expect(first.statusCode).toBe(201);
    const other = await app.inject({
      method: 'POST',
      url: '/api/patients',
      headers: staff,
      payload: { tenantId: tenant.id, firstName: 'Bo', phone: '+2348033333333' },
    });
    const overlap = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: other.json().patient.id, doctorMemberId: doctor.id, startsAt: '2026-09-14T09:15:00.000Z', serviceName: 'Consult' },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().error).toBe('APPOINTMENT_CONFLICT');
    await app.close();
  });

  it('Same patient double booking rejects PATIENT_APPOINTMENT_CONFLICT', async () => {
    const { app, staff, tenant, lekki, doctor, patient } = await clinic();
    await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id, startsAt: '2026-09-14T09:00:00.000Z', serviceName: 'Consult' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-14T09:00:00.000Z', serviceName: 'Consult' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('PATIENT_APPOINTMENT_CONFLICT');
    await app.close();
  });

  it('/api/availability returns slots and marks booked slot unavailable', async () => {
    const { app, staff, lekki, doctor, tenant, patient } = await clinic();
    await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id, startsAt: '2026-09-14T09:00:00.000Z', serviceName: 'Consult' },
    });
    const avail = await app.inject({
      method: 'GET',
      url: `/api/availability?branchId=${lekki.id}&doctorMemberId=${doctor.id}&date=2026-09-14`,
      headers: staff,
    });
    expect(avail.statusCode).toBe(200);
    const booked = avail.json().slots.find((slot: { startsAt: string }) => slot.startsAt === '2026-09-14T09:00:00.000Z');
    const open = avail.json().slots.find((slot: { startsAt: string }) => slot.startsAt === '2026-09-14T09:30:00.000Z');
    expect(booked.available).toBe(false);
    expect(open.available).toBe(true);
    await app.close();
  });

  it('Draft invoice payment rejects INVOICE_NOT_ISSUED', async () => {
    const { app, staff, tenant, lekki, patient } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    const pay = await app.inject({ method: 'POST', url: `/api/invoices/${created.json().invoice.id}/payment`, headers: staff, payload: { amountKobo: 1000 } });
    expect(pay.statusCode).toBe(409);
    expect(pay.json().error).toBe('INVOICE_NOT_ISSUED');
    await app.close();
  });

  it('Invoice issue endpoint works and queues notification', async () => {
    const { app, staff, tenant, lekki, patient, repo } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    const issued = await app.inject({ method: 'POST', url: `/api/invoices/${created.json().invoice.id}/issue`, headers: staff });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().invoice.status).toBe('issued');
    expect((await repo.listNotificationJobs(tenant.id, { type: 'invoice_issued' })).length).toBe(1);
    await app.close();
  });

  it('Payment after issue works and queues notification', async () => {
    const { app, staff, tenant, lekki, patient, repo } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    await app.inject({ method: 'POST', url: `/api/invoices/${created.json().invoice.id}/issue`, headers: staff });
    const paid = await app.inject({ method: 'POST', url: `/api/invoices/${created.json().invoice.id}/payment`, headers: staff, payload: { amountKobo: 400000 } });
    expect(paid.json().invoice.status).toBe('part_paid');
    expect((await repo.listNotificationJobs(tenant.id, { type: 'invoice_payment_received' })).length).toBe(1);
    await app.close();
  });

  it('Dry-run notification send marks queued job sent and records provider result', async () => {
    const { app, staff } = await clinic();
    const queued = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: staff,
      payload: { channel: 'email', type: 'appointment_reminder', recipient: 'a@example.com', body: 'Reminder' },
    });
    const sent = await app.inject({ method: 'POST', url: `/api/notifications/${queued.json().notification.id}/send-dry-run`, headers: staff });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().notification.status).toBe('sent');
    expect(sent.json().providerResult.provider).toBe('dry_run');
    expect(sent.json().notification.providerMessageId).toMatch(/^dryrun_/);
    await app.close();
  });

  it('/api/system/status owner/admin works and contains no secret-looking values', async () => {
    const { app, staff } = await clinic();
    const status = await app.inject({ method: 'GET', url: '/api/system/status', headers: staff });
    expect(status.statusCode).toBe(200);
    const body = JSON.stringify(status.json());
    expect(status.json().version).toBe(SERVICE_VERSION);
    expect(status.json().databaseMode).toBe('memory');
    expect(body).not.toMatch(/password|secret|DATABASE_URL|jwt/i);
    await app.close();
  });

  it('Lower role cannot read /api/system/status', async () => {
    const { app, tenant, receptionist } = await clinic();
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/status',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': receptionist.id },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('Celon demo includes Phase 3C fields/counts and still supports patient login', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/demo/celon' });
    const body = response.json();
    expect(body.snapshot.patientAccounts[0].activationTokenUsedAt).toBeTruthy();
    expect(body.snapshot.notificationJobs.length).toBeGreaterThanOrEqual(3);
    expect(body.snapshot.auditLogs.some((item: { actorType?: string }) => item.actorType === 'system')).toBe(true);
    const login = await app.inject({ method: 'POST', url: '/api/patient-auth/login', payload: body.devPatientLogin });
    expect(login.statusCode).toBe(200);
    await app.close();
  });
});
