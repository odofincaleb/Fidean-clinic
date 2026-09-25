import { createHash } from 'node:crypto';
import { HttpError } from '../http/errors.js';
import type { ClinicRepository, InvoiceInput, PrescriptionInput } from '../repositories/ClinicRepository.js';
import type { SyncEntityType, SyncOperationInput, SyncOperationRecord, SyncOperationResult } from './types.js';

export function hashSyncPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

function isLocalRef(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith('local-');
}

function toResult(record: SyncOperationRecord): SyncOperationResult {
  return {
    clientOperationId: record.clientOperationId,
    status: record.status,
    serverId: record.serverObjectId,
    entityType: record.entityType,
    error: record.error,
    message: syncResultMessage(record.error) || record.error,
  };
}

async function persist(repo: ClinicRepository, input: {
  tenantId: string;
  op: SyncOperationInput;
  status: SyncOperationRecord['status'];
  serverId?: string;
  error?: string;
}): Promise<SyncOperationResult> {
  const record = await repo.recordSyncOperation({
    tenantId: input.tenantId,
    clientOperationId: input.op.clientOperationId,
    entityType: input.op.entityType,
    operation: input.op.operation,
    status: input.status,
    serverObjectType: input.op.entityType,
    serverObjectId: input.serverId,
    error: input.error,
    payloadHash: hashSyncPayload(input.op.payload),
  });
  return toResult(record);
}

export async function applySyncOperations(
  repo: ClinicRepository,
  tenantId: string,
  operations: SyncOperationInput[],
): Promise<SyncOperationResult[]> {
  const results: SyncOperationResult[] = [];
  for (const op of operations) {
    results.push(await applyOne(repo, tenantId, op));
  }
  return results;
}

async function applyOne(repo: ClinicRepository, tenantId: string, op: SyncOperationInput): Promise<SyncOperationResult> {
  const existing = await repo.findSyncOperation(tenantId, op.clientOperationId);
  if (existing) {
    if (existing.payloadHash !== hashSyncPayload(op.payload)) {
      return { clientOperationId: op.clientOperationId, status: 'conflict', entityType: op.entityType, error: 'IDEMPOTENCY_PAYLOAD_MISMATCH', message: 'Client operation id already used with a different payload' };
    }
    return toResult(existing);
  }
  try {
    if (op.operation !== 'create') {
      return persist(repo, { tenantId, op, status: 'failed', error: 'UNSUPPORTED_OPERATION' });
    }
    if (op.payload.tenantId && op.payload.tenantId !== tenantId) {
      return persist(repo, { tenantId, op, status: 'failed', error: 'FORBIDDEN' });
    }
    const payload = { ...op.payload, tenantId };
    switch (op.entityType) {
      case 'patient':
        return applyPatient(repo, tenantId, op, payload);
      case 'appointment':
        return applyAppointment(repo, tenantId, op, payload);
      case 'encounter':
        return applyEncounter(repo, tenantId, op, payload);
      case 'prescription':
        return applyPrescription(repo, tenantId, op, payload);
      case 'invoice':
        return applyInvoice(repo, tenantId, op, payload);
      case 'patientDocument':
        return applyDocument(repo, tenantId, op, payload);
      default:
        return persist(repo, { tenantId, op, status: 'failed', error: 'UNSUPPORTED_ENTITY' });
    }
  } catch (error) {
    const message = error instanceof HttpError ? error.message : (error as Error).message;
    const conflict = /CONFLICT|NOT_AVAILABLE|DUPLICATE|VOID|NOT_ISSUED/.test(message) || (error instanceof HttpError && error.statusCode === 409);
    return persist(repo, { tenantId, op, status: conflict ? 'conflict' : 'failed', error: message || 'SYNC_FAILED' });
  }
}

async function applyPatient(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const phone = String(payload.phone || '');
  const firstName = String(payload.firstName || '');
  if (!firstName || phone.length < 5) return persist(repo, { tenantId, op, status: 'failed', error: 'INVALID_PATIENT' });
  const patients = await repo.listPatients(tenantId);
  if (patients.some((item) => item.phone === phone)) {
    return persist(repo, { tenantId, op, status: 'conflict', error: 'PATIENT_DUPLICATE_PHONE' });
  }
  if (payload.patientCode && patients.some((item) => item.patientCode === payload.patientCode)) {
    return persist(repo, { tenantId, op, status: 'conflict', error: 'PATIENT_DUPLICATE_CODE' });
  }
  const created = await repo.createPatient({
    tenantId,
    firstName,
    lastName: payload.lastName ? String(payload.lastName) : undefined,
    phone,
    email: payload.email ? String(payload.email) : undefined,
  });
  return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
}

