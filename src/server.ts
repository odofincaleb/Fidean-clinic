import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { requireAuth, signToken } from './auth/context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerClinicalRoutes } from './routes/clinical.js';
import { registerMessagesRoutes } from './routes/messages.js';
import { registerPaymentsRoutes } from './routes/payments.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerPortalRoutes } from './routes/portal.js';
import { registerReportsRoutes } from './routes/reports.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerReferralsRoutes } from './routes/referrals.js';
import { registerStaffMessagesRoutes } from './routes/staff-messages.js';
import { registerUploadRoutes } from './routes/upload.js';
import { registerInventoryRoutes } from './routes/inventory.js';
import { registerHmoRoutes } from './routes/hmo.js';
import { queuePatientNotification, staffAudit, audit } from './domain/clinicEvents.js';
import { assertBranchAccess, assertCan, canPerform } from './auth/rbac.js';
import { httpError } from './http/errors.js';
import type { ClinicRepository } from './repositories/ClinicRepository.js';
import { getClinicRepository } from './repositories/index.js';
import { SERVICE_NAME, SERVICE_VERSION } from './version.js';
import { buildAvailabilitySlots, resolveDurationMinutes } from './domain/availability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

const tenantInput = z.object({ name: z.string().min(2), slug: z.string().min(2).regex(/^[a-z0-9-]+$/) });
const tenantPatch = z.object({ name: z.string().min(2).optional(), status: z.enum(['active', 'trial', 'suspended']).optional(), slug: z.string().min(2).optional() });
const branchInput = z.object({ tenantId: z.string().min(1), name: z.string().min(2), address: z.string().optional(), phone: z.string().optional() });
const branchPatch = z.object({ name: z.string().min(2).optional(), address: z.string().optional(), phone: z.string().optional(), status: z.enum(['active', 'inactive']).optional() });
const memberInput = z.object({
  tenantId: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'branch_manager', 'store_manager', 'doctor', 'receptionist', 'nurse', 'accountant', 'viewer']),
  branchIds: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  qualifications: z.string().optional(),
  licenseNumber: z.string().optional(),
});
const memberPatch = z.object({
  displayName: z.string().optional(),
  role: z.enum(['owner', 'admin', 'branch_manager', 'doctor', 'receptionist', 'nurse', 'accountant', 'viewer']).optional(),
  branchIds: z.array(z.string()).optional(),
  status: z.enum(['invited', 'active', 'revoked']).optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  qualifications: z.string().optional(),
  licenseNumber: z.string().optional(),
});
const patientInput = z.object({ tenantId: z.string().min(1), branchId: z.string().optional(), clinicPatientId: z.string().optional(), firstName: z.string().min(1), lastName: z.string().optional(), phone: z.string().optional(), email: z.string().email().optional(), altPhone: z.string().optional(), dob: z.string().optional(), gender: z.string().optional(), bloodGroup: z.string().optional(), address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), medicalHistory: z.string().optional() });
const patientPatch = z.object({ branchId: z.string().optional(), clinicPatientId: z.string().optional(), firstName: z.string().min(1).optional(), lastName: z.string().optional(), phone: z.string().min(5).optional(), email: z.string().email().optional(), altPhone: z.string().optional(), dob: z.string().optional(), gender: z.string().optional(), bloodGroup: z.string().optional(), address: z.string().optional(), city: z.string().optional(), state: z.string().optional(), medicalHistory: z.string().optional() });
const patientImportMapping = z.object({
  clinicPatientId: z.string().optional(),
  firstName: z.string(),
  lastName: z.string().optional(),
  phone: z.string(),
  email: z.string().optional(),
  altPhone: z.string().optional(),
  dob: z.string().optional(),
  gender: z.string().optional(),
  bloodGroup: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  medicalHistory: z.string().optional(),
});
const patientBulkImportInput = z.object({
  tenantId: z.string().min(1),
  format: z.enum(['csv', 'excel']).optional(),
  content: z.string().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  mapping: patientImportMapping,
  branchId: z.string().optional(),
});

function parseCsv(content: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell.trim()); cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell.trim()); cell = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, idx) => [header, values[idx] ?? ''])));
}

