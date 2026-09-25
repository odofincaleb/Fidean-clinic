import pg from 'pg';
import type {
  Appointment,
  AuditLog,
  Branch,
  ClinicSettings,
  DoctorSchedule,
  Encounter,
  InventoryItem,
  InventoryBatch,
  InventoryMovement,
  Invoice,
  Member,
  MessageLog,
  NotificationJob,
  Patient,
  PatientAccount,
  PatientDocument,
  PaystackTransaction,
  Prescription,
  Referral,
  Role,
  Service,
  StaffMessage,
  Supplier,
  SyncOperationRecord,
  Tenant,
  TenantSnapshot,
} from '../domain/types.js';
import { applyInvoicePayment, assertScheduleWindow, finalizeInvoiceFields, toPublicPatientAccount, withInvoiceBalance } from '../domain/clinical.js';
import { assertAppointmentFits } from '../domain/appointmentGuard.js';
import { assertValidTransition } from '../domain/transitions.js';
import { httpError, notFound } from '../http/errors.js';
import { applyAppointmentFilters } from './appointmentFilters.js';
import { assertEncounterEditable, validateDoctorScheduleInput, validateEncounterInput } from './clinicalValidation.js';
import type {
  AppointmentInput,
  AppointmentListFilters,
  AuthUser,
  BranchInput,
  ClinicRepository,
  DoctorScheduleInput,
  EncounterInput,
  EncounterPatch,
  InventoryItemInput,
  InventoryMovementInput,
  SupplierInput,
  InvoiceInput,
  InvoicePatch,
  MemberInput,
  PatientDocumentInput,
  PatientInput,
  PrescriptionInput,
  PrescriptionPatch,
  ReferralInput,
  ServiceInput,
  StaffMessageInput,
  TenantInput,
} from './ClinicRepository.js';
import { seedCelonDemo } from './seedCelon.js';

const { Pool } = pg;

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function dateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function mapTenant(row: pg.QueryResultRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function mapBranch(row: pg.QueryResultRow): Branch {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    address: row.address ?? undefined,
    phone: row.phone ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function mapMember(row: pg.QueryResultRow): Member {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: String(row.email).toLowerCase(),
    displayName: row.display_name ?? undefined,
    role: row.role as Role,
    branchIds: (row.branch_ids ?? []).map(String),
    phone: row.phone ?? undefined,
    specialization: row.specialization ?? undefined,
    qualifications: row.qualifications ?? undefined,
    licenseNumber: row.license_number ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function mapPatient(row: pg.QueryResultRow): Patient {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientCode: row.patient_code,
    clinicPatientId: row.clinic_patient_id ?? undefined,
    firstName: row.first_name,
    lastName: row.last_name ?? undefined,
    phone: row.phone,
    email: row.email ?? undefined,
    altPhone: row.alt_phone ?? undefined,
    dob: row.dob ?? undefined,
    gender: row.gender ?? undefined,
    bloodGroup: row.blood_group ?? undefined,
    address: row.address ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    medicalHistory: row.medical_history ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapService(row: pg.QueryResultRow): Service {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id ?? undefined,
    name: row.name,
    durationMinutes: row.duration_minutes,
    priceKobo: row.price_kobo,
    currency: row.currency,
    active: row.active,
  };
}

function mapAppointment(row: pg.QueryResultRow): Appointment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    patientId: row.patient_id,
    doctorMemberId: row.doctor_member_id ?? undefined,
    serviceName: row.service_name,
    startsAt: iso(row.starts_at),
    status: row.status,
    notes: row.notes ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapSchedule(row: pg.QueryResultRow): DoctorSchedule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    doctorMemberId: row.doctor_member_id,
    weekday: row.weekday,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    slotMinutes: row.slot_minutes,
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

function mapEncounter(row: pg.QueryResultRow): Encounter {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    patientId: row.patient_id,
    appointmentId: row.appointment_id ?? undefined,
    doctorMemberId: row.doctor_member_id ?? undefined,
    status: row.status,
    reason: row.reason ?? undefined,
    diagnosis: row.diagnosis ?? undefined,
    clinicalNotes: row.clinical_notes ?? undefined,
    vitals: row.vitals ?? undefined,
    specialistData: row.specialist_data ?? undefined,
    startedAt: iso(row.started_at),
    signedAt: row.signed_at ? iso(row.signed_at) : undefined,
    createdAt: iso(row.created_at),
  };
}

function mapPrescription(row: pg.QueryResultRow): Prescription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    doctorMemberId: row.doctor_member_id ?? undefined,
    items: row.items ?? [],
    notes: row.notes ?? undefined,
    status: row.status,
    issuedAt: row.issued_at ? iso(row.issued_at) : undefined,
    createdAt: iso(row.created_at),
  };
}

function mapInvoice(row: pg.QueryResultRow): Invoice {
  return withInvoiceBalance({
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    patientId: row.patient_id,
    appointmentId: row.appointment_id ?? undefined,
    encounterId: row.encounter_id ?? undefined,
    invoiceNumber: row.invoice_number,
    lines: row.lines ?? [],
    subtotalKobo: row.subtotal_kobo,
    discountKobo: row.discount_kobo,
    taxKobo: row.tax_kobo,
    totalKobo: row.total_kobo,
    amountPaidKobo: row.amount_paid_kobo,
    hmoCoverageKobo: row.hmo_coverage_kobo ?? 0,
    hmoInsuranceId: row.hmo_insurance_id ?? undefined,
    currency: row.currency,
    status: row.status,
    issuedAt: row.issued_at ? iso(row.issued_at) : undefined,
    createdAt: iso(row.created_at),
    inventoryDeductions: row.inventory_deductions ?? undefined,
  });
}

function mapDocument(row: pg.QueryResultRow): PatientDocument {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientId: row.patient_id,
    encounterId: row.encounter_id ?? undefined,
    title: row.title,
    documentType: row.document_type,
    fileUrl: row.file_url ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapPatientAccount(row: pg.QueryResultRow): PatientAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientId: row.patient_id,
    email: String(row.email).toLowerCase(),
    passwordHash: row.password_hash ?? undefined,
    activationTokenHash: row.activation_token_hash ?? undefined,
    activationTokenExpiresAt: row.activation_token_expires_at ? iso(row.activation_token_expires_at) : undefined,
    activationTokenUsedAt: row.activation_token_used_at ? iso(row.activation_token_used_at) : undefined,
    passwordResetTokenHash: row.password_reset_token_hash ?? undefined,
    passwordResetTokenExpiresAt: row.password_reset_token_expires_at ? iso(row.password_reset_token_expires_at) : undefined,
    passwordResetTokenUsedAt: row.password_reset_token_used_at ? iso(row.password_reset_token_used_at) : undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    lastLoginAt: row.last_login_at ? iso(row.last_login_at) : undefined,
  };
}

function mapNotificationJob(row: pg.QueryResultRow): NotificationJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientId: row.patient_id ?? undefined,
    memberId: row.member_id ?? undefined,
    channel: row.channel,
    type: row.type,
    recipient: row.recipient,
    subject: row.subject ?? undefined,
    body: row.body,
    status: row.status,
    scheduledFor: row.scheduled_for ? iso(row.scheduled_for) : undefined,
    sentAt: row.sent_at ? iso(row.sent_at) : undefined,
    error: row.error ?? undefined,
    provider: row.provider ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapAuditLog(row: pg.QueryResultRow): AuditLog {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id ?? undefined,
    actorMemberId: row.actor_member_id ?? undefined,
    actorPatientAccountId: row.actor_patient_account_id ?? undefined,
    actorType: row.actor_type ?? undefined,
    action: row.action,
    objectType: row.object_type ?? undefined,
    objectId: row.object_id ?? undefined,
    details: row.details ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapSyncOperation(row: pg.QueryResultRow): SyncOperationRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientOperationId: row.client_operation_id,
    entityType: row.entity_type,
    operation: row.operation,
    status: row.status,
    serverObjectType: row.server_object_type ?? undefined,
    serverObjectId: row.server_object_id ?? undefined,
    error: row.error ?? undefined,
    payloadHash: row.payload_hash,
    createdAt: iso(row.created_at),
  };
}

function mapSettings(row: pg.QueryResultRow): ClinicSettings {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clinicName: row.clinic_name ?? '',
    clinicAddress: row.clinic_address ?? '',
    clinicLogoUrl: row.clinic_logo_url ?? '',
    brandPrimaryColor: row.brand_primary_color ?? '#66f2ea',
    brandAccentColor: row.brand_accent_color ?? '#3b82f6',
    notificationTemplates: row.notification_templates ?? {},
    paystackPublicKey: row.paystack_public_key ?? '',
    paystackSecretKey: row.paystack_secret_key ?? '',
    bankName: row.bank_name ?? '',
    bankAccountName: row.bank_account_name ?? '',
    bankAccountNumber: row.bank_account_number ?? '',
    smtpHost: row.smtp_host ?? '',
    smtpPort: row.smtp_port ?? 587,
    smtpUser: row.smtp_user ?? '',
    smtpPass: row.smtp_pass ?? '',
    smtpFromEmail: row.smtp_from_email ?? '',
    smtpFromName: row.smtp_from_name ?? '',
      bankTransferEnabled: row.bank_transfer_enabled ?? true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapPaystackTx(row: pg.QueryResultRow): PaystackTransaction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    invoiceId: row.invoice_id ?? undefined,
    reference: row.reference,
    amountKobo: row.amount_kobo,
    status: row.status,
    channel: row.channel ?? undefined,
    paidAt: row.paid_at ? iso(row.paid_at) : undefined,
    verifiedAt: row.verified_at ? iso(row.verified_at) : undefined,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function mapHmo(row: pg.QueryResultRow): HmoInsurance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientId: row.patient_id,
    hmoName: row.hmo_name,
    hmoNumber: row.hmo_number || undefined,
    coverageType: row.coverage_type,
    coverageValue: Number(row.coverage_value),
    active: row.active,
    createdAt: iso(row.created_at),
  };
}