async function applyAppointment(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const patientId = String(payload.patientId || '');
  const branchId = String(payload.branchId || '');
  if (isLocalRef(patientId) || isLocalRef(branchId) || isLocalRef(payload.doctorMemberId)) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const patient = await repo.getPatient(patientId);
  const branch = await repo.getBranch(branchId);
  if (!patient || patient.tenantId !== tenantId || !branch || branch.tenantId !== tenantId) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  try {
    const created = await repo.createAppointment({
      tenantId,
      branchId,
      patientId,
      startsAt: String(payload.startsAt),
      serviceName: String(payload.serviceName || 'Consult'),
      doctorMemberId: payload.doctorMemberId ? String(payload.doctorMemberId) : undefined,
      notes: payload.notes ? String(payload.notes) : undefined,
    });
    return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
  } catch (error) {
    const message = error instanceof HttpError ? error.message : (error as Error).message;
    if (message === 'DOCTOR_NOT_AVAILABLE' || message === 'APPOINTMENT_CONFLICT' || message === 'PATIENT_APPOINTMENT_CONFLICT' || message === 'INVALID_DOCTOR') {
      return persist(repo, { tenantId, op, status: 'conflict', error: message });
    }
    throw error;
  }
}

async function applyEncounter(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const patientId = String(payload.patientId || '');
  const branchId = String(payload.branchId || '');
  if (isLocalRef(patientId) || isLocalRef(branchId) || isLocalRef(payload.appointmentId)) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const patient = await repo.getPatient(patientId);
  const branch = await repo.getBranch(branchId);
  if (!patient || !branch) return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  if (payload.appointmentId) {
    const appointment = await repo.getAppointment(String(payload.appointmentId));
    if (!appointment) return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const created = await repo.createEncounter({
    tenantId,
    branchId,
    patientId,
    appointmentId: payload.appointmentId ? String(payload.appointmentId) : undefined,
    doctorMemberId: payload.doctorMemberId ? String(payload.doctorMemberId) : undefined,
    reason: payload.reason ? String(payload.reason) : undefined,
    diagnosis: payload.diagnosis ? String(payload.diagnosis) : undefined,
    clinicalNotes: payload.clinicalNotes ? String(payload.clinicalNotes) : undefined,
  });
  return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
}

async function applyPrescription(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const encounterId = String(payload.encounterId || '');
  if (isLocalRef(encounterId) || isLocalRef(payload.patientId)) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const encounter = await repo.getEncounter(encounterId);
  if (!encounter) return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  const input: PrescriptionInput = {
    tenantId,
    encounterId,
    patientId: payload.patientId ? String(payload.patientId) : undefined,
    items: Array.isArray(payload.items) ? payload.items as PrescriptionInput['items'] : [],
    notes: payload.notes ? String(payload.notes) : undefined,
  };
  const created = await repo.createPrescription(input);
  return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
}

async function applyInvoice(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const patientId = String(payload.patientId || '');
  const branchId = String(payload.branchId || '');
  if (isLocalRef(patientId) || isLocalRef(branchId) || isLocalRef(payload.appointmentId) || isLocalRef(payload.encounterId)) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const patient = await repo.getPatient(patientId);
  const branch = await repo.getBranch(branchId);
  if (!patient || !branch) return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  const input: InvoiceInput = {
    tenantId,
    branchId,
    patientId,
    appointmentId: payload.appointmentId ? String(payload.appointmentId) : undefined,
    encounterId: payload.encounterId ? String(payload.encounterId) : undefined,
    lines: Array.isArray(payload.lines) ? payload.lines as InvoiceInput['lines'] : [],
  };
  const created = await repo.createInvoice(input);
  return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
}

async function applyDocument(repo: ClinicRepository, tenantId: string, op: SyncOperationInput, payload: Record<string, unknown>): Promise<SyncOperationResult> {
  const patientId = String(payload.patientId || '');
  if (isLocalRef(patientId) || isLocalRef(payload.encounterId)) {
    return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  }
  const patient = await repo.getPatient(patientId);
  if (!patient) return persist(repo, { tenantId, op, status: 'failed', error: 'DEPENDENCY_NOT_SYNCED' });
  const created = await repo.createPatientDocument({
    tenantId,
    patientId,
    encounterId: payload.encounterId ? String(payload.encounterId) : undefined,
    title: String(payload.title || 'Document'),
    documentType: (payload.documentType as 'report' | 'scan' | 'lab' | 'consent' | 'other') || 'other',
    fileUrl: payload.fileUrl ? String(payload.fileUrl) : undefined,
    notes: payload.notes ? String(payload.notes) : undefined,
  });
  return persist(repo, { tenantId, op, status: 'synced', serverId: created.id });
}

const HUMAN: Record<string, string> = {
  PATIENT_DUPLICATE_PHONE: 'A patient with this phone already exists',
  PATIENT_DUPLICATE_CODE: 'A patient with this code already exists',
  DOCTOR_NOT_AVAILABLE: 'Doctor is not available at this time',
  APPOINTMENT_CONFLICT: 'This overlaps an existing doctor appointment',
  PATIENT_APPOINTMENT_CONFLICT: 'This overlaps an existing patient appointment',
  DEPENDENCY_NOT_SYNCED: 'A related record has not synced yet',
};

export function syncResultMessage(error?: string): string | undefined {
  if (!error) return undefined;
  return HUMAN[error] || error;
}