function normalizeImportCell(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'nil' || normalized === '-' || normalized === 'n/a') return undefined;
  return String(value ?? '').trim();
}
const serviceInput = z.object({
  tenantId: z.string().min(1),
  branchId: z.string().optional(),
  name: z.string().min(2),
  durationMinutes: z.number().int().positive().optional(),
  priceKobo: z.number().int().nonnegative().optional(),
  currency: z.enum(['NGN', 'USD']).optional(),
});
const servicePatch = z.object({
  name: z.string().min(2).optional(),
  durationMinutes: z.number().int().positive().optional(),
  priceKobo: z.number().int().nonnegative().optional(),
  currency: z.enum(['NGN', 'USD']).optional(),
  active: z.boolean().optional(),
  branchId: z.string().optional(),
});
const appointmentInput = z.object({
  tenantId: z.string().min(1),
  branchId: z.string().min(1),
  patientId: z.string().min(1),
  startsAt: z.string().datetime(),
  serviceName: z.string().min(2),
  doctorMemberId: z.string().optional(),
  serviceId: z.string().optional(),
  notes: z.string().optional(),
});
const appointmentPatch = z.object({
  startsAt: z.string().datetime().optional(),
  serviceName: z.string().min(2).optional(),
  doctorMemberId: z.string().optional(),
  notes: z.string().optional(),
});
const transitionInput = z.object({
  status: z.enum(['requested', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']),
});
function assertSameTenant(authTenantId: string, resourceTenantId: string): void {
  if (authTenantId !== resourceTenantId) throw httpError('FORBIDDEN', 403);
}

export function buildServer(options?: { repository?: ClinicRepository }) {
  const repo = options?.repository ?? getClinicRepository();
  const app = Fastify({ logger: false });

  app.register(multipart);
app.register(cors, { origin: true, methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'] });
  app.register(staticPlugin, { root: join(rootDir, 'public'), prefix: '/' });

  app.get('/health', async () => ({ ok: true, service: SERVICE_NAME, version: SERVICE_VERSION }));

  registerAuthRoutes(app, repo);
  registerClinicalRoutes(app, repo);
  registerSettingsRoutes(app, repo);
  registerReportsRoutes(app, repo);
  registerPaymentsRoutes(app, repo);
  registerWalletRoutes(app, repo);
  registerMessagesRoutes(app, repo);
  registerPortalRoutes(app, repo);
  registerSyncRoutes(app, repo);
  registerReferralsRoutes(app, repo);
  registerStaffMessagesRoutes(app, repo);
  registerInventoryRoutes(app, repo);
  registerUploadRoutes(app);
  registerHmoRoutes(app, repo);

  // Super Admin: list all tenants
  app.get('/api/super-admin/tenants', async (request) => {
    const auth = await requireAuth(request, repo);
    if (auth.member.role !== 'owner' && auth.member.role !== 'admin' && auth.member.role !== 'super_admin') throw httpError('FORBIDDEN', 403);
    const tenants = await repo.listTenants();
    const result = [];
    for (const tenant of tenants) {
      const settings = await repo.getSettings(tenant.id);
      const patients = await repo.listPatients(tenant.id);
      const appointments = await repo.listAppointments(tenant.id);
      const invoices = await repo.listInvoices(tenant.id);
      const members = await repo.listMembers(tenant.id);
      result.push({
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        clinicName: settings?.clinicName || tenant.name,
        patientCount: patients.length,
        appointmentCount: appointments.length,
        revenueKobo: invoices.reduce((s, inv) => s + (inv.amountPaidKobo || 0), 0),
        staffCount: members.length,
      });
    }
    return { ok: true, tenants: result };
  });

  // Super Admin: get tenant access token
  app.post('/api/super-admin/tenant-access', async (request) => {
    const auth = await requireAuth(request, repo);
    if (auth.member.role !== 'super_admin') throw httpError('FORBIDDEN', 403);
    const body = z.object({ slug: z.string().min(1) }).parse(request.body);
    const tenants = await repo.listTenants();
    const tenant = tenants.find(t => t.slug === body.slug);
    if (!tenant) throw httpError('TENANT_NOT_FOUND', 404);
    const members = await repo.listMembers(tenant.id);
    // Find or create an admin membership for the super admin
    let member = members.find(m => m.email === auth.member.email);
    if (!member) {
      member = await repo.addMember({ tenantId: tenant.id, email: auth.member.email, role: 'admin', displayName: 'Super Admin' });
      const user = await repo.findUserByEmail(auth.member.email);
      if (user) await repo.linkUserToMembership(member.id, user.id);
    }
    const token = signToken({ memberId: member.id, tenantId: tenant.id, role: member.role, email: member.email });
    return { ok: true, token, tenantId: tenant.id, slug: tenant.slug };
  });

  // Data backup: export all clinic data
  app.get('/api/backup/json', async (request) => {
    const auth = await requireAuth(request, repo);
    const tenantId = auth.tenantId;
    const [patients, appointments, encounters, invoices, services, branches, members, prescriptions] = await Promise.all([
      repo.listPatients(tenantId),
      repo.listAppointments(tenantId),
      repo.listEncounters(tenantId),
      repo.listInvoices(tenantId),
      repo.listServices(tenantId),
      repo.listBranches(tenantId),
      repo.listMembers(tenantId),
      repo.listPrescriptions(tenantId),
    ]);
    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      tenantId,
      data: { patients, appointments, encounters, invoices, services, branches, members, prescriptions },
    };
  });

  // SPA catch-all: serve index.html for all non-API routes
  app.setNotFoundHandler((_request, reply) => {
    const url = _request.url;
    if (url.startsWith('/api/') || url.startsWith('/health') || url.startsWith('/style.css') || url.startsWith('/app.js') || url.startsWith('/sw.js') || url.startsWith('/offline-') || url.startsWith('/favicon') || url.startsWith('/robots.txt')) {
      return reply.code(404).send({ message: `Route ${_request.method}:${url} not found`, error: 'Not Found', statusCode: 404 });
    }
    return reply.sendFile('index.html');
  });

  app.post('/api/demo/celon', async () => {
    const snapshot = await repo.seedCelonDemo();
    const owner = snapshot.members.find((member) => member.role === 'owner');
    const token = owner
      ? signToken({ memberId: owner.id, tenantId: snapshot.tenant.id, role: owner.role, email: owner.email })
      : undefined;
    return {
      ok: true,
      snapshot,
      token,
      devPatientLogin: {
        tenantSlug: snapshot.tenant.slug,
        email: 'demo.patient@example.com',
        password: 'Passw0rd123',
      },
    };
  });

  app.get('/api/tenants', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_branches');
    return { ok: true, tenants: (await repo.listTenants()).filter((tenant) => tenant.id === auth.tenantId) };
  });

  app.post('/api/tenants', async (request, reply) => {
    const input = tenantInput.parse(request.body);
    const tenant = await repo.createTenant(input);
    await audit(repo, { tenantId: tenant.id, ...staffAudit(''), action: 'tenant_create', objectType: 'tenant', objectId: tenant.id });
    return reply.code(201).send({ ok: true, tenant });
  });

  app.get('/api/tenants/:tenantId', async (request) => {
    const auth = await requireAuth(request, repo);
    const params = z.object({ tenantId: z.string() }).parse(request.params);
    assertSameTenant(auth.tenantId, params.tenantId);
    const tenant = await repo.getTenant(params.tenantId);
    if (!tenant) throw httpError('TENANT_NOT_FOUND', 404);
    return { ok: true, tenant };
  });

  app.patch('/api/tenants/:tenantId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_subscription');
    const params = z.object({ tenantId: z.string() }).parse(request.params);
    assertSameTenant(auth.tenantId, params.tenantId);
    return { ok: true, tenant: await repo.updateTenant(params.tenantId, tenantPatch.parse(request.body)) };
  });

  app.get('/api/tenants/:tenantId/snapshot', async (request) => {
    const params = z.object({ tenantId: z.string() }).parse(request.params);
    return { ok: true, snapshot: await repo.getTenantSnapshot(params.tenantId) };
  });

  app.get('/api/branches', async (request) => {
    const auth = await requireAuth(request, repo);
    const branches = await repo.visibleBranchesForMember(auth.member.id);
    return { ok: true, branches };
  });

  app.post('/api/branches', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_branches');
    const input = branchInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    return reply.code(201).send({ ok: true, branch: await repo.createBranch(input) });
  });

  app.delete('/api/branches/:branchId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_branches');
    const params = z.object({ branchId: z.string() }).parse(request.params);
    const branch = await repo.getBranch(params.branchId);
    if (!branch) throw httpError('BRANCH_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, branch.tenantId);
    await repo.deleteBranch(params.branchId);
    return { ok: true };
  });

  app.patch('/api/branches/:branchId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_branches');
    const params = z.object({ branchId: z.string() }).parse(request.params);
    const branch = await repo.getBranch(params.branchId);
    if (!branch) throw httpError('BRANCH_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, branch.tenantId);
    return { ok: true, branch: await repo.updateBranch(params.branchId, branchPatch.parse(request.body)) };
  });

  app.get('/api/members', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'manage_staff') && auth.member.role !== 'branch_manager') {
      throw httpError('FORBIDDEN', 403);
    }
    return { ok: true, members: await repo.listMembers(auth.tenantId) };
  });

  app.post('/api/members', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_staff');
    const input = memberInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    return reply.code(201).send({ ok: true, member: await repo.addMember(input) });
  });

  app.patch('/api/members/:memberId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_staff');
    const params = z.object({ memberId: z.string() }).parse(request.params);
    const member = await repo.getMember(params.memberId);
    if (!member) throw httpError('MEMBER_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, member.tenantId);
    return { ok: true, member: await repo.updateMember(params.memberId, memberPatch.parse(request.body)) };
  });

  app.get('/api/patients', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'view_patients');
    const query = z.object({ branchId: z.string().optional() }).parse(request.query);
    const patients = await repo.listPatients(auth.tenantId);
    const filtered = query.branchId ? patients.filter((p) => p.branchId === query.branchId) : patients;
    return { ok: true, patients: filtered };
  });

  app.post('/api/patients', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'create_appointment') && !canPerform(auth.member.role, 'manage_appointments')) {
      throw httpError('FORBIDDEN', 403);
    }
    const input = patientInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    const patient = await repo.createPatient(input as PatientInput);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'patient_create', objectType: 'patient', objectId: patient.id });
    return reply.code(201).send({ ok: true, patient });
  });

  app.post('/api/patients/bulk-import', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'create_appointment') && !canPerform(auth.member.role, 'manage_appointments') && !canPerform(auth.member.role, 'manage_staff')) {
      throw httpError('FORBIDDEN', 403);
    }
    const input = patientBulkImportInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    const rows = input.rows ?? (input.content ? parseCsv(input.content) : []);
    const imported = [];
    const errors: Array<{ row: number; error: string; details?: string }> = [];
    const existing = await repo.listPatients(auth.tenantId);
    const existingClinicIds = new Set(existing.map((patient) => patient.clinicPatientId).filter(Boolean));
    const existingPhones = new Set(existing.map((patient) => patient.phone).filter(Boolean));
    for (const [index, row] of rows.entries()) {
      const mapped = {
        tenantId: input.tenantId,
        branchId: input.branchId,
        clinicPatientId: input.mapping.clinicPatientId ? normalizeImportCell(row[input.mapping.clinicPatientId]) : undefined,
        firstName: normalizeImportCell(row[input.mapping.firstName]) ?? '',
        lastName: input.mapping.lastName ? normalizeImportCell(row[input.mapping.lastName]) : undefined,
        phone: normalizeImportCell(row[input.mapping.phone]) ?? '',
        email: input.mapping.email ? normalizeImportCell(row[input.mapping.email]) : undefined,
        altPhone: input.mapping.altPhone ? normalizeImportCell(row[input.mapping.altPhone]) : undefined,
        dob: input.mapping.dob ? normalizeImportCell(row[input.mapping.dob]) : undefined,
        gender: input.mapping.gender ? normalizeImportCell(row[input.mapping.gender]) : undefined,
        bloodGroup: input.mapping.bloodGroup ? normalizeImportCell(row[input.mapping.bloodGroup]) : undefined,
        address: input.mapping.address ? normalizeImportCell(row[input.mapping.address]) : undefined,
        city: input.mapping.city ? normalizeImportCell(row[input.mapping.city]) : undefined,
        state: input.mapping.state ? normalizeImportCell(row[input.mapping.state]) : undefined,
        medicalHistory: input.mapping.medicalHistory ? normalizeImportCell(row[input.mapping.medicalHistory]) : undefined,
      };
      const rowNumber = index + 2;
            if (!mapped.firstName) { errors.push({ row: rowNumber, error: 'FIRST_NAME_REQUIRED' }); continue; }
            if (mapped.clinicPatientId && existingClinicIds.has(mapped.clinicPatientId)) { errors.push({ row: rowNumber, error: 'DUPLICATE_CLINIC_PATIENT_ID', details: mapped.clinicPatientId }); continue; }
            if (mapped.phone && existingPhones.has(mapped.phone)) { errors.push({ row: rowNumber, error: 'DUPLICATE_PHONE', details: mapped.phone }); continue; }
      const parsed = patientInput.safeParse(mapped);
      if (!parsed.success) { errors.push({ row: rowNumber, error: 'INVALID_PATIENT_DATA', details: parsed.error.issues.map((issue) => issue.message).join('; ') }); continue; }
      const patient = await repo.createPatient(parsed.data);
      imported.push(patient);
      if (patient.clinicPatientId) existingClinicIds.add(patient.clinicPatientId);
      if (patient.phone) existingPhones.add(patient.phone);
    }
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'patients_bulk_import', objectType: 'patient', details: { imported: imported.length, failed: errors.length } });
    return { ok: true, summary: { total: rows.length, imported: imported.length, failed: errors.length }, patients: imported, errors };
  });

  app.patch('/api/patients/:patientId', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'create_appointment') && !canPerform(auth.member.role, 'manage_appointments')) {
      throw httpError('FORBIDDEN', 403);
    }
    const params = z.object({ patientId: z.string() }).parse(request.params);
    const patient = await repo.getPatient(params.patientId);
    if (!patient) throw httpError('PATIENT_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, patient.tenantId);
    const updated = await repo.updatePatient(params.patientId, patientPatch.parse(request.body));
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'patient_update', objectType: 'patient', objectId: params.patientId });
    return { ok: true, patient: updated };
  });

  app.get('/api/services', async (request) => {
    const auth = await requireAuth(request, repo);
    return { ok: true, services: await repo.listServices(auth.tenantId) };
  });

  app.post('/api/services', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'manage_branches') && auth.member.role !== 'branch_manager') {
      throw httpError('FORBIDDEN', 403);
    }
    const input = serviceInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    if (auth.member.role === 'branch_manager' && input.branchId) assertBranchAccess(auth.member, input.branchId);
    return reply.code(201).send({ ok: true, service: await repo.createService(input) });
  });

  app.delete('/api/services/:serviceId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const params = z.object({ serviceId: z.string() }).parse(request.params);
    const service = await repo.getService(params.serviceId);
    if (!service) throw httpError('SERVICE_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, service.tenantId);
    await repo.deleteService(params.serviceId);
    return { ok: true };
  });

  app.patch('/api/services/:serviceId', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'manage_branches') && auth.member.role !== 'branch_manager') {
      throw httpError('FORBIDDEN', 403);
    }
    const params = z.object({ serviceId: z.string() }).parse(request.params);
    const service = await repo.getService(params.serviceId);
    if (!service) throw httpError('SERVICE_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, service.tenantId);
    if (auth.member.role === 'branch_manager' && service.branchId) assertBranchAccess(auth.member, service.branchId);
    return { ok: true, service: await repo.updateService(params.serviceId, servicePatch.parse(request.body)) };
  });

  app.get('/api/appointments', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({
      branchId: z.string().optional(),
      doctorMemberId: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.enum(['requested', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show']).optional(),
    }).parse(request.query);
    let appointments = await repo.listAppointments(auth.tenantId, query);
    if (auth.member.role === 'branch_manager' || auth.member.role === 'receptionist') {
      appointments = appointments.filter((item) => auth.member.branchIds.includes(item.branchId));
    }
    if (auth.member.role === 'doctor') {
      appointments = appointments.filter((item) => item.doctorMemberId === auth.member.id || auth.member.branchIds.includes(item.branchId));
    }
    return { ok: true, appointments };
  });

  app.post('/api/appointments', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'create_appointment');
    const input = appointmentInput.parse(request.body);
    assertSameTenant(auth.tenantId, input.tenantId);
    assertBranchAccess(auth.member, input.branchId);
    const appointment = await repo.createAppointment(input);
    await queuePatientNotification(repo, {
      tenantId: auth.tenantId,
      patientId: appointment.patientId,
      memberId: auth.member.id,
      type: 'appointment_created',
      subject: 'Appointment booked',
      body: `Appointment ${appointment.serviceName} was created.`,
    });
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'appointment_created', objectType: 'appointment', objectId: appointment.id });
    return reply.code(201).send({ ok: true, appointment });
  });

  app.get('/api/availability', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({
      branchId: z.string(),
      doctorMemberId: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(request.query);
    assertBranchAccess(auth.member, query.branchId);
    const doctor = await repo.getMember(query.doctorMemberId);
    if (!doctor || doctor.tenantId !== auth.tenantId) throw httpError('INVALID_DOCTOR', 404);
    const schedules = (await repo.listDoctorSchedules(auth.tenantId, { branchId: query.branchId, doctorMemberId: query.doctorMemberId }))
      .filter((item) => item.active);
    const appointments = await repo.listAppointments(auth.tenantId, { branchId: query.branchId, doctorMemberId: query.doctorMemberId });
    const services = await repo.listServices(auth.tenantId);
    const { slotMinutes, slots } = buildAvailabilitySlots({
      date: query.date,
      schedules,
      appointments,
      durationFor: (item) => resolveDurationMinutes({ serviceName: item.serviceName }, services),
    });
    return { ok: true, date: query.date, branchId: query.branchId, doctorMemberId: query.doctorMemberId, slotMinutes, slots };
  });

  app.patch('/api/appointments/:appointmentId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_appointments');
    const params = z.object({ appointmentId: z.string() }).parse(request.params);
    const appointment = await repo.getAppointment(params.appointmentId);
    if (!appointment) throw httpError('APPOINTMENT_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, appointment.tenantId);
    assertBranchAccess(auth.member, appointment.branchId);
    return { ok: true, appointment: await repo.updateAppointment(params.appointmentId, appointmentPatch.parse(request.body)) };
  });

  app.post('/api/appointments/:appointmentId/transition', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_appointments');
    const params = z.object({ appointmentId: z.string() }).parse(request.params);
    const appointment = await repo.getAppointment(params.appointmentId);
    if (!appointment) throw httpError('APPOINTMENT_NOT_FOUND', 404);
    assertSameTenant(auth.tenantId, appointment.tenantId);
    assertBranchAccess(auth.member, appointment.branchId);
    const body = transitionInput.parse(request.body);
    return { ok: true, appointment: await repo.transitionAppointment(params.appointmentId, body.status) };
  });

  app.setErrorHandler((error, _request, reply) => {
    const typedError = error as Error & { statusCode?: number; issues?: unknown };
    const status = typedError.statusCode ?? (typedError.name === 'ZodError' ? 400 : 400);
    reply.code(status).send({ ok: false, error: typedError.message });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4310);
  // Default to 0.0.0.0 (all interfaces).
  // The previous fallback of 127.0.0.1 made the app reachable locally but
  // invisible to the internet whenever HOST was absent from the process
  // environment — which presents to users as a complete outage.
  const host = process.env.HOST ?? '0.0.0.0';
  if (!process.env.HOST) {
    console.warn(`[BOOT] HOST not set — defaulting to ${host} (all interfaces)`);
  }
  buildServer()
    .listen({ port, host })
    .then(() => {
      console.log(`[BOOT] fidean-clinic-saas listening on ${host}:${port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
