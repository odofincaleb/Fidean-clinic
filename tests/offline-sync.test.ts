import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { buildServer } from '../src/server.js';
import { signPatientToken, signToken } from '../src/auth/context.js';
import { SERVICE_VERSION } from '../src/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function clinic() {
  const repo = new MemoryClinicRepository();
  const tenant = await repo.createTenant({ name: 'Clinic', slug: `p3d-${Date.now()}${Math.random().toString(16).slice(2)}` });
  const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki' });
  const owner = await repo.addMember({ tenantId: tenant.id, email: 'owner@x.com', role: 'owner' });
  const doctor = await repo.addMember({ tenantId: tenant.id, email: 'doc@x.com', role: 'doctor', branchIds: [lekki.id] });
  const doctor2 = await repo.addMember({ tenantId: tenant.id, email: 'doc2@x.com', role: 'doctor', branchIds: [lekki.id] });
  const patient = await repo.createPatient({ tenantId: tenant.id, firstName: 'Ada', phone: '+2348011111111' });
  await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: lekki.id, doctorMemberId: doctor.id, weekday: 1, startsAt: '09:00', endsAt: '17:00', slotMinutes: 30 });
  await repo.createDoctorSchedule({ tenantId: tenant.id, branchId: lekki.id, doctorMemberId: doctor2.id, weekday: 1, startsAt: '09:00', endsAt: '17:00', slotMinutes: 30 });
  const app = buildServer({ repository: repo });
  const staff = { 'x-tenant-id': tenant.id, 'x-member-id': owner.id };
  return { repo, tenant, lekki, owner, doctor, doctor2, patient, app, staff };
}

function sync(app: Awaited<ReturnType<typeof buildServer>>, headers: Record<string, string>, operations: unknown[]) {
  return app.inject({ method: 'POST', url: '/api/sync/operations', headers, payload: { operations } });
}

