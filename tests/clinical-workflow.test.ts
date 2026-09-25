import { describe, expect, it } from 'vitest';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { buildServer } from '../src/server.js';

async function clinic() {
  const repo = new MemoryClinicRepository();
  const tenant = await repo.createTenant({ name: 'Clinic', slug: `c-${Date.now()}${Math.random()}` });
  const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
  const ikeja = await repo.createBranch({ tenantId: tenant.id, name: 'Ikeja' });
  const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@x.com', role: 'owner' });
  const doctor = await repo.addMember({ tenantId: tenant.id, email: 'doc@x.com', role: 'doctor', branchIds: [lekki.id, ikeja.id] });
  const manager = await repo.addMember({ tenantId: tenant.id, email: 'mgr@x.com', role: 'branch_manager', branchIds: [lekki.id] });
  const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
  await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: lekki.id, doctorMemberId: doctor.id, weekday: 4, startsAt: '09:00', endsAt: '17:00' });
  const appointment = await repo.createAppointment({
    tenantId: tenant.id,
    branchId: lekki.id,
    patientId: patient.id,
    doctorMemberId: doctor.id,
    startsAt: '2026-09-10T10:00:00.000Z',
    serviceName: 'Consult',
  });
  return { repo, tenant, lekki, ikeja, owner, doctor, manager, patient, appointment };
}