function mapMessageLog(row: pg.QueryResultRow): MessageLog {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject ?? undefined,
    body: row.body,
    status: row.status,
    provider: row.provider ?? undefined,
    providerMessageId: row.provider_message_id ?? undefined,
    sentAt: row.sent_at ? iso(row.sent_at) : undefined,
    error: row.error ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapReferral(row: pg.QueryResultRow): Referral {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    encounterId: row.encounter_id,
    patientId: row.patient_id,
    fromDoctorMemberId: row.from_doctor_member_id ?? undefined,
    toDoctorMemberId: row.to_doctor_member_id ?? undefined,
    referralType: row.referral_type,
    specialty: row.specialty ?? undefined,
    externalClinicName: row.external_clinic_name ?? undefined,
    externalClinicContact: row.external_clinic_contact ?? undefined,
    reason: row.reason,
    notes: row.notes ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapStaffMessage(row: pg.QueryResultRow): StaffMessage {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    senderMemberId: row.sender_member_id,
    recipientMemberId: row.recipient_member_id,
    patientId: row.patient_id ?? undefined,
    encounterId: row.encounter_id ?? undefined,
    referralId: row.referral_id ?? undefined,
    subject: row.subject ?? undefined,
    body: row.body,
    readAt: row.read_at ? iso(row.read_at) : undefined,
    createdAt: iso(row.created_at),
  };
}

function mapInventoryItem(row: pg.QueryResultRow): InventoryItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    sku: row.sku ?? undefined,
    category: row.category ?? undefined,
    unit: row.unit ?? undefined,
    currentStock: row.current_stock,
    reorderLevel: row.reorder_level,
    unitCostKobo: row.unit_cost_kobo,
    sellingPriceKobo: row.selling_price_kobo ?? 0,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapInventoryMovement(row: pg.QueryResultRow): InventoryMovement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    itemId: row.item_id,
    batchId: row.batch_id ?? undefined,
    supplierId: row.supplier_id ?? undefined,
    movementType: row.movement_type,
    quantity: row.quantity,
    reference: row.reference ?? undefined,
    reason: row.reason ?? undefined,
    notes: row.notes ?? undefined,
    previousQuantity: row.previous_quantity ?? undefined,
    newQuantity: row.new_quantity ?? undefined,
    costPriceKobo: row.cost_price_kobo ?? undefined,
    batchNumber: row.batch_number ?? undefined,
    expiryDate: row.expiry_date ? dateOnly(row.expiry_date) : undefined,
    createdByMemberId: row.created_by_member_id ?? undefined,
    createdAt: iso(row.created_at),
  };
}