describe('Phase 3D offline sync', () => {
  it('POST /api/sync/operations requires staff auth', async () => {
    const { app } = await clinic();
    const response = await app.inject({ method: 'POST', url: '/api/sync/operations', payload: { operations: [] } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('Patient JWT cannot use sync endpoint', async () => {
    const { app, tenant, patient, repo } = await clinic();
    const account = await repo.createPatientAccount({ tenantId: tenant.id, patientId: patient.id, email: 'p@example.com', status: 'active', passwordHash: 'x' });
    const token = signPatientToken({ patientAccountId: account.id, tenantId: tenant.id, patientId: patient.id, email: account.email });
    const response = await app.inject({
      method: 'POST',
      url: '/api/sync/operations',
      headers: { authorization: `Bearer ${token}` },
      payload: { operations: [{ clientOperationId: 'a', entityType: 'patient', operation: 'create', payload: { firstName: 'B', phone: '+2348099999999' } }] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('STAFF_AUTH_REQUIRED');
    await app.close();
  });

  it('Sync patient create succeeds, records idempotency, and replay does not duplicate', async () => {
    const { app, staff, tenant, repo } = await clinic();
    const op = {
      clientOperationId: 'op-patient-1',
      entityType: 'patient',
      operation: 'create',
      payload: { tenantId: tenant.id, firstName: 'Chidi', phone: '+2348022222222' },
    };
    const first = await sync(app, staff, [op]);
    expect(first.statusCode).toBe(200);
    expect(first.json().results[0].status).toBe('synced');
    const serverId = first.json().results[0].serverId;
    expect(serverId).toBeTruthy();
    const replay = await sync(app, staff, [op]);
    expect(replay.json().results[0].serverId).toBe(serverId);
    expect(replay.json().results[0].status).toBe('synced');
    const patients = await repo.listPatients(tenant.id);
    expect(patients.filter((item) => item.phone === '+2348022222222')).toHaveLength(1);
    const recorded = await repo.findSyncOperation(tenant.id, 'op-patient-1');
    expect(recorded?.serverObjectId).toBe(serverId);
    await app.close();
  });

  it('Sync patient duplicate phone returns conflict', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const response = await sync(app, staff, [{
      clientOperationId: 'op-dup-phone',
      entityType: 'patient',
      operation: 'create',
      payload: { tenantId: tenant.id, firstName: 'Copy', phone: patient.phone },
    }]);
    expect(response.json().results[0].status).toBe('conflict');
    expect(response.json().results[0].error).toBe('PATIENT_DUPLICATE_PHONE');
    await app.close();
  });

  it('Sync appointment create succeeds when available', async () => {
    const { app, staff, tenant, lekki, patient, doctor } = await clinic();
    const response = await sync(app, staff, [{
      clientOperationId: 'op-appt-ok',
      entityType: 'appointment',
      operation: 'create',
      payload: {
        tenantId: tenant.id,
        branchId: lekki.id,
        patientId: patient.id,
        doctorMemberId: doctor.id,
        serviceName: 'Consult',
        startsAt: '2026-09-14T09:00:00.000Z',
      },
    }]);
    expect(response.json().results[0].status).toBe('synced');
    expect(response.json().results[0].serverId).toBeTruthy();
    await app.close();
  });

  it('Sync appointment outside schedule returns conflict/DOCTOR_NOT_AVAILABLE', async () => {
    const { app, staff, tenant, lekki, patient, doctor } = await clinic();
    const response = await sync(app, staff, [{
      clientOperationId: 'op-appt-off',
      entityType: 'appointment',
      operation: 'create',
      payload: {
        tenantId: tenant.id,
        branchId: lekki.id,
        patientId: patient.id,
        doctorMemberId: doctor.id,
        serviceName: 'Consult',
        startsAt: '2026-09-14T20:00:00.000Z',
      },
    }]);
    expect(response.json().results[0].status).toBe('conflict');
    expect(response.json().results[0].error).toBe('DOCTOR_NOT_AVAILABLE');
    await app.close();
  });

  it('Sync appointment overlapping doctor appointment returns conflict/APPOINTMENT_CONFLICT', async () => {
    const { app, staff, tenant, lekki, patient, doctor } = await clinic();
    const payload = {
      tenantId: tenant.id,
      branchId: lekki.id,
      patientId: patient.id,
      doctorMemberId: doctor.id,
      serviceName: 'Consult',
      startsAt: '2026-09-14T10:00:00.000Z',
    };
    await sync(app, staff, [{ clientOperationId: 'op-appt-a', entityType: 'appointment', operation: 'create', payload }]);
    const other = await app.inject({
      method: 'POST',
      url: '/api/patients',
      headers: staff,
      payload: { tenantId: tenant.id, firstName: 'Bola', phone: '+2348033333333' },
    });
    const conflict = await sync(app, staff, [{
      clientOperationId: 'op-appt-b',
      entityType: 'appointment',
      operation: 'create',
      payload: { ...payload, patientId: other.json().patient.id },
    }]);
    expect(conflict.json().results[0].status).toBe('conflict');
    expect(conflict.json().results[0].error).toBe('APPOINTMENT_CONFLICT');
    await app.close();
  });

  it('Sync patient double booking returns conflict/PATIENT_APPOINTMENT_CONFLICT', async () => {
    const { app, staff, tenant, lekki, patient, doctor, doctor2 } = await clinic();
    await sync(app, staff, [{
      clientOperationId: 'op-double-a',
      entityType: 'appointment',
      operation: 'create',
      payload: {
        tenantId: tenant.id,
        branchId: lekki.id,
        patientId: patient.id,
        doctorMemberId: doctor.id,
        serviceName: 'Consult',
        startsAt: '2026-09-14T11:00:00.000Z',
      },
    }]);
    const conflict = await sync(app, staff, [{
      clientOperationId: 'op-double-b',
      entityType: 'appointment',
      operation: 'create',
      payload: {
        tenantId: tenant.id,
        branchId: lekki.id,
        patientId: patient.id,
        doctorMemberId: doctor2.id,
        serviceName: 'Consult',
        startsAt: '2026-09-14T11:00:00.000Z',
      },
    }]);
    expect(conflict.json().results[0].status).toBe('conflict');
    expect(conflict.json().results[0].error).toBe('PATIENT_APPOINTMENT_CONFLICT');
    await app.close();
  });

  it('Sync dependency missing returns DEPENDENCY_NOT_SYNCED', async () => {
    const { app, staff, tenant, lekki, doctor } = await clinic();
    const response = await sync(app, staff, [{
      clientOperationId: 'op-dep',
      entityType: 'appointment',
      operation: 'create',
      payload: {
        tenantId: tenant.id,
        branchId: lekki.id,
        patientId: 'local-unsynced-patient',
        doctorMemberId: doctor.id,
        serviceName: 'Consult',
        startsAt: '2026-09-14T09:30:00.000Z',
      },
    }]);
    expect(response.json().results[0].status).toBe('failed');
    expect(response.json().results[0].error).toBe('DEPENDENCY_NOT_SYNCED');
    await app.close();
  });

  it('Sync endpoint handles partial success: one synced, one conflict', async () => {
    const { app, staff, tenant, patient } = await clinic();
    const response = await sync(app, staff, [
      {
        clientOperationId: 'op-partial-ok',
        entityType: 'patient',
        operation: 'create',
        payload: { tenantId: tenant.id, firstName: 'Emeka', phone: '+2348044444444' },
      },
      {
        clientOperationId: 'op-partial-conflict',
        entityType: 'patient',
        operation: 'create',
        payload: { tenantId: tenant.id, firstName: 'Dup', phone: patient.phone },
      },
    ]);
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].status).toBe('synced');
    expect(response.json().results[1].status).toBe('conflict');
    await app.close();
  });

  it('Sync operations are tenant-scoped and cross-tenant replay/lookup is forbidden', async () => {
    const a = await clinic();
    const b = await clinic();
    const op = {
      clientOperationId: 'shared-op-id',
      entityType: 'patient',
      operation: 'create',
      payload: { firstName: 'TenantA', phone: '+2348055555555' },
    };
    const first = await sync(a.app, a.staff, [op]);
    const aId = first.json().results[0].serverId;
    const second = await sync(b.app, b.staff, [{ ...op, payload: { firstName: 'TenantB', phone: '+2348066666666' } }]);
    expect(second.json().results[0].serverId).not.toBe(aId);
    expect(await a.repo.findSyncOperation(b.tenant.id, 'shared-op-id')).toBeUndefined();
    expect((await a.repo.findSyncOperation(a.tenant.id, 'shared-op-id'))?.serverObjectId).toBe(aId);
    await a.app.close();
    await b.app.close();
  });

  it('Service worker file exists and does not cache /api/*', async () => {
    const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');
    expect(sw).toContain('fidean-clinic-shell');
    expect(sw).toContain("url.pathname.startsWith('/api/')");
    expect(sw).not.toMatch(/cache\.addAll\([^)]*\/api\//);
    expect(sw).toMatch(/event\.respondWith\(fetch\(event\.request\)\)/);
  });

  it('Offline helper module includes IndexedDB stores and queue statuses', async () => {
    const db = readFileSync(join(root, 'public/offline-db.js'), 'utf8');
    expect(db).toContain('fidean-clinic-offline-v1');
    expect(db).toContain('offlineRecords');
    expect(db).toContain('syncQueue');
    expect(db).toContain('syncMeta');
    expect(db).toContain('queued');
    expect(db).toContain('syncing');
    expect(db).toContain('synced');
    expect(db).toContain('failed');
    expect(db).toContain('conflict');
  });

  it('Demo snapshot includes sync/offline capability flag', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/demo/celon' });
    expect(response.json().snapshot.offlineSync).toBe(true);
    expect(SERVICE_VERSION).toBe('0.7.0');
    const token = signToken({
      memberId: response.json().snapshot.members.find((item: { role: string }) => item.role === 'owner').id,
      tenantId: response.json().snapshot.tenant.id,
      role: 'owner',
      email: 'owner@example.com',
    });
    const status = await app.inject({ method: 'GET', url: '/api/system/status', headers: { authorization: `Bearer ${token}` } });
    expect(status.json().features.offlineSync).toBe(true);
    await app.close();
  });
});
