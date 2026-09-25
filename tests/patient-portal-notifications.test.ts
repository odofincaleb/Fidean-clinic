import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { buildServer } from '../src/server.js';
import { SECRET } from '../src/auth/context.js';

async function clinic() {
  const repo = new MemoryClinicRepository();
  const tenant = await repo.createTenant({ name: 'Clinic', slug: `p3b-${Date.now()}${Math.random().toString(16).slice(2)}` });
  const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
  const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@x.com', role: 'owner' });
  const receptionist = await repo.addMember({ tenantId: tenant.id, email: 'desk@x.com', role: 'receptionist', branchIds: [lekki.id] });
  const doctor = await repo.addMember({ tenantId: tenant.id, email: 'doc@x.com', role: 'doctor', branchIds: [lekki.id] });
  const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111', email: 'ada@example.com' });
  const other = await repo.createPatient({ tenantId: tenant.id, firstName: 'Other', phone: '+2348022222222' });
  const app = buildServer({ repository: repo });
  const staff = { 'x-tenant-id': tenant.id, 'x-member-id': owner.id };
  return { repo, tenant, lekki, owner, receptionist, doctor, patient, other, app, staff };
}

describe('Phase 3B patient portal, notifications, billing hardening', () => {
  it('Invoice payment exceeding balance is rejected with PAYMENT_EXCEEDS_BALANCE', async () => {
    const { app, staff, lekki, patient, tenant } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    const invoiceId = created.json().invoice.id;
    await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/issue`, headers: staff });
    const over = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payment`,
      headers: staff,
      payload: { amountKobo: 1000001 },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe('PAYMENT_EXCEEDS_BALANCE');
    await app.close();
  });

  it('Payment on void invoice is rejected', async () => {
    const { app, staff, lekki, patient, tenant } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    const invoiceId = created.json().invoice.id;
    await app.inject({ method: 'POST', url: `/api/invoices/${invoiceId}/void`, headers: staff });
    const pay = await app.inject({
      method: 'POST',
      url: `/api/invoices/${invoiceId}/payment`,
      headers: staff,
      payload: { amountKobo: 1000 },
    });
    expect(pay.statusCode).toBe(409);
    expect(pay.json().error).toBe('INVOICE_VOID');
    await app.close();
  });

  it('Patient account invite creates account + notification job + audit log', async () => {
    const { app, staff, tenant, patient, repo } = await clinic();
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'portal@example.com' },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().account.status).toBe('invited');
    expect(invite.json().activationToken).toBeTruthy();
    const jobs = await repo.listNotificationJobs(tenant.id, { type: 'patient_portal_invite' });
    expect(jobs).toHaveLength(1);
    const logs = await repo.listAuditLogs(tenant.id, { action: 'patient_account_invite' });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('Patient activation hashes password and returns patient JWT', async () => {
    const { app, staff, tenant, patient, repo } = await clinic();
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'activate@example.com' },
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/activate',
      payload: { token: invite.json().activationToken, password: 'Passw0rd123' },
    });
    expect(activate.statusCode).toBe(200);
    const claims = jwt.verify(activate.json().token, SECRET()) as jwt.JwtPayload;
    expect(claims.typ).toBe('patient');
    expect(claims.patientId).toBe(patient.id);
    const account = await repo.getPatientAccount(activate.json().account.id);
    expect(account?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(account?.status).toBe('active');
    await app.close();
  });

  it('Patient login works after activation', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'login@example.com' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/patient-auth/activate',
      payload: { token: invite.json().activationToken, password: 'Passw0rd123' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/login',
      payload: { tenantSlug: tenant.slug, email: 'login@example.com', password: 'Passw0rd123' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toBeTruthy();
    expect(login.json().patient.id).toBe(patient.id);
    await app.close();
  });

  it('Patient /me rejects staff JWT', async () => {
    const { app, staff, repo, owner, tenant } = await clinic();
    const { signToken } = await import('../src/auth/context.js');
    const token = signToken({ memberId: owner.id, tenantId: tenant.id, role: owner.role, email: owner.email });
    const me = await app.inject({ method: 'GET', url: '/api/patient-auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(403);
    expect(me.json().error).toBe('PATIENT_AUTH_REQUIRED');
    expect(staff).toBeTruthy();
    expect(repo).toBeTruthy();
    await app.close();
  });

  it('Staff endpoints reject patient JWT', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'jwt@example.com' },
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/activate',
      payload: { token: invite.json().activationToken, password: 'Passw0rd123' },
    });
    const invoices = await app.inject({
      method: 'GET',
      url: '/api/invoices',
      headers: { authorization: `Bearer ${activate.json().token}` },
    });
    expect(invoices.statusCode).toBe(403);
    expect(invoices.json().error).toBe('STAFF_AUTH_REQUIRED');
    await app.close();
  });

  it('Patient portal summary returns only that patient’s records', async () => {
    const { app, staff, tenant, lekki, patient, other } = await clinic();
    await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Own', quantity: 1, unitPriceKobo: 1000 }] },
    });
    await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: other.id, lines: [{ description: 'Other', quantity: 1, unitPriceKobo: 5000 }] },
    });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'onlyme@example.com' },
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/activate',
      payload: { token: invite.json().activationToken, password: 'Passw0rd123' },
    });
    const summary = await app.inject({
      method: 'GET',
      url: '/api/patient-portal/summary',
      headers: { authorization: `Bearer ${activate.json().token}` },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().counts.invoices).toBe(1);
    expect(summary.json().patient.id).toBe(patient.id);
    await app.close();
  });

  it('Patient cannot access another patient’s records by query/id guessing', async () => {
    const { app, staff, tenant, lekki, patient, other } = await clinic();
    await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: other.id, lines: [{ description: 'Secret', quantity: 1, unitPriceKobo: 9000 }] },
    });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/invite',
      headers: staff,
      payload: { tenantId: tenant.id, patientId: patient.id, email: 'guess@example.com' },
    });
    const activate = await app.inject({
      method: 'POST',
      url: '/api/patient-auth/activate',
      payload: { token: invite.json().activationToken, password: 'Passw0rd123' },
    });
    const guessed = await app.inject({
      method: 'GET',
      url: `/api/patient-portal/invoices?patientId=${other.id}`,
      headers: { authorization: `Bearer ${activate.json().token}` },
    });
    expect(guessed.statusCode).toBe(200);
    expect(guessed.json().invoices).toHaveLength(0);
    await app.close();
  });

  it('Prescription issue queues notification job', async () => {
    const { app, staff, tenant, lekki, patient, doctor, repo } = await clinic();
    const encounter = await app.inject({
      method: 'POST',
      url: '/api/encounters',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id, reason: 'Pain' },
    });
    const prescription = await app.inject({
      method: 'POST',
      url: '/api/prescriptions',
      headers: staff,
      payload: { tenantId: tenant.id, encounterId: encounter.json().encounter.id, items: [{ medication: 'Ibuprofen' }] },
    });
    const issued = await app.inject({
      method: 'POST',
      url: `/api/prescriptions/${prescription.json().prescription.id}/issue`,
      headers: staff,
    });
    expect(issued.statusCode).toBe(200);
    const jobs = await repo.listNotificationJobs(tenant.id, { type: 'prescription_issued' });
    expect(jobs).toHaveLength(1);
    await app.close();
  });

  it('Invoice payment queues notification job', async () => {
    const { app, staff, tenant, lekki, patient, repo } = await clinic();
    const created = await app.inject({
      method: 'POST',
      url: '/api/invoices',
      headers: staff,
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }] },
    });
    await app.inject({ method: 'POST', url: `/api/invoices/${created.json().invoice.id}/issue`, headers: staff });
    await app.inject({
      method: 'POST',
      url: `/api/invoices/${created.json().invoice.id}/payment`,
      headers: staff,
      payload: { amountKobo: 400000 },
    });
    const jobs = await repo.listNotificationJobs(tenant.id, { type: 'invoice_payment_received' });
    expect(jobs).toHaveLength(1);
    await app.close();
  });

  it('Notification job lifecycle mark-sent/mark-failed/cancel works with RBAC', async () => {
    const { app, staff, tenant, receptionist } = await clinic();
    const queued = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: staff,
      payload: { channel: 'email', type: 'appointment_reminder', recipient: 'a@example.com', body: 'Reminder' },
    });
    const jobId = queued.json().notification.id;
    const desk = { 'x-tenant-id': tenant.id, 'x-member-id': receptionist.id };
    const forbidden = await app.inject({ method: 'POST', url: `/api/notifications/${jobId}/mark-sent`, headers: desk });
    expect(forbidden.statusCode).toBe(403);
    const sent = await app.inject({ method: 'POST', url: `/api/notifications/${jobId}/mark-sent`, headers: staff });
    expect(sent.json().notification.status).toBe('sent');
    const second = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: staff,
      payload: { channel: 'sms', type: 'appointment_created', recipient: '+234800', body: 'Booked' },
    });
    const failed = await app.inject({
      method: 'POST',
      url: `/api/notifications/${second.json().notification.id}/mark-failed`,
      headers: staff,
      payload: { error: 'provider timeout' },
    });
    expect(failed.json().notification.status).toBe('failed');
    const third = await app.inject({
      method: 'POST',
      url: '/api/notifications',
      headers: staff,
      payload: { channel: 'whatsapp', type: 'appointment_reminder', recipient: '+234800', body: 'Later' },
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/notifications/${third.json().notification.id}/cancel`,
      headers: staff,
    });
    expect(cancelled.json().notification.status).toBe('cancelled');
    await app.close();
  });

  it('Audit logs route is owner/admin only', async () => {
    const { app, staff, tenant, receptionist } = await clinic();
    const ok = await app.inject({ method: 'GET', url: '/api/audit-logs', headers: staff });
    expect(ok.statusCode).toBe(200);
    const desk = await app.inject({
      method: 'GET',
      url: '/api/audit-logs',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': receptionist.id },
    });
    expect(desk.statusCode).toBe(403);
    await app.close();
  });

  it('Celon demo includes patient account + notification jobs + audit logs', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/demo/celon' });
    const body = response.json();
    expect(body.snapshot.patientAccounts.length).toBeGreaterThanOrEqual(1);
    expect(body.snapshot.notificationJobs.length).toBeGreaterThanOrEqual(3);
    expect(body.snapshot.auditLogs.length).toBeGreaterThanOrEqual(3);
    expect(body.devPatientLogin.email).toBe('demo.patient@example.com');
    await app.close();
  });
});