describe('Phase 3A clinical workflow', () => {
  it('Doctor schedule can be created and filtered by branch/doctor', async () => {
    const { repo, tenant, lekki, ikeja, doctor } = await clinic();
    await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: lekki.id, doctorMemberId: doctor.id, weekday: 1, startsAt: '09:00', endsAt: '17:00' });
    await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: ikeja.id, doctorMemberId: doctor.id, weekday: 2, startsAt: '10:00', endsAt: '16:00' });
    expect(await repo.listDoctorSchedules(tenant.id, { branchId: lekki.id })).toHaveLength(2);
    expect(await repo.listDoctorSchedules(tenant.id, { doctorMemberId: doctor.id })).toHaveLength(3);
  });

  it('Invalid doctor schedule rejects bad time range', async () => {
    const { repo, tenant, lekki, doctor } = await clinic();
    await expect(repo.createDoctorSchedule({
      tenantId: tenant.id,
      branchId: lekki.id,
      doctorMemberId: doctor.id,
      weekday: 1,
      startsAt: '17:00',
      endsAt: '09:00',
    })).rejects.toThrow(/INVALID_SCHEDULE_RANGE/);
  });

  it('Appointment list can filter by branch/status/date range', async () => {
    const { repo, tenant, lekki, ikeja, patient } = await clinic();
    await repo.createAppointment({ tenantId: tenant.id, branchId: ikeja.id, patientId: patient.id, startsAt: '2026-09-20T10:00:00.000Z', serviceName: 'Follow-up' });
    const byBranch = await repo.listAppointments(tenant.id, { branchId: lekki.id });
    expect(byBranch).toHaveLength(1);
    const byStatus = await repo.listAppointments(tenant.id, { status: 'requested' });
    expect(byStatus.length).toBeGreaterThanOrEqual(2);
    const byDate = await repo.listAppointments(tenant.id, { from: '2026-09-19T00:00:00.000Z', to: '2026-09-21T00:00:00.000Z' });
    expect(byDate).toHaveLength(1);
  });

  it('Encounter can be created for tenant-wide patient + branch appointment', async () => {
    const { repo, tenant, lekki, patient, appointment, doctor } = await clinic();
    const encounter = await repo.createEncounter({
      tenantId: tenant.id,
      branchId: lekki.id,
      patientId: patient.id,
      appointmentId: appointment.id,
      doctorMemberId: doctor.id,
      reason: 'Pain',
    });
    expect(encounter.patientId).toBe(patient.id);
    expect(encounter.appointmentId).toBe(appointment.id);
  });

  it('Signed encounter cannot be edited normally', async () => {
    const { repo, tenant, lekki, patient } = await clinic();
    const encounter = await repo.createEncounter({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, reason: 'Pain' });
    await repo.signEncounter(encounter.id);
    await expect(repo.updateEncounter(encounter.id, { diagnosis: 'Caries' })).rejects.toThrow(/ENCOUNTER_SIGNED/);
  });

  it('Prescription requires at least one medication item', async () => {
    const { repo, tenant, lekki, patient } = await clinic();
    const encounter = await repo.createEncounter({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id });
    await expect(repo.createPrescription({ tenantId: tenant.id, encounterId: encounter.id, items: [] })).rejects.toThrow(/PRESCRIPTION_ITEMS_REQUIRED/);
  });

  it('Prescription can be issued', async () => {
    const { repo, tenant, lekki, patient, doctor } = await clinic();
    const encounter = await repo.createEncounter({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, doctorMemberId: doctor.id });
    const prescription = await repo.createPrescription({
      tenantId: tenant.id,
      encounterId: encounter.id,
      items: [{ medication: 'Amoxicillin' }],
    });
    const issued = await repo.issuePrescription(prescription.id);
    expect(issued.status).toBe('issued');
  });

  it('Invoice totals are computed correctly', async () => {
    const { repo, tenant, lekki, patient } = await clinic();
    const invoice = await repo.createInvoice({
      tenantId: tenant.id,
      branchId: lekki.id,
      patientId: patient.id,
      discountKobo: 100000,
      taxKobo: 50000,
      lines: [
        { description: 'Consult', quantity: 2, unitPriceKobo: 500000 },
        { description: 'X-ray', quantity: 1, unitPriceKobo: 200000 },
      ],
    });
    expect(invoice.subtotalKobo).toBe(1200000);
    expect(invoice.totalKobo).toBe(1150000);
    expect(invoice.status).toBe('draft');
  });

  it('Manual invoice payment changes status to part_paid/paid correctly', async () => {
    const { repo, tenant, lekki, patient } = await clinic();
    const invoice = await repo.createInvoice({
      tenantId: tenant.id,
      branchId: lekki.id,
      patientId: patient.id,
      lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000000 }],
    });
    const issued = await repo.issueInvoice(invoice.id);
    expect(issued.status).toBe('issued');
    const partial = await repo.recordInvoicePayment(invoice.id, 400000);
    expect(partial.status).toBe('part_paid');
    const paid = await repo.recordInvoicePayment(invoice.id, 600000);
    expect(paid.status).toBe('paid');
  });

  it('Cross-tenant access to encounter/invoice/document is denied', async () => {
    const a = await clinic();
    const other = await a.repo.createTenant({ name: 'Other', slug: `other-${Math.random()}` });
    const otherOwner = await a.repo.addMember({ tenantId: other.id, email: 'other@x.com', role: 'owner' });
    const encounter = await a.repo.createEncounter({ tenantId: a.tenant.id, branchId: a.lekki.id, patientId: a.patient.id });
    const invoice = await a.repo.createInvoice({
      tenantId: a.tenant.id,
      branchId: a.lekki.id,
      patientId: a.patient.id,
      lines: [{ description: 'Consult', quantity: 1, unitPriceKobo: 1000 }],
    });
    const document = await a.repo.createPatientDocument({
      tenantId: a.tenant.id,
      patientId: a.patient.id,
      title: 'Scan',
      documentType: 'scan',
    });
    const app = buildServer({ repository: a.repo });
    const headers = { 'x-tenant-id': other.id, 'x-member-id': otherOwner.id };
    expect((await app.inject({ method: 'PATCH', url: `/api/encounters/${encounter.id}`, headers, payload: { reason: 'Hack' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/invoices/${invoice.id}/void`, headers })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/patient-documents', headers, payload: { tenantId: a.tenant.id, patientId: a.patient.id, title: 'x', documentType: 'other' } })).statusCode).toBe(403);
    expect(document.tenantId).toBe(a.tenant.id);
    await app.close();
  });

  it('Branch manager cannot write another branch schedule/encounter', async () => {
    const { repo, tenant, ikeja, manager, doctor, patient } = await clinic();
    const app = buildServer({ repository: repo });
    const schedule = await app.inject({
      method: 'POST',
      url: '/api/doctor-schedules',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': manager.id },
      payload: { tenantId: tenant.id, branchId: ikeja.id, doctorMemberId: doctor.id, weekday: 1, startsAt: '09:00', endsAt: '17:00' },
    });
    expect(schedule.statusCode).toBe(403);
    const encounter = await app.inject({
      method: 'POST',
      url: '/api/encounters',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': manager.id },
      payload: { tenantId: tenant.id, branchId: ikeja.id, patientId: patient.id, reason: 'Pain' },
    });
    expect(encounter.statusCode).toBe(403);
    await app.close();
  });

  it('Celon demo snapshot includes all new arrays and expected counts', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/demo/celon' });
    const snapshot = response.json().snapshot;
    expect(snapshot.branches).toHaveLength(2);
    expect(snapshot.doctorSchedules).toHaveLength(2);
    expect(snapshot.encounters).toHaveLength(1);
    expect(snapshot.prescriptions).toHaveLength(1);
    expect(snapshot.invoices).toHaveLength(1);
    expect(snapshot.patientDocuments).toHaveLength(1);
    expect(snapshot.appointments).toHaveLength(1);
    await app.close();
  });
});