function mapInventoryBatch(row: pg.QueryResultRow): InventoryBatch {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    itemId: row.item_id,
    supplierId: row.supplier_id ?? undefined,
    batchNumber: row.batch_number ?? undefined,
    expiryDate: row.expiry_date ? dateOnly(row.expiry_date) : undefined,
    quantityRemaining: row.quantity_remaining,
    costPriceKobo: row.cost_price_kobo,
    receivedAt: iso(row.received_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapSupplier(row: pg.QueryResultRow): Supplier {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresClinicRepository implements ClinicRepository {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  storageMode(): 'postgres' | 'memory' {
    return 'postgres';
  }

  async listTenants(): Promise<Tenant[]> {
    const result = await this.pool.query('SELECT * FROM tenants ORDER BY created_at');
    return result.rows.map(mapTenant);
  }

  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    const result = await this.pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    return result.rows[0] ? mapTenant(result.rows[0]) : undefined;
  }

  async createTenant(input: TenantInput): Promise<Tenant> {
    const result = await this.pool.query(
      'INSERT INTO tenants (name, slug, status) VALUES ($1, $2, $3) RETURNING *',
      [input.name, input.slug, 'trial'],
    );
    return mapTenant(result.rows[0]);
  }

  async updateTenant(tenantId: string, patch: Partial<Pick<Tenant, 'name' | 'status' | 'slug'>>): Promise<Tenant> {
    const current = await this.getTenant(tenantId);
    if (!current) throw notFound('TENANT_NOT_FOUND');
    const result = await this.pool.query(
      'UPDATE tenants SET name = $2, status = $3, slug = $4, updated_at = now() WHERE id = $1 RETURNING *',
      [tenantId, patch.name ?? current.name, patch.status ?? current.status, patch.slug ?? current.slug],
    );
    return mapTenant(result.rows[0]);
  }

  async listBranches(tenantId: string): Promise<Branch[]> {
    const result = await this.pool.query('SELECT * FROM branches WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapBranch);
  }

  async getBranch(branchId: string): Promise<Branch | undefined> {
    const result = await this.pool.query('SELECT * FROM branches WHERE id = $1', [branchId]);
    return result.rows[0] ? mapBranch(result.rows[0]) : undefined;
  }

  async createBranch(input: BranchInput): Promise<Branch> {
    const tenant = await this.getTenant(input.tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    const result = await this.pool.query(
      'INSERT INTO branches (tenant_id, name, address, phone, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [input.tenantId, input.name, input.address ?? null, input.phone ?? null, 'active'],
    );
    return mapBranch(result.rows[0]);
  }

  async updateBranch(branchId: string, patch: Partial<Pick<Branch, 'name' | 'address' | 'phone' | 'status'>>): Promise<Branch> {
    const current = await this.getBranch(branchId);
    if (!current) throw notFound('BRANCH_NOT_FOUND');
    const result = await this.pool.query(
      'UPDATE branches SET name = $2, address = $3, phone = $4, status = $5, updated_at = now() WHERE id = $1 RETURNING *',
      [branchId, patch.name ?? current.name, patch.address ?? current.address ?? null, patch.phone ?? current.phone ?? null, patch.status ?? current.status],
    );
    return mapBranch(result.rows[0]);
  }

  async deleteBranch(branchId: string): Promise<void> {
    const current = await this.getBranch(branchId);
    if (!current) throw notFound('BRANCH_NOT_FOUND');
    await this.pool.query('DELETE FROM branches WHERE id = $1', [branchId]);
  }

  async listMembers(tenantId: string): Promise<Member[]> {
    const result = await this.pool.query('SELECT * FROM tenant_memberships WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapMember);
  }

  async updateMember(memberId: string, patch: any): Promise<Member> {
    const sets: string[] = []; const params: any[] = []; let idx = 1;
    for (const [col, val] of Object.entries({ display_name: patch.displayName, role: patch.role, phone: patch.phone, specialization: patch.specialization })) {
      if (val !== undefined) { sets.push(`${col} = $${idx}`); params.push(val); idx++; }
    }
    if (!sets.length) throw new Error('NO_FIELDS');
    params.push(memberId);
    const r = await this.pool.query(`UPDATE tenant_memberships SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return mapMember(r.rows[0]);
  }
  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  }
  async deleteMember(memberId: string): Promise<void> {
    await this.pool.query('DELETE FROM tenant_memberships WHERE id = $1', [memberId]);
  }

  async getMember(memberId: string): Promise<Member | undefined> {
    const result = await this.pool.query('SELECT * FROM tenant_memberships WHERE id = $1', [memberId]);
    return result.rows[0] ? mapMember(result.rows[0]) : undefined;
  }

  async addMember(input: MemberInput): Promise<Member> {
    const tenant = await this.getTenant(input.tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    const result = await this.pool.query(
      `INSERT INTO tenant_memberships (tenant_id, email, role, branch_ids, status, display_name, phone, specialization, qualifications, license_number)
       VALUES ($1, $2, $3, $4::uuid[], $5, $6, $7, $8, $9, $10) RETURNING *`,
      [input.tenantId, input.email.toLowerCase(), input.role, input.branchIds ?? [], 'active', input.displayName ?? null, input.phone ?? null, input.specialization ?? null, input.qualifications ?? null, input.licenseNumber ?? null],
    );
    return mapMember(result.rows[0]);
  }

  async updateMember(memberId: string, patch: Partial<Pick<Member, 'displayName' | 'role' | 'branchIds' | 'status' | 'phone' | 'specialization' | 'qualifications' | 'licenseNumber'>>): Promise<Member> {
    const current = await this.getMember(memberId);
    if (!current) throw notFound('MEMBER_NOT_FOUND');
    const result = await this.pool.query(
      `UPDATE tenant_memberships
       SET display_name = $2, role = $3, branch_ids = $4::uuid[], status = $5, phone = $6, specialization = $7, qualifications = $8, license_number = $9
       WHERE id = $1 RETURNING *`,
      [memberId, patch.displayName ?? current.displayName ?? null, patch.role ?? current.role, patch.branchIds ?? current.branchIds, patch.status ?? current.status, patch.phone ?? current.phone ?? null, patch.specialization ?? current.specialization ?? null, patch.qualifications ?? current.qualifications ?? null, patch.licenseNumber ?? current.licenseNumber ?? null],
    );
    return mapMember(result.rows[0]);
  }

  async listPatients(tenantId: string): Promise<Patient[]> {
    const result = await this.pool.query('SELECT * FROM patients WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapPatient);
  }

  async getPatient(patientId: string): Promise<Patient | undefined> {
    const result = await this.pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    return result.rows[0] ? mapPatient(result.rows[0]) : undefined;
  }

  async createPatient(input: PatientInput): Promise<Patient> {
    const tenant = await this.getTenant(input.tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    const result = await this.pool.query(
      `INSERT INTO patients (tenant_id, patient_code, clinic_patient_id, first_name, last_name, phone, email, alt_phone, dob, gender, blood_group, address, city, state, medical_history)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [input.tenantId, `PAT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, input.clinicPatientId ?? null, input.firstName, input.lastName ?? null, input.phone, input.email?.toLowerCase() ?? null, input.altPhone ?? null, input.dob ?? null, input.gender ?? null, input.bloodGroup ?? null, input.address ?? null, input.city ?? null, input.state ?? null, input.medicalHistory ?? null],
    );
    return mapPatient(result.rows[0]);
  }

  async updatePatient(patientId: string, patch: Partial<Pick<Patient, 'clinicPatientId' | 'firstName' | 'lastName' | 'phone' | 'email' | 'altPhone' | 'dob' | 'gender' | 'bloodGroup' | 'address' | 'city' | 'state' | 'medicalHistory'>>): Promise<Patient> {
    const current = await this.getPatient(patientId);
    if (!current) throw notFound('PATIENT_NOT_FOUND');
    const result = await this.pool.query(
      `UPDATE patients SET clinic_patient_id = $2, first_name = $3, last_name = $4, phone = $5, email = $6, alt_phone = $7, dob = $8, gender = $9, blood_group = $10, address = $11, city = $12, state = $13, medical_history = $14, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [patientId, patch.clinicPatientId ?? current.clinicPatientId ?? null, patch.firstName ?? current.firstName, patch.lastName ?? current.lastName ?? null, patch.phone ?? current.phone, patch.email ?? current.email ?? null, patch.altPhone ?? current.altPhone ?? null, patch.dob ?? current.dob ?? null, patch.gender ?? current.gender ?? null, patch.bloodGroup ?? current.bloodGroup ?? null, patch.address ?? current.address ?? null, patch.city ?? current.city ?? null, patch.state ?? current.state ?? null, patch.medicalHistory ?? current.medicalHistory ?? null],
    );
    return mapPatient(result.rows[0]);
  }

  async listServices(tenantId: string): Promise<Service[]> {
    const result = await this.pool.query('SELECT * FROM services WHERE tenant_id = $1 ORDER BY name', [tenantId]);
    return result.rows.map(mapService);
  }

  async getService(serviceId: string): Promise<Service | undefined> {
    const result = await this.pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    return result.rows[0] ? mapService(result.rows[0]) : undefined;
  }

  async createService(input: ServiceInput): Promise<Service> {
    const tenant = await this.getTenant(input.tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    const result = await this.pool.query(
      `INSERT INTO services (tenant_id, branch_id, name, duration_minutes, price_kobo, currency, active)
       VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING *`,
      [input.tenantId, input.branchId ?? null, input.name, input.durationMinutes ?? 30, input.priceKobo ?? 0, input.currency ?? 'NGN'],
    );
    return mapService(result.rows[0]);
  }

  async updateService(
    serviceId: string,
    patch: Partial<Pick<Service, 'name' | 'durationMinutes' | 'priceKobo' | 'currency' | 'active' | 'branchId'>>,
  ): Promise<Service> {
    const current = await this.getService(serviceId);
    if (!current) throw notFound('SERVICE_NOT_FOUND');
    const result = await this.pool.query(
      `UPDATE services SET name = $2, duration_minutes = $3, price_kobo = $4, currency = $5, active = $6, branch_id = $7
       WHERE id = $1 RETURNING *`,
      [
        serviceId,
        patch.name ?? current.name,
        patch.durationMinutes ?? current.durationMinutes,
        patch.priceKobo ?? current.priceKobo,
        patch.currency ?? current.currency,
        patch.active ?? current.active,
        patch.branchId ?? current.branchId ?? null,
      ],
    );
    return mapService(result.rows[0]);
  }

  async listHmoInsurances(tenantId: string, patientId?: string): Promise<HmoInsurance[]> {
    const rows = await this.pool.query('SELECT * FROM hmo_insurances WHERE tenant_id = $1' + (patientId ? ' AND patient_id = $2' : '') + ' ORDER BY created_at DESC', patientId ? [tenantId, patientId] : [tenantId]);
    return rows.rows.map(mapHmo);
  }
  async getHmoInsurance(id: string): Promise<HmoInsurance | undefined> {
    const rows = await this.pool.query('SELECT * FROM hmo_insurances WHERE id = $1', [id]);
    return rows.rows[0] ? mapHmo(rows.rows[0]) : undefined;
  }
  async createHmoInsurance(input: any): Promise<HmoInsurance> {
    const rows = await this.pool.query('INSERT INTO hmo_insurances (tenant_id, patient_id, hmo_name, hmo_number, coverage_type, coverage_value, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [input.tenantId, input.patientId, input.hmoName, input.hmoNumber || '', input.coverageType, input.coverageValue, input.active ?? true]);
    return mapHmo(rows.rows[0]);
  }
  async deleteHmoInsurance(id: string): Promise<void> {
    await this.pool.query('DELETE FROM hmo_insurances WHERE id = $1', [id]);
  }

  async updateHmoInsurance(id: string, patch: any): Promise<HmoInsurance> {
    const sets: string[] = []; const params: any[] = []; let idx = 1;
    for (const [col, val] of Object.entries({ hmo_name: patch.hmoName, hmo_number: patch.hmoNumber, coverage_type: patch.coverageType, coverage_value: patch.coverageValue, active: patch.active })) {
      if (val !== undefined) { sets.push(`${col} = $${idx}`); params.push(val); idx++; }
    }
    if (!sets.length) throw new Error('NO_FIELDS');
    params.push(id);
    const rows = await this.pool.query(`UPDATE hmo_insurances SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return mapHmo(rows.rows[0]);
  }

  async listAppointments(tenantId: string, filters?: AppointmentListFilters): Promise<Appointment[]> {
    const result = await this.pool.query('SELECT * FROM appointments WHERE tenant_id = $1 ORDER BY starts_at', [tenantId]);
    return applyAppointmentFilters(result.rows.map(mapAppointment), filters);
  }

  async getAppointment(appointmentId: string): Promise<Appointment | undefined> {
    const result = await this.pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
    return result.rows[0] ? mapAppointment(result.rows[0]) : undefined;
  }

  async createAppointment(input: AppointmentInput): Promise<Appointment> {
    const tenant = await this.getTenant(input.tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    const branch = await this.getBranch(input.branchId);
    if (!branch) throw notFound('BRANCH_NOT_FOUND');
    const patient = await this.getPatient(input.patientId);
    if (!patient) throw notFound('PATIENT_NOT_FOUND');
    await assertAppointmentFits(this, input);
    const result = await this.pool.query(
      `INSERT INTO appointments (tenant_id, branch_id, patient_id, doctor_member_id, service_name, starts_at, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7) RETURNING *`,
      [input.tenantId, input.branchId, input.patientId, input.doctorMemberId ?? null, input.serviceName, input.startsAt, input.notes ?? null],
    );
    return mapAppointment(result.rows[0]);
  }

  async updateAppointment(
    appointmentId: string,
    patch: Partial<Pick<Appointment, 'startsAt' | 'serviceName' | 'doctorMemberId' | 'notes'>>,
  ): Promise<Appointment> {
    const current = await this.getAppointment(appointmentId);
    if (!current) throw notFound('APPOINTMENT_NOT_FOUND');
    await assertAppointmentFits(this, {
      tenantId: current.tenantId,
      branchId: current.branchId,
      patientId: current.patientId,
      startsAt: patch.startsAt ?? current.startsAt,
      serviceName: patch.serviceName ?? current.serviceName,
      doctorMemberId: patch.doctorMemberId ?? current.doctorMemberId,
      notes: patch.notes ?? current.notes,
    }, appointmentId);
    const result = await this.pool.query(
      `UPDATE appointments
       SET starts_at = $2, service_name = $3, doctor_member_id = $4, notes = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [appointmentId, patch.startsAt ?? current.startsAt, patch.serviceName ?? current.serviceName, patch.doctorMemberId ?? current.doctorMemberId ?? null, patch.notes ?? current.notes ?? null],
    );
    return mapAppointment(result.rows[0]);
  }

  async transitionAppointment(appointmentId: string, status: Appointment['status']): Promise<Appointment> {
    const current = await this.getAppointment(appointmentId);
    if (!current) throw notFound('APPOINTMENT_NOT_FOUND');
    assertValidTransition(current.status, status);
    const result = await this.pool.query(
      'UPDATE appointments SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [appointmentId, status],
    );
    return mapAppointment(result.rows[0]);
  }

  async visibleBranchesForMember(memberId: string): Promise<Branch[]> {
    const member = await this.getMember(memberId);
    if (!member) throw notFound('MEMBER_NOT_FOUND');
    const all = await this.listBranches(member.tenantId);
    if (member.role === 'owner' || member.role === 'admin' || member.branchIds.length === 0) return all;
    return all.filter((branch) => member.branchIds.includes(branch.id));
  }

  async getTenantSnapshot(tenantId: string): Promise<TenantSnapshot> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw notFound('TENANT_NOT_FOUND');
    return {
      tenant,
      settings: await this.getSettings(tenantId).catch(() => ({})),
      branches: await this.listBranches(tenantId),
      members: await this.listMembers(tenantId),
      patients: await this.listPatients(tenantId),
      services: await this.listServices(tenantId),
      appointments: await this.listAppointments(tenantId),
      doctorSchedules: await this.listDoctorSchedules(tenantId),
      encounters: await this.listEncounters(tenantId),
      prescriptions: await this.listPrescriptions(tenantId),
      invoices: await this.listInvoices(tenantId),
      patientDocuments: await this.listPatientDocuments(tenantId),
      patientAccounts: (await this.listPatientAccounts(tenantId)).map(toPublicPatientAccount),
      notificationJobs: await this.listNotificationJobs(tenantId),
      auditLogs: await this.listAuditLogs(tenantId),
      referrals: await this.listReferrals(tenantId),
      staffMessages: await this.listStaffMessages(tenantId, ''),
      inventoryItems: await this.listInventoryItems(tenantId),
      inventoryBatches: await this.listInventoryBatches(tenantId),
      inventoryMovements: await this.listInventoryMovements(tenantId),
      suppliers: await this.listSuppliers(tenantId),
      offlineSync: true,
    };
  }

  async seedCelonDemo(): Promise<TenantSnapshot> {
    return seedCelonDemo(this);
  }

  async findUserByEmail(email: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query('SELECT id, email, password_hash, display_name FROM users WHERE email = $1', [email.toLowerCase()]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      email: String(row.email).toLowerCase(),
      passwordHash: row.password_hash,
      displayName: row.display_name ?? undefined,
    };
  }

  async createUser(input: { email: string; passwordHash: string; displayName?: string }): Promise<{ id: string; email: string }> {
    const result = await this.pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email',
      [input.email.toLowerCase(), input.passwordHash, input.displayName ?? null],
    );
    return { id: result.rows[0].id, email: String(result.rows[0].email).toLowerCase() };
  }

  async findActiveMembershipByUserId(userId: string): Promise<Member | undefined> {
    const result = await this.pool.query(
      `SELECT * FROM tenant_memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapMember(result.rows[0]) : undefined;
  }

  async findMembershipByEmail(tenantId: string, email: string): Promise<Member | undefined> {
    const result = await this.pool.query('SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND email = $2', [tenantId, email.toLowerCase()]);
    return result.rows[0] ? mapMember(result.rows[0]) : undefined;
  }

  async linkUserToMembership(membershipId: string, userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE tenant_memberships SET user_id = $1, status = 'active', accepted_at = now() WHERE id = $2`,
      [userId, membershipId],
    );
  }

  async listDoctorSchedules(tenantId: string, filters?: { branchId?: string; doctorMemberId?: string }): Promise<DoctorSchedule[]> {
    const result = await this.pool.query('SELECT * FROM doctor_schedules WHERE tenant_id = $1 ORDER BY weekday, starts_at', [tenantId]);
    return result.rows.map(mapSchedule).filter((item) => {
      if (filters?.branchId && item.branchId !== filters.branchId) return false;
      if (filters?.doctorMemberId && item.doctorMemberId !== filters.doctorMemberId) return false;
      return true;
    });
  }

  async getDoctorSchedule(scheduleId: string): Promise<DoctorSchedule | undefined> {
    const result = await this.pool.query('SELECT * FROM doctor_schedules WHERE id = $1', [scheduleId]);
    return result.rows[0] ? mapSchedule(result.rows[0]) : undefined;
  }

  async createDoctorSchedule(input: DoctorScheduleInput): Promise<DoctorSchedule> {
    validateDoctorScheduleInput(input, Boolean(await this.getTenant(input.tenantId)), await this.getBranch(input.branchId), await this.getMember(input.doctorMemberId));
    const result = await this.pool.query(
      `INSERT INTO doctor_schedules (tenant_id, branch_id, doctor_member_id, weekday, starts_at, ends_at, slot_minutes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [input.tenantId, input.branchId, input.doctorMemberId, input.weekday, input.startsAt, input.endsAt, input.slotMinutes ?? 30],
    );
    return mapSchedule(result.rows[0]);
  }

  async updateDoctorSchedule(
    scheduleId: string,
    patch: Partial<Pick<DoctorSchedule, 'startsAt' | 'endsAt' | 'slotMinutes' | 'active'>>,
  ): Promise<DoctorSchedule> {
    const current = await this.getDoctorSchedule(scheduleId);
    if (!current) throw notFound('SCHEDULE_NOT_FOUND');
    const next = { ...current, ...patch };
    assertScheduleWindow(next.startsAt, next.endsAt, next.slotMinutes);
    const result = await this.pool.query(
      `UPDATE doctor_schedules SET starts_at=$2, ends_at=$3, slot_minutes=$4, active=$5 WHERE id=$1 RETURNING *`,
      [scheduleId, next.startsAt, next.endsAt, next.slotMinutes, next.active],
    );
    return mapSchedule(result.rows[0]);
  }

  async deleteDoctorSchedule(scheduleId: string): Promise<void> {
    const current = await this.getDoctorSchedule(scheduleId);
    if (!current) throw notFound('SCHEDULE_NOT_FOUND');
    await this.pool.query('DELETE FROM doctor_schedules WHERE id = $1', [scheduleId]);
  }

  async listEncounters(tenantId: string, filters?: { patientId?: string; branchId?: string; appointmentId?: string }): Promise<Encounter[]> {
    const result = await this.pool.query('SELECT * FROM encounters WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapEncounter).filter((item) => {
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.branchId && item.branchId !== filters.branchId) return false;
      if (filters?.appointmentId && item.appointmentId !== filters.appointmentId) return false;
      return true;
    });
  }

  async getEncounter(encounterId: string): Promise<Encounter | undefined> {
    const result = await this.pool.query('SELECT * FROM encounters WHERE id = $1', [encounterId]);
    return result.rows[0] ? mapEncounter(result.rows[0]) : undefined;
  }

  async createEncounter(input: EncounterInput): Promise<Encounter> {
    validateEncounterInput(
      input,
      Boolean(await this.getTenant(input.tenantId)),
      await this.getBranch(input.branchId),
      await this.getPatient(input.patientId),
      input.appointmentId ? await this.getAppointment(input.appointmentId) : undefined,
    );
    const result = await this.pool.query(
      `INSERT INTO encounters (tenant_id, branch_id, patient_id, appointment_id, doctor_member_id, status, reason, diagnosis, clinical_notes, vitals, specialist_data, started_at)
       VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8,$9,$10,now()) RETURNING *`,
      [input.tenantId, input.branchId, input.patientId, input.appointmentId ?? null, input.doctorMemberId ?? null, input.reason ?? null, input.diagnosis ?? null, input.clinicalNotes ?? null, input.vitals ? JSON.stringify(input.vitals) : null, input.specialistData ? JSON.stringify(input.specialistData) : null],
    );
    return mapEncounter(result.rows[0]);
  }

  async updateEncounter(encounterId: string, patch: EncounterPatch): Promise<Encounter> {
    const current = await this.getEncounter(encounterId);
    if (!current) throw notFound('ENCOUNTER_NOT_FOUND');
    assertEncounterEditable(current);
    const next = { ...current, ...patch, status: current.status };
    const result = await this.pool.query(
      `UPDATE encounters SET reason=$2, diagnosis=$3, clinical_notes=$4, vitals=$5, doctor_member_id=$6, specialist_data=$7 WHERE id=$1 RETURNING *`,
      [encounterId, next.reason ?? null, next.diagnosis ?? null, next.clinicalNotes ?? null, next.vitals ? JSON.stringify(next.vitals) : null, next.doctorMemberId ?? null, next.specialistData ? JSON.stringify(next.specialistData) : null],
    );
    return mapEncounter(result.rows[0]);
  }

  async signEncounter(encounterId: string): Promise<Encounter> {
    const current = await this.getEncounter(encounterId);
    if (!current) throw notFound('ENCOUNTER_NOT_FOUND');
    assertEncounterEditable(current);
    const result = await this.pool.query(
      `UPDATE encounters SET status='signed', signed_at=now() WHERE id=$1 RETURNING *`,
      [encounterId],
    );
    return mapEncounter(result.rows[0]);
  }

  async deleteEncounter(encounterId: string): Promise<void> {
    const current = await this.getEncounter(encounterId);
    if (!current) throw notFound('ENCOUNTER_NOT_FOUND');
    await this.pool.query('DELETE FROM encounters WHERE id=$1', [encounterId]);
  }

  async listPrescriptions(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<Prescription[]> {
    const result = await this.pool.query('SELECT * FROM prescriptions WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapPrescription).filter((item) => {
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      return true;
    });
  }

  async getPrescription(prescriptionId: string): Promise<Prescription | undefined> {
    const result = await this.pool.query('SELECT * FROM prescriptions WHERE id = $1', [prescriptionId]);
    return result.rows[0] ? mapPrescription(result.rows[0]) : undefined;
  }

  async createPrescription(input: PrescriptionInput): Promise<Prescription> {
    if (!input.items.length || input.items.some((item) => !item.medication?.trim())) throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    let patientId = input.patientId;
    let doctorMemberId = input.doctorMemberId;
    let encounterId: string | undefined = input.encounterId;
    if (input.encounterId) {
      const encounter = await this.getEncounter(input.encounterId);
      if (!encounter) throw notFound('ENCOUNTER_NOT_FOUND');
      if (encounter.tenantId !== input.tenantId) throw httpError('FORBIDDEN', 403);
      encounterId = encounter.id;
      if (!patientId) patientId = encounter.patientId;
      if (!doctorMemberId) doctorMemberId = encounter.doctorMemberId;
    }
    if (!patientId) throw httpError('PATIENT_ID_REQUIRED', 400);
    const result = await this.pool.query(
      `INSERT INTO prescriptions (tenant_id, encounter_id, patient_id, doctor_member_id, items, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'draft') RETURNING *`,
      [input.tenantId, encounterId ?? '', patientId, doctorMemberId ?? null, JSON.stringify(input.items), input.notes ?? null],
    );
    return mapPrescription(result.rows[0]);
  }

  async updatePrescription(prescriptionId: string, patch: PrescriptionPatch): Promise<Prescription> {
    const current = await this.getPrescription(prescriptionId);
    if (!current) throw notFound('PRESCRIPTION_NOT_FOUND');
    if (current.status !== 'draft') throw httpError('PRESCRIPTION_NOT_DRAFT', 409);
    if (patch.items && (!patch.items.length || patch.items.some((item) => !item.medication?.trim()))) {
      throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    }
    const next = { ...current, ...patch };
    const result = await this.pool.query(
      `UPDATE prescriptions SET items=$2, notes=$3, doctor_member_id=$4 WHERE id=$1 RETURNING *`,
      [prescriptionId, JSON.stringify(next.items), next.notes ?? null, next.doctorMemberId ?? null],
    );
    return mapPrescription(result.rows[0]);
  }

  async issuePrescription(prescriptionId: string): Promise<Prescription> {
    const current = await this.getPrescription(prescriptionId);
    if (!current) throw notFound('PRESCRIPTION_NOT_FOUND');
    if (current.status !== 'draft') throw httpError('PRESCRIPTION_NOT_DRAFT', 409);
    if (!current.items.length) throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    const result = await this.pool.query(
      `UPDATE prescriptions SET status='issued', issued_at=now() WHERE id=$1 RETURNING *`,
      [prescriptionId],
    );
    return mapPrescription(result.rows[0]);
  }

  async listInvoices(tenantId: string, filters?: { patientId?: string; status?: Invoice['status'] }): Promise<Invoice[]> {
    const result = await this.pool.query('SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapInvoice).filter((item) => {
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.status && item.status !== filters.status) return false;
      return true;
    });
  }

  async getInvoice(invoiceId: string): Promise<Invoice | undefined> {
    const result = await this.pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    return result.rows[0] ? mapInvoice(result.rows[0]) : undefined;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    if (!(await this.getTenant(input.tenantId))) throw notFound('TENANT_NOT_FOUND');
    const branch = await this.getBranch(input.branchId);
    if (!branch || branch.tenantId !== input.tenantId) throw notFound('BRANCH_NOT_FOUND');
    const patient = await this.getPatient(input.patientId);
    if (!patient || patient.tenantId !== input.tenantId) throw notFound('PATIENT_NOT_FOUND');
    const totals = finalizeInvoiceFields({ lines: input.lines, discountKobo: input.discountKobo, taxKobo: input.taxKobo });
    const invoiceNumber = `INV-${Date.now().toString(36).toUpperCase()}`;
    // Deduct inventory stock for any lines with inventoryItemId
    const inventoryDeductions: { itemId: string; name: string; quantity: number; unitPriceKobo: number }[] = [];
    const inventoryItems = await this.listInventoryItems(input.tenantId);
    for (const line of input.lines.filter(l => l.inventoryItemId)) {
      const item = inventoryItems.find(i => i.id === line.inventoryItemId);
      if (!item) throw notFound(`INVENTORY_ITEM_NOT_FOUND: ${line.inventoryItemId}`);
      if (item.currentStock < line.quantity) {
        throw httpError(`INSUFFICIENT_STOCK for ${item.name}: have ${item.currentStock}, need ${line.quantity}`, 409);
      }
      await this.recordInventoryMovement(line.inventoryItemId, {
        tenantId: input.tenantId,
        movementType: 'dispense',
        quantity: line.quantity,
        reference: invoiceNumber,
        notes: `Dispensed for invoice ${invoiceNumber}`,
      });
      inventoryDeductions.push({ itemId: item.id, name: item.name, quantity: line.quantity, unitPriceKobo: line.unitPriceKobo });
    }
    const result = await this.pool.query(
      `INSERT INTO invoices (tenant_id, branch_id, patient_id, appointment_id, encounter_id, invoice_number, lines, subtotal_kobo, discount_kobo, tax_kobo, total_kobo, amount_paid_kobo, hmo_coverage_kobo, hmo_insurance_id, currency, status, inventory_deductions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [input.tenantId, input.branchId, input.patientId, input.appointmentId ?? null, input.encounterId ?? null, invoiceNumber, JSON.stringify(input.lines), totals.subtotalKobo, totals.discountKobo, totals.taxKobo, totals.totalKobo, totals.amountPaidKobo, input.hmoCoverageKobo ?? 0, input.hmoInsuranceId ?? null, input.currency ?? 'NGN', totals.status, JSON.stringify(inventoryDeductions)],
    );
    return mapInvoice(result.rows[0]);
  }

  async updateInvoice(invoiceId: string, patch: InvoicePatch): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);
    if (!current) throw notFound('INVOICE_NOT_FOUND');
    if (current.status === 'void' || current.status === 'paid') throw httpError('INVOICE_LOCKED', 409);
    const lines = patch.lines ?? current.lines;
    const issuedAt = patch.issuedAt ?? current.issuedAt;
    const totals = finalizeInvoiceFields({
      lines,
      discountKobo: patch.discountKobo ?? current.discountKobo,
      taxKobo: patch.taxKobo ?? current.taxKobo,
      amountPaidKobo: current.amountPaidKobo,
      issuedAt,
    });
    const hmoCoverageKobo = patch.hmoCoverageKobo ?? current.hmoCoverageKobo ?? 0;
    const hmoInsuranceId = patch.hmoInsuranceId ?? current.hmoInsuranceId ?? null;
    const result = await this.pool.query(
      `UPDATE invoices SET lines=$2, subtotal_kobo=$3, discount_kobo=$4, tax_kobo=$5, total_kobo=$6, amount_paid_kobo=$7, status=$8, issued_at=$9, hmo_coverage_kobo=$10, hmo_insurance_id=$11 WHERE id=$1 RETURNING *`,
      [invoiceId, JSON.stringify(lines), totals.subtotalKobo, totals.discountKobo, totals.taxKobo, totals.totalKobo, totals.amountPaidKobo, totals.status, issuedAt ?? null, hmoCoverageKobo, hmoInsuranceId],
    );
    return mapInvoice(result.rows[0]);
  }

  async issueInvoice(invoiceId: string): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);
    if (!current) throw notFound('INVOICE_NOT_FOUND');
    if (current.status === 'void') throw httpError('INVOICE_VOID', 409);
    if (current.status !== 'draft') throw httpError('INVOICE_ALREADY_ISSUED', 409);
    const issuedAt = new Date().toISOString();
    const totals = finalizeInvoiceFields({
      lines: current.lines,
      discountKobo: current.discountKobo,
      taxKobo: current.taxKobo,
      amountPaidKobo: current.amountPaidKobo,
      issuedAt,
    });
    const result = await this.pool.query(
      `UPDATE invoices SET amount_paid_kobo=$2, status=$3, issued_at=$4 WHERE id=$1 RETURNING *`,
      [invoiceId, totals.amountPaidKobo, totals.status, issuedAt],
    );
    return mapInvoice(result.rows[0]);
  }

  async recordInvoicePayment(invoiceId: string, amountKobo: number): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);
    if (!current) throw notFound('INVOICE_NOT_FOUND');
    const next = applyInvoicePayment(current, amountKobo);
    const result = await this.pool.query(
      `UPDATE invoices SET amount_paid_kobo=$2, status=$3, issued_at=$4 WHERE id=$1 RETURNING *`,
      [invoiceId, next.amountPaidKobo, next.status, next.issuedAt],
    );
    return mapInvoice(result.rows[0]);
  }

  async voidInvoice(invoiceId: string): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);
    if (!current) throw notFound('INVOICE_NOT_FOUND');
    const totals = finalizeInvoiceFields({
      lines: current.lines,
      discountKobo: current.discountKobo,
      taxKobo: current.taxKobo,
      amountPaidKobo: current.amountPaidKobo,
      issuedAt: current.issuedAt,
      voided: true,
    });
    const result = await this.pool.query(`UPDATE invoices SET status=$2 WHERE id=$1 RETURNING *`, [invoiceId, totals.status]);
    return mapInvoice(result.rows[0]);
  }

  async listPatientDocuments(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<PatientDocument[]> {
    const result = await this.pool.query('SELECT * FROM patient_documents WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapDocument).filter((item) => {
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      return true;
    });
  }

  async createPatientDocument(input: PatientDocumentInput): Promise<PatientDocument> {
    const patient = await this.getPatient(input.patientId);
    if (!patient) throw notFound('PATIENT_NOT_FOUND');
    if (patient.tenantId !== input.tenantId) throw httpError('FORBIDDEN', 403);
    if (input.encounterId) {
      const encounter = await this.getEncounter(input.encounterId);
      if (!encounter) throw notFound('ENCOUNTER_NOT_FOUND');
      if (encounter.tenantId !== input.tenantId || encounter.patientId !== input.patientId) throw httpError('ENCOUNTER_MISMATCH', 400);
    }
    const result = await this.pool.query(
      `INSERT INTO patient_documents (tenant_id, patient_id, encounter_id, title, document_type, file_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.tenantId, input.patientId, input.encounterId ?? null, input.title, input.documentType, input.fileUrl ?? null, input.notes ?? null],
    );
    return mapDocument(result.rows[0]);
  }

  async getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    const result = await this.pool.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return result.rows[0] ? mapTenant(result.rows[0]) : undefined;
  }

  async listPatientAccounts(tenantId: string): Promise<PatientAccount[]> {
    const result = await this.pool.query('SELECT * FROM patient_accounts WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapPatientAccount);
  }

  async getPatientAccount(accountId: string): Promise<PatientAccount | undefined> {
    const result = await this.pool.query('SELECT * FROM patient_accounts WHERE id = $1', [accountId]);
    return result.rows[0] ? mapPatientAccount(result.rows[0]) : undefined;
  }

  async findPatientAccountByEmail(tenantId: string, email: string): Promise<PatientAccount | undefined> {
    const result = await this.pool.query('SELECT * FROM patient_accounts WHERE tenant_id = $1 AND email = $2', [tenantId, email.toLowerCase()]);
    return result.rows[0] ? mapPatientAccount(result.rows[0]) : undefined;
  }

  async findPatientAccountByActivationTokenHash(tokenHash: string): Promise<PatientAccount | undefined> {
    const result = await this.pool.query('SELECT * FROM patient_accounts WHERE activation_token_hash = $1', [tokenHash]);
    return result.rows[0] ? mapPatientAccount(result.rows[0]) : undefined;
  }

  async findPatientAccountByPasswordResetTokenHash(tokenHash: string): Promise<PatientAccount | undefined> {
    const result = await this.pool.query('SELECT * FROM patient_accounts WHERE password_reset_token_hash = $1', [tokenHash]);
    return result.rows[0] ? mapPatientAccount(result.rows[0]) : undefined;
  }

  async createPatientAccount(input: {
    tenantId: string;
    patientId: string;
    email: string;
    status: PatientAccount['status'];
    passwordHash?: string;
    activationTokenHash?: string;
    activationTokenExpiresAt?: string;
    activationTokenUsedAt?: string;
  }): Promise<PatientAccount> {
    try {
      const result = await this.pool.query(
        `INSERT INTO patient_accounts (tenant_id, patient_id, email, password_hash, activation_token_hash, activation_token_expires_at, activation_token_used_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [input.tenantId, input.patientId, input.email.toLowerCase(), input.passwordHash ?? null, input.activationTokenHash ?? null, input.activationTokenExpiresAt ?? null, input.activationTokenUsedAt ?? null, input.status],
      );
      return mapPatientAccount(result.rows[0]);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '23505') throw httpError('PATIENT_EMAIL_TAKEN', 409);
      throw error;
    }
  }

  async updatePatientAccount(
    accountId: string,
    patch: Partial<Omit<PatientAccount, 'id' | 'tenantId' | 'patientId' | 'email' | 'createdAt'>>,
  ): Promise<PatientAccount> {
    const current = await this.getPatientAccount(accountId);
    if (!current) throw notFound('PATIENT_ACCOUNT_NOT_FOUND');
    const next = { ...current, ...patch };
    const result = await this.pool.query(
      `UPDATE patient_accounts SET status=$2, password_hash=$3, activation_token_hash=$4, activation_token_expires_at=$5, activation_token_used_at=$6,
       password_reset_token_hash=$7, password_reset_token_expires_at=$8, password_reset_token_used_at=$9, last_login_at=$10 WHERE id=$1 RETURNING *`,
      [
        accountId,
        next.status,
        next.passwordHash ?? null,
        next.activationTokenHash ?? null,
        next.activationTokenExpiresAt ?? null,
        next.activationTokenUsedAt ?? null,
        next.passwordResetTokenHash ?? null,
        next.passwordResetTokenExpiresAt ?? null,
        next.passwordResetTokenUsedAt ?? null,
        next.lastLoginAt ?? null,
      ],
    );
    return mapPatientAccount(result.rows[0]);
  }

  async listNotificationJobs(tenantId: string, filters?: { status?: NotificationJob['status']; type?: NotificationJob['type'] }): Promise<NotificationJob[]> {
    const result = await this.pool.query('SELECT * FROM notification_jobs WHERE tenant_id = $1 ORDER BY created_at', [tenantId]);
    return result.rows.map(mapNotificationJob).filter((item) => {
      if (filters?.status && item.status !== filters.status) return false;
      if (filters?.type && item.type !== filters.type) return false;
      return true;
    });
  }

  async getNotificationJob(jobId: string): Promise<NotificationJob | undefined> {
    const result = await this.pool.query('SELECT * FROM notification_jobs WHERE id = $1', [jobId]);
    return result.rows[0] ? mapNotificationJob(result.rows[0]) : undefined;
  }

  async queueNotification(input: {
    tenantId: string;
    patientId?: string;
    memberId?: string;
    channel: NotificationJob['channel'];
    type: NotificationJob['type'];
    recipient: string;
    subject?: string;
    body: string;
    scheduledFor?: string;
  }): Promise<NotificationJob> {
    const result = await this.pool.query(
      `INSERT INTO notification_jobs (tenant_id, patient_id, member_id, channel, type, recipient, subject, body, status, scheduled_for)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) RETURNING *`,
      [input.tenantId, input.patientId ?? null, input.memberId ?? null, input.channel, input.type, input.recipient, input.subject ?? null, input.body, input.scheduledFor ?? null],
    );
    return mapNotificationJob(result.rows[0]);
  }

  async markNotificationSent(jobId: string, meta?: { provider?: string; providerMessageId?: string }): Promise<NotificationJob> {
    const current = await this.getNotificationJob(jobId);
    if (!current) throw notFound('NOTIFICATION_NOT_FOUND');
    const result = await this.pool.query(
      `UPDATE notification_jobs SET status='sent', sent_at=now(), error=NULL, provider=COALESCE($2, provider), provider_message_id=COALESCE($3, provider_message_id) WHERE id=$1 RETURNING *`,
      [jobId, meta?.provider ?? null, meta?.providerMessageId ?? null],
    );
    return mapNotificationJob(result.rows[0]);
  }

  async markNotificationFailed(jobId: string, error: string): Promise<NotificationJob> {
    const result = await this.pool.query(
      `UPDATE notification_jobs SET status='failed', error=$2 WHERE id=$1 RETURNING *`,
      [jobId, error],
    );
    if (!result.rows[0]) throw notFound('NOTIFICATION_NOT_FOUND');
    return mapNotificationJob(result.rows[0]);
  }

  async cancelNotification(jobId: string): Promise<NotificationJob> {
    const result = await this.pool.query(
      `UPDATE notification_jobs SET status='cancelled' WHERE id=$1 RETURNING *`,
      [jobId],
    );
    if (!result.rows[0]) throw notFound('NOTIFICATION_NOT_FOUND');
    return mapNotificationJob(result.rows[0]);
  }

  async listAuditLogs(tenantId: string, filters?: { objectType?: string; objectId?: string; action?: string }): Promise<AuditLog[]> {
    const result = await this.pool.query('SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    return result.rows.map(mapAuditLog).filter((item) => {
      if (filters?.objectType && item.objectType !== filters.objectType) return false;
      if (filters?.objectId && item.objectId !== filters.objectId) return false;
      if (filters?.action && item.action !== filters.action) return false;
      return true;
    });
  }

  async recordAuditLog(input: {
    tenantId: string;
    actorUserId?: string;
    actorMemberId?: string;
    actorPatientAccountId?: string;
    actorType?: 'staff' | 'patient' | 'system';
    action: string;
    objectType?: string;
    objectId?: string;
    details?: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_member_id, actor_patient_account_id, actor_type, action, object_type, object_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.tenantId,
        input.actorUserId ?? null,
        input.actorMemberId ?? null,
        input.actorPatientAccountId ?? null,
        input.actorType ?? null,
        input.action,
        input.objectType ?? null,
        input.objectId ?? null,
        input.details ? JSON.stringify(input.details) : null,
      ],
    );
  }

  async findSyncOperation(tenantId: string, clientOperationId: string): Promise<SyncOperationRecord | undefined> {
    const result = await this.pool.query(
      'SELECT * FROM sync_operations WHERE tenant_id = $1 AND client_operation_id = $2',
      [tenantId, clientOperationId],
    );
    return result.rows[0] ? mapSyncOperation(result.rows[0]) : undefined;
  }

  async recordSyncOperation(input: {
    tenantId: string;
    clientOperationId: string;
    entityType: SyncOperationRecord['entityType'];
    operation: 'create' | 'update';
    status: SyncOperationRecord['status'];
    serverObjectType?: string;
    serverObjectId?: string;
    error?: string;
    payloadHash: string;
  }): Promise<SyncOperationRecord> {
    const existing = await this.findSyncOperation(input.tenantId, input.clientOperationId);
    if (existing) return existing;
    const result = await this.pool.query(
      `INSERT INTO sync_operations (
        tenant_id, client_operation_id, entity_type, operation, status, server_object_type, server_object_id, error, payload_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (tenant_id, client_operation_id) DO NOTHING
      RETURNING *`,
      [
        input.tenantId,
        input.clientOperationId,
        input.entityType,
        input.operation,
        input.status,
        input.serverObjectType ?? null,
        input.serverObjectId ?? null,
        input.error ?? null,
        input.payloadHash,
      ],
    );
    if (result.rows[0]) return mapSyncOperation(result.rows[0]);
    const raced = await this.findSyncOperation(input.tenantId, input.clientOperationId);
    if (!raced) throw notFound('SYNC_OPERATION_NOT_FOUND');
    return raced;
  }

  // Settings
  async getSettings(tenantId: string): Promise<ClinicSettings | null> {
    const result = await this.pool.query('SELECT * FROM clinic_settings WHERE tenant_id = $1', [tenantId]);
    if (result.rows.length === 0) return null;
    return mapSettings(result.rows[0]);
  }

  async upsertSettings(tenantId: string, data: Partial<ClinicSettings>): Promise<ClinicSettings> {
    const existing = await this.getSettings(tenantId);
    if (existing) {
      const result = await this.pool.query(
        `UPDATE clinic_settings SET clinic_name=$1, clinic_address=$2, clinic_logo_url=$3, brand_primary_color=$4, brand_accent_color=$5, notification_templates=$6, paystack_public_key=$7, paystack_secret_key=$8, bank_name=$9, bank_account_name=$10, bank_account_number=$11, smtp_host=$12, smtp_port=$13, smtp_user=$14, smtp_pass=$15, smtp_from_email=$16, smtp_from_name=$17, updated_at=now() WHERE tenant_id=$18 RETURNING *`,
        [data.clinicName || existing.clinicName, data.clinicAddress || existing.clinicAddress, data.clinicLogoUrl || existing.clinicLogoUrl, data.brandPrimaryColor || existing.brandPrimaryColor, data.brandAccentColor || existing.brandAccentColor, JSON.stringify(data.notificationTemplates || existing.notificationTemplates), data.paystackPublicKey ?? existing.paystackPublicKey, data.paystackSecretKey ?? existing.paystackSecretKey, data.bankName ?? existing.bankName, data.bankAccountName ?? existing.bankAccountName, data.bankAccountNumber ?? existing.bankAccountNumber, data.smtpHost ?? existing.smtpHost, data.smtpPort ?? existing.smtpPort, data.smtpUser ?? existing.smtpUser, data.smtpPass ?? existing.smtpPass, data.smtpFromEmail ?? existing.smtpFromEmail, data.smtpFromName ?? existing.smtpFromName, tenantId],
      );
      return mapSettings(result.rows[0]);
    } else {
      const result = await this.pool.query(
        `INSERT INTO clinic_settings (tenant_id, clinic_name, clinic_address, clinic_logo_url, brand_primary_color, brand_accent_color, notification_templates, paystack_public_key, paystack_secret_key, bank_name, bank_account_name, bank_account_number, bank_transfer_enabled, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [tenantId, data.clinicName || '', data.clinicAddress || '', data.clinicLogoUrl || '', data.brandPrimaryColor || '#66f2ea', data.brandAccentColor || '#3b82f6', JSON.stringify(data.notificationTemplates || {}), data.paystackPublicKey || '', data.paystackSecretKey || '', data.bankName || '', data.bankAccountName || '', data.bankAccountNumber || '', data.bankTransferEnabled ?? true, data.smtpHost || '', data.smtpPort ?? 587, data.smtpUser || '', data.smtpPass || '', data.smtpFromEmail || '', data.smtpFromName || ''],
      );
      return mapSettings(result.rows[0]);
    }
  }

  // Revenue Report
  async getRevenueReport(tenantId: string, from?: string, to?: string): Promise<{
    daily: Array<{ date: string; totalKobo: number; count: number }>;
    totalRevenueKobo: number;
    totalInvoices: number;
    paidInvoices: number;
    unpaidInvoices: number;
  }> {
    const fromDate = from || '1970-01-01';
    const toDate = to || '2099-12-31';
    const result = await this.pool.query(
      `SELECT DATE(created_at) as date, SUM(total_kobo) as total_kobo, COUNT(*) as count FROM invoices WHERE tenant_id=$1 AND status IN ('paid','partially_paid') AND DATE(created_at) >= $2 AND DATE(created_at) <= $3 GROUP BY DATE(created_at) ORDER BY date`,
      [tenantId, fromDate, toDate],
    );
    const daily = result.rows.map((r: pg.QueryResultRow) => ({ date: r.date, totalKobo: parseInt(r.total_kobo) || 0, count: parseInt(r.count) || 0 }));
    const totals = await this.pool.query(
      `SELECT SUM(total_kobo) as total_revenue, COUNT(*) as total, SUM(CASE WHEN status IN ($1,$2) THEN 1 ELSE 0 END) as paid, SUM(CASE WHEN status NOT IN ($1,$2) THEN 1 ELSE 0 END) as unpaid FROM invoices WHERE tenant_id=$3`,
      ['paid', 'partially_paid', tenantId],
    );
    return {
      daily,
      totalRevenueKobo: parseInt(totals.rows[0].total_revenue) || 0,
      totalInvoices: parseInt(totals.rows[0].total) || 0,
      paidInvoices: parseInt(totals.rows[0].paid) || 0,
      unpaidInvoices: parseInt(totals.rows[0].unpaid) || 0,
    };
  }

  // Paystack
  async createPaystackTransaction(tenantId: string, invoiceId: string, reference: string, amountKobo: number): Promise<PaystackTransaction> {
    const result = await this.pool.query(
      'INSERT INTO paystack_transactions (tenant_id, invoice_id, reference, amount_kobo) VALUES ($1,$2,$3,$4) RETURNING *',
      [tenantId, invoiceId, reference, amountKobo],
    );
    return mapPaystackTx(result.rows[0]);
  }

  async updatePaystackTransaction(reference: string, data: { status?: string; channel?: string; paidAt?: string; verifiedAt?: string }): Promise<PaystackTransaction> {
    const sets: string[] = [];
    const vals: (string | undefined)[] = [];
    let idx = 1;
    if (data.status) { sets.push(`status=$${idx++}`); vals.push(data.status); }
    if (data.channel) { sets.push(`channel=$${idx++}`); vals.push(data.channel); }
    if (data.paidAt) { sets.push(`paid_at=$${idx++}`); vals.push(data.paidAt); }
    if (data.verifiedAt) { sets.push(`verified_at=$${idx++}`); vals.push(data.verifiedAt); }
    vals.push(reference);
    const result = await this.pool.query(
      `UPDATE paystack_transactions SET ${sets.join(',')} WHERE reference=$${idx} RETURNING *`,
      vals,
    );
    return mapPaystackTx(result.rows[0]);
  }

  // Messages
  async createMessageLog(tenantId: string, data: { channel: string; recipient: string; subject?: string; body: string }): Promise<MessageLog> {
    const result = await this.pool.query(
      'INSERT INTO message_logs (tenant_id,channel,recipient,subject,body) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [tenantId, data.channel, data.recipient, data.subject || '', data.body],
    );
    return mapMessageLog(result.rows[0]);
  }

  async updateMessageLog(id: string, data: { status?: string; provider?: string; providerMessageId?: string; sentAt?: string; error?: string }): Promise<MessageLog> {
    const sets: string[] = [];
    const vals: (string | undefined)[] = [];
    let idx = 1;
    if (data.status) { sets.push(`status=$${idx++}`); vals.push(data.status); }
    if (data.provider) { sets.push(`provider=$${idx++}`); vals.push(data.provider); }
    if (data.providerMessageId) { sets.push(`provider_message_id=$${idx++}`); vals.push(data.providerMessageId); }
    if (data.sentAt) { sets.push(`sent_at=$${idx++}`); vals.push(data.sentAt); }
    if (data.error) { sets.push(`error=$${idx++}`); vals.push(data.error); }
    vals.push(id);
    const result = await this.pool.query(
      `UPDATE message_logs SET ${sets.join(',')} WHERE id=$${idx} RETURNING *`,
      vals,
    );
    return mapMessageLog(result.rows[0]);
  }

  async getMessageLogs(tenantId: string, limit = 50): Promise<MessageLog[]> {
    const result = await this.pool.query(
      'SELECT * FROM message_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',
      [tenantId, limit],
    );
    return result.rows.map((r: pg.QueryResultRow) => mapMessageLog(r));
  }

  // Referrals
  async listReferrals(tenantId: string, filters?: { patientId?: string; encounterId?: string; toDoctorMemberId?: string; status?: Referral['status'] }): Promise<Referral[]> {
    const result = await this.pool.query('SELECT * FROM referrals WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    return result.rows.map(mapReferral).filter((item) => {
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      if (filters?.toDoctorMemberId && item.toDoctorMemberId !== filters.toDoctorMemberId) return false;
      if (filters?.status && item.status !== filters.status) return false;
      return true;
    });
  }

  async createReferral(input: ReferralInput): Promise<Referral> {
    const result = await this.pool.query(
      `INSERT INTO referrals (tenant_id, encounter_id, patient_id, from_doctor_member_id, to_doctor_member_id, referral_type, specialty, external_clinic_name, external_clinic_contact, reason, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [input.tenantId, input.encounterId, input.patientId, input.fromDoctorMemberId ?? null, input.toDoctorMemberId ?? null, input.referralType, input.specialty ?? null, input.externalClinicName ?? null, input.externalClinicContact ?? null, input.reason, input.notes ?? null],
    );
    return mapReferral(result.rows[0]);
  }

  async updateReferral(
    referralId: string,
    patch: Partial<Pick<Referral, 'status' | 'notes' | 'toDoctorMemberId' | 'externalClinicName' | 'externalClinicContact'>>,
  ): Promise<Referral> {
    const sets: string[] = [];
    const vals: (string | null | undefined)[] = [];
    let idx = 1;
    if (patch.status !== undefined) { sets.push(`status=$${idx++}`); vals.push(patch.status); }
    if (patch.notes !== undefined) { sets.push(`notes=$${idx++}`); vals.push(patch.notes ?? null); }
    if (patch.toDoctorMemberId !== undefined) { sets.push(`to_doctor_member_id=$${idx++}`); vals.push(patch.toDoctorMemberId ?? null); }
    if (patch.externalClinicName !== undefined) { sets.push(`external_clinic_name=$${idx++}`); vals.push(patch.externalClinicName ?? null); }
    if (patch.externalClinicContact !== undefined) { sets.push(`external_clinic_contact=$${idx++}`); vals.push(patch.externalClinicContact ?? null); }
    if (sets.length === 0) throw httpError('NO_FIELDS_TO_UPDATE', 400);
    vals.push(referralId);
    const result = await this.pool.query(
      `UPDATE referrals SET ${sets.join(',')}, updated_at=now() WHERE id=$${idx} RETURNING *`,
      vals,
    );
    if (!result.rows[0]) throw notFound('REFERRAL_NOT_FOUND');
    return mapReferral(result.rows[0]);
  }

  // Staff portal messaging
  async listStaffMessages(tenantId: string, memberId: string): Promise<StaffMessage[]> {
    let result;
    if (!memberId) {
      // snapshot mode: list all tenant messages
      result = await this.pool.query(
        'SELECT * FROM staff_messages WHERE tenant_id = $1 ORDER BY created_at DESC',
        [tenantId],
      );
    } else {
      result = await this.pool.query(
        'SELECT * FROM staff_messages WHERE tenant_id = $1 AND (sender_member_id = $2 OR recipient_member_id = $2) ORDER BY created_at DESC',
        [tenantId, memberId],
      );
    }
    return result.rows.map(mapStaffMessage);
  }

  async createStaffMessage(input: StaffMessageInput): Promise<StaffMessage> {
    const result = await this.pool.query(
      `INSERT INTO staff_messages (tenant_id, sender_member_id, recipient_member_id, patient_id, encounter_id, referral_id, subject, body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.tenantId, input.senderMemberId, input.recipientMemberId, input.patientId ?? null, input.encounterId ?? null, input.referralId ?? null, input.subject ?? null, input.body],
    );
    return mapStaffMessage(result.rows[0]);
  }

  async markStaffMessageRead(messageId: string, memberId: string): Promise<StaffMessage> {
    const result = await this.pool.query(
      'UPDATE staff_messages SET read_at=now() WHERE id=$1 AND recipient_member_id=$2 RETURNING *',
      [messageId, memberId],
    );
    if (!result.rows[0]) throw notFound('STAFF_MESSAGE_NOT_FOUND');
    return mapStaffMessage(result.rows[0]);
  }

  // Inventory
  async listInventoryItems(tenantId: string): Promise<InventoryItem[]> {
    const result = await this.pool.query('SELECT * FROM inventory_items WHERE tenant_id = $1 ORDER BY name', [tenantId]);
    return result.rows.map(mapInventoryItem);
  }

  async createInventoryItem(input: InventoryItemInput): Promise<InventoryItem> {
    const result = await this.pool.query(
      `INSERT INTO inventory_items (tenant_id, name, sku, category, unit, current_stock, reorder_level, unit_cost_kobo, selling_price_kobo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [input.tenantId, input.name, input.sku ?? null, input.category ?? null, input.unit ?? null, input.currentStock ?? 0, input.reorderLevel ?? 0, input.unitCostKobo ?? 0, input.sellingPriceKobo ?? 0],
    );
    return mapInventoryItem(result.rows[0]);
  }

  async updateInventoryItem(
    itemId: string,
    patch: Partial<Pick<InventoryItem, 'name' | 'sku' | 'category' | 'unit' | 'reorderLevel' | 'unitCostKobo' | 'sellingPriceKobo' | 'status'>>,
  ): Promise<InventoryItem> {
    const sets: string[] = [];
    const vals: (string | number | null | undefined)[] = [];
    let idx = 1;
    if (patch.name !== undefined) { sets.push(`name=$${idx++}`); vals.push(patch.name); }
    if (patch.sku !== undefined) { sets.push(`sku=$${idx++}`); vals.push(patch.sku ?? null); }
    if (patch.category !== undefined) { sets.push(`category=$${idx++}`); vals.push(patch.category ?? null); }
    if (patch.unit !== undefined) { sets.push(`unit=$${idx++}`); vals.push(patch.unit ?? null); }
    if (patch.reorderLevel !== undefined) { sets.push(`reorder_level=$${idx++}`); vals.push(patch.reorderLevel); }
    if (patch.unitCostKobo !== undefined) { sets.push(`unit_cost_kobo=$${idx++}`); vals.push(patch.unitCostKobo); }
    if (patch.sellingPriceKobo !== undefined) { sets.push(`selling_price_kobo=$${idx++}`); vals.push(patch.sellingPriceKobo); }
    if (patch.status !== undefined) { sets.push(`status=$${idx++}`); vals.push(patch.status); }
    if (sets.length === 0) throw httpError('NO_FIELDS_TO_UPDATE', 400);
    vals.push(itemId);
    const result = await this.pool.query(
      `UPDATE inventory_items SET ${sets.join(',')}, updated_at=now() WHERE id=$${idx} RETURNING *`,
      vals,
    );
    if (!result.rows[0]) throw notFound('INVENTORY_ITEM_NOT_FOUND');
    return mapInventoryItem(result.rows[0]);
  }

  async recordInventoryMovement(
    itemId: string,
    data: InventoryMovementInput,
  ): Promise<{ item: InventoryItem; movement: InventoryMovement }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query('SELECT * FROM inventory_items WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [itemId, data.tenantId]);
      if (!currentResult.rows[0]) {
        await client.query('ROLLBACK');
        throw notFound('INVENTORY_ITEM_NOT_FOUND');
      }
      const current = mapInventoryItem(currentResult.rows[0]);
      const previousQuantity = current.currentStock;
      const type = data.movementType === 'receive' ? 'purchase' : data.movementType === 'adjust' ? 'adjustment' : data.movementType;
      let delta = 0;
      if (type === 'purchase' || type === 'return') delta = Math.abs(data.quantity);
      if (type === 'dispense' || type === 'usage') delta = -Math.abs(data.quantity);
      if (type === 'adjustment') delta = data.quantity;
      const newQuantity = Math.max(0, previousQuantity + delta);
      let batchId = data.batchId ?? null;
      if (type === 'purchase') {
        const batchResult = await client.query(
          `INSERT INTO inventory_batches (tenant_id, item_id, supplier_id, batch_number, expiry_date, quantity_remaining, cost_price_kobo, received_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamptz, now())) RETURNING *`,
          [data.tenantId, itemId, data.supplierId ?? null, data.batchNumber ?? null, data.expiryDate ?? null, Math.abs(data.quantity), data.costPriceKobo ?? current.unitCostKobo, data.receivedAt ?? null],
        );
        batchId = batchResult.rows[0].id;
      } else if (batchId) {
        await client.query(
          `UPDATE inventory_batches SET quantity_remaining = GREATEST(0, quantity_remaining + $2::int), updated_at = now() WHERE id = $1 AND tenant_id = $3`,
          [batchId, delta, data.tenantId],
        );
      }
      const itemResult = await client.query(
        `UPDATE inventory_items SET current_stock = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [itemId, newQuantity],
      );
      const movementResult = await client.query(
        `INSERT INTO inventory_movements (tenant_id, item_id, batch_id, supplier_id, movement_type, quantity, reference, reason, notes, previous_quantity, new_quantity, cost_price_kobo, batch_number, expiry_date, created_by_member_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [data.tenantId, itemId, batchId, data.supplierId ?? null, type, Math.abs(data.quantity), data.reference ?? null, data.reason ?? null, data.notes ?? null, previousQuantity, newQuantity, data.costPriceKobo ?? null, data.batchNumber ?? null, data.expiryDate ?? null, data.createdByMemberId ?? null],
      );
      await client.query('COMMIT');
      return { item: mapInventoryItem(itemResult.rows[0]), movement: mapInventoryMovement(movementResult.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async listInventoryMovements(tenantId: string, itemId?: string): Promise<InventoryMovement[]> {
    const result = await this.pool.query(
      'SELECT * FROM inventory_movements WHERE tenant_id = $1 AND ($2::uuid IS NULL OR item_id = $2) ORDER BY created_at DESC',
      [tenantId, itemId ?? null],
    );
    return result.rows.map(mapInventoryMovement);
  }

  async listInventoryBatches(tenantId: string, itemId?: string): Promise<InventoryBatch[]> {
    const result = await this.pool.query(
      'SELECT * FROM inventory_batches WHERE tenant_id = $1 AND ($2::uuid IS NULL OR item_id = $2) ORDER BY expiry_date NULLS LAST, created_at DESC',
      [tenantId, itemId ?? null],
    );
    return result.rows.map(mapInventoryBatch);
  }

  async listSuppliers(tenantId: string): Promise<Supplier[]> {
    const result = await this.pool.query('SELECT * FROM suppliers WHERE tenant_id = $1 ORDER BY name', [tenantId]);
    return result.rows.map(mapSupplier);
  }

  async createSupplier(input: SupplierInput): Promise<Supplier> {
    const result = await this.pool.query(
      'INSERT INTO suppliers (tenant_id, name, phone, email) VALUES ($1,$2,$3,$4) RETURNING *',
      [input.tenantId, input.name, input.phone ?? null, input.email ?? null],
    );
    return mapSupplier(result.rows[0]);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
