import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { canPerform } from '../src/auth/rbac.js';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { PostgresClinicRepository } from '../src/repositories/PostgresClinicRepository.js';
import { createClinicRepository } from '../src/repositories/index.js';
import { buildServer } from '../src/server.js';

describe('multi-tenant clinic model', () => {
  it('allows one tenant to own multiple branches while patients stay tenant-wide', async () => {
    const store = createMemoryStore();
    const tenant = await store.createTenant({ name: 'Celon Dental Clinic', slug: 'celon-dental' });
    const lekki = await store.createBranch({ tenantId: tenant.id, name: 'Lekki Branch', address: 'Lekki' });
    const ikeja = await store.createBranch({ tenantId: tenant.id, name: 'Ikeja Branch', address: 'Ikeja' });
    const patient = await store.createPatient({ tenantId: tenant.id, firstName: 'Mary', lastName: 'Johnson', phone: '+2348012345678' });
    await store.createAppointment({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Dental Cleaning' });
    await store.createAppointment({ tenantId: tenant.id, branchId: ikeja.id, patientId: patient.id, startsAt: '2026-09-15T09:00:00.000Z', serviceName: 'Root Canal Follow-up' });

    const snapshot = await store.getTenantSnapshot(tenant.id);
    expect(snapshot.branches.map((b) => b.name)).toEqual(['Lekki Branch', 'Ikeja Branch']);
    expect(snapshot.patients).toHaveLength(1);
    expect(snapshot.appointments).toHaveLength(2);
    expect(snapshot.appointments.map((a) => a.branchId).sort()).toEqual([ikeja.id, lekki.id].sort());
  });

  it('scopes branch staff to assigned branch while owner sees all branches', async () => {
    const store = createMemoryStore();
    const tenant = await store.createTenant({ name: 'Celon Dental Clinic', slug: 'celon-dental' });
    const branchA = await store.createBranch({ tenantId: tenant.id, name: 'Branch A' });
    const branchB = await store.createBranch({ tenantId: tenant.id, name: 'Branch B' });
    const owner = await store.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const receptionist = await store.addMember({ tenantId: tenant.id, branchIds: [branchA.id], email: 'frontdesk@example.com', role: 'receptionist' });

    expect(await store.visibleBranchesForMember(owner.id)).toEqual([branchA, branchB]);
    expect(await store.visibleBranchesForMember(receptionist.id)).toEqual([branchA]);
  });
});

describe('RBAC permission matrix', () => {
  it('keeps owner/admin controls away from branch staff', () => {
    expect(canPerform('owner', 'manage_subscription')).toBe(true);
    expect(canPerform('owner', 'manage_staff')).toBe(true);
    expect(canPerform('branch_manager', 'manage_appointments')).toBe(true);
    expect(canPerform('receptionist', 'create_appointment')).toBe(true);
    expect(canPerform('receptionist', 'manage_subscription')).toBe(false);
    expect(canPerform('doctor', 'write_encounter')).toBe(true);
    expect(canPerform('doctor', 'manage_staff')).toBe(false);
    expect(canPerform('accountant', 'view_billing')).toBe(true);
    expect(canPerform('accountant', 'write_encounter')).toBe(false);
  });
});

describe('Phase 1 repository and API', () => {
  it('tenant can have multiple branches', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    await repo.createBranch({ tenantId: tenant.id, name: 'Ikeja' });
    expect((await repo.listBranches(tenant.id)).map((item) => item.name)).toEqual(['Lekki', 'Ikeja']);
  });

  it('patients are tenant-wide', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const ikeja = await repo.createBranch({ tenantId: tenant.id, name: 'Ikeja' });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    await repo.createAppointment({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' });
    await repo.createAppointment({ tenantId: tenant.id, branchId: ikeja.id, patientId: patient.id, startsAt: '2026-09-09T09:00:00.000Z', serviceName: 'Follow-up' });
    const snapshot = await repo.getTenantSnapshot(tenant.id);
    expect(snapshot.patients).toHaveLength(1);
    expect(snapshot.patients[0].tenantId).toBe(tenant.id);
    expect(snapshot.appointments.every((item) => item.patientId === patient.id)).toBe(true);
  });

  it('appointment belongs to tenant + branch', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const branch = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    const appointment = await repo.createAppointment({ tenantId: tenant.id, branchId: branch.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' });
    expect(appointment.tenantId).toBe(tenant.id);
    expect(appointment.branchId).toBe(branch.id);
  });

  it('Memory repository CRUD', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const updatedTenant = await repo.updateTenant(tenant.id, { name: 'Celon Dental' });
    const branch = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const member = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    const service = await repo.createService({ tenantId: tenant.id, name: 'Consult' });
    const appointment = await repo.createAppointment({ tenantId: tenant.id, branchId: branch.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: service.name });
    expect(updatedTenant.name).toBe('Celon Dental');
    expect((await repo.updateBranch(branch.id, { name: 'Lekki Annex' })).name).toBe('Lekki Annex');
    expect((await repo.updateMember(member.id, { displayName: 'Owner' })).displayName).toBe('Owner');
    expect((await repo.updatePatient(patient.id, { lastName: 'Okafor' })).lastName).toBe('Okafor');
    expect((await repo.updateService(service.id, { priceKobo: 1000 })).priceKobo).toBe(1000);
    expect((await repo.updateAppointment(appointment.id, { notes: 'Bring x-rays' })).notes).toBe('Bring x-rays');
  });

  it('repository factory chooses memory when no DATABASE_URL', () => {
    const repo = createClinicRepository({ ...process.env, DATABASE_URL: '' });
    expect(repo).toBeInstanceOf(MemoryClinicRepository);
  });

  it('Postgres repository module compiles without DATABASE_URL', () => {
    expect(typeof PostgresClinicRepository).toBe('function');
    // The class must load purely from its import; env presence must not be required.
    // (This test is environment-independent: do not assert ambient env vars are empty,
    // because a real .env file legitimately sets DATABASE_URL in dev.)
    const isolatedRepo = createClinicRepository({ ...process.env, DATABASE_URL: '' });
    expect(isolatedRepo).toBeInstanceOf(MemoryClinicRepository);
  });

  it('Celon demo returns 2 branches', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/demo/celon' });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.snapshot.branches).toHaveLength(2);
    expect(body.snapshot.services.length).toBeGreaterThanOrEqual(2);
    await app.close();
  });

  it('inventory movement receive/dispense updates running stock balance', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const item = await repo.createInventoryItem({ tenantId: tenant.id, name: 'Gloves', unit: 'box', currentStock: 15, reorderLevel: 5, unitCostKobo: 120000 });
    const app = buildServer({ repository: repo });

    const dispensed = await app.inject({
      method: 'POST',
      url: `/api/inventory/${item.id}/movement`,
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: { movementType: 'dispense', quantity: 4 },
    });
    expect(dispensed.statusCode).toBe(201);
    expect(dispensed.json().item.currentStock).toBe(11);

    const received = await app.inject({
      method: 'POST',
      url: `/api/inventory/${item.id}/movement`,
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: { movementType: 'receive', quantity: 9 },
    });
    expect(received.statusCode).toBe(201);
    expect(received.json().item.currentStock).toBe(20);

    const snapshot = await repo.getTenantSnapshot(tenant.id);
    expect(snapshot.inventoryItems.find((entry) => entry.id === item.id)?.currentStock).toBe(20);
    expect(snapshot.inventoryMovements.filter((entry) => entry.itemId === item.id)).toHaveLength(2);
    await app.close();
  });

  it('API returns 401/403 when auth headers missing/insufficient on protected mutations', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const app = buildServer({ repository: repo });
    const missing = await app.inject({ method: 'POST', url: '/api/branches', payload: { tenantId: tenant.id, name: 'Lekki' } });
    expect(missing.statusCode).toBe(401);

    const receptionist = await repo.addMember({ tenantId: tenant.id, email: 'front@example.com', role: 'receptionist' });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': receptionist.id },
      payload: { tenantId: tenant.id, email: 'new@example.com', role: 'doctor' },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });

  it('branch manager cannot mutate another branch', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const ikeja = await repo.createBranch({ tenantId: tenant.id, name: 'Ikeja' });
    const manager = await repo.addMember({ tenantId: tenant.id, email: 'mgr@example.com', role: 'branch_manager', branchIds: [lekki.id] });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    const app = buildServer({ repository: repo });
    const response = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': manager.id },
      payload: { tenantId: tenant.id, branchId: ikeja.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('patient create and update preserve the clinic-assigned Patient ID', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const app = buildServer({ repository: repo });
    const created = await app.inject({
      method: 'POST',
      url: '/api/patients',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: { tenantId: tenant.id, clinicPatientId: 'CELON-OLD-0091', firstName: 'Ada', lastName: 'Okafor', phone: '+234****1111' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().patient.clinicPatientId).toBe('CELON-OLD-0091');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/patients/${created.json().patient.id}`,
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: { clinicPatientId: 'CELON-UPDATED-0091' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().patient.clinicPatientId).toBe('CELON-UPDATED-0091');
    expect(updated.json().patient.patientCode).toMatch(/^PAT-/);
    await app.close();
  });

  it('bulk imports mapped CSV patients and reports invalid rows', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const app = buildServer({ repository: repo });
    const csv = [
      'Existing Patient ID,First Name,Last Name,Phone,Email,Gender,Blood Group,Address',
      'CEL-001,Ada,Okafor,+2348011111111,ada@example.com,female,O+,Lekki Phase 1',
      'CEL-002,Bola,Tunde,+2348022222222,bola@example.com,male,A+,Ikeja',
      'CEL-003,MissingPhone,Patient,,bad@example.com,female,B+,Mainland',
    ].join('\n');
    const response = await app.inject({
      method: 'POST',
      url: '/api/patients/bulk-import',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: {
        tenantId: tenant.id,
        format: 'csv',
        content: csv,
        mapping: {
          clinicPatientId: 'Existing Patient ID',
          firstName: 'First Name',
          lastName: 'Last Name',
          phone: 'Phone',
          email: 'Email',
          gender: 'Gender',
          bloodGroup: 'Blood Group',
          address: 'Address',
        },
      },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.summary).toMatchObject({ imported: 2, failed: 1, total: 3 });
    expect(body.errors[0]).toMatchObject({ row: 4, error: 'PHONE_REQUIRED' });
    expect(body.patients.map((p: any) => p.clinicPatientId)).toEqual(['CEL-001', 'CEL-002']);
    await app.close();
  });

  it('receptionist can create appointment', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const receptionist = await repo.addMember({ tenantId: tenant.id, email: 'front@example.com', role: 'receptionist', branchIds: [lekki.id] });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+234****1111' });
    const app = buildServer({ repository: repo });
    const response = await app.inject({
      method: 'POST',
      url: '/api/appointments',
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': receptionist.id },
      payload: { tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().appointment.status).toBe('requested');
    await app.close();
  });

  it('invalid appointment transition rejected', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    const appointment = await repo.createAppointment({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' });
    const app = buildServer({ repository: repo });
    const response = await app.inject({
      method: 'POST',
      url: `/api/appointments/${appointment.id}/transition`,
      headers: { 'x-tenant-id': tenant.id, 'x-member-id': owner.id },
      payload: { status: 'completed' },
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('valid appointment workflow accepted', async () => {
    const repo = new MemoryClinicRepository();
    const tenant = await repo.createTenant({ name: 'Celon', slug: 'celon' });
    const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
    const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@example.com', role: 'owner' });
    const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
    const appointment = await repo.createAppointment({ tenantId: tenant.id, branchId: lekki.id, patientId: patient.id, startsAt: '2026-09-08T09:00:00.000Z', serviceName: 'Consult' });
    const app = buildServer({ repository: repo });
    const headers = { 'x-tenant-id': tenant.id, 'x-member-id': owner.id };
    const confirmed = await app.inject({ method: 'POST', url: `/api/appointments/${appointment.id}/transition`, headers, payload: { status: 'confirmed' } });
    const checkedIn = await app.inject({ method: 'POST', url: `/api/appointments/${appointment.id}/transition`, headers, payload: { status: 'checked_in' } });
    const completed = await app.inject({ method: 'POST', url: `/api/appointments/${appointment.id}/transition`, headers, payload: { status: 'completed' } });
    expect(confirmed.statusCode).toBe(200);
    expect(checkedIn.json().appointment.status).toBe('checked_in');
    expect(completed.json().appointment.status).toBe('completed');
    await app.close();
  });
});
