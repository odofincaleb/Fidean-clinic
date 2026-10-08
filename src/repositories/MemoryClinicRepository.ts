import { nanoid } from 'nanoid';
import type {
  Appointment,
  AuditLog,
  Branch,
  HmoInsurance,
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
  Service,
  StaffMessage,
  Supplier,
  SyncOperationRecord,
  Tenant,
  TenantSnapshot,
  WalletTransaction,
} from '../domain/types.js';
import { applyInvoicePayment, assertScheduleWindow, finalizeInvoiceFields, toPublicPatientAccount } from '../domain/clinical.js';
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

function now(): string {
  return new Date().toISOString();
}

function patientCode(): string {
  return `PAT-${nanoid(8).toUpperCase()}`;
}

function requireEntity<T>(value: T | undefined, message: string): T {
  if (!value) throw notFound(message);
  return value;
}

export class MemoryClinicRepository implements ClinicRepository {
  storageMode(): 'postgres' | 'memory' {
    return 'memory';
  }
  private tenants = new Map<string, Tenant>();
  private branches = new Map<string, Branch>();
  private members = new Map<string, Member>();
  private patients = new Map<string, Patient>();
  private services = new Map<string, Service>();
  private appointments = new Map<string, Appointment>();
  private users = new Map<string, AuthUser>();
  private memberUserIds = new Map<string, string>();
  private doctorSchedules = new Map<string, DoctorSchedule>();
  private encounters = new Map<string, Encounter>();
  private prescriptions = new Map<string, Prescription>();
  private invoices = new Map<string, Invoice>();
  private patientDocuments = new Map<string, PatientDocument>();
  private patientAccounts = new Map<string, PatientAccount>();
  private notificationJobs = new Map<string, NotificationJob>();
  private auditLogs: AuditLog[] = [];
  private syncOperations = new Map<string, SyncOperationRecord>();
  private invoiceSeq = 0;
  private settings = new Map<string, ClinicSettings>();
  private paystackTxs = new Map<string, PaystackTransaction>();
  private messageLogs = new Map<string, MessageLog>();
  private referrals = new Map<string, Referral>();
  private staffMessages = new Map<string, StaffMessage>();
  private inventoryItems = new Map<string, InventoryItem>();
  private inventoryBatches = new Map<string, InventoryBatch>();
  private inventoryMovements = new Map<string, InventoryMovement>();
  private suppliers = new Map<string, Supplier>();
  private walletTransactions = new Map<string, WalletTransaction>();

  async listTenants(): Promise<Tenant[]> {
    return [...this.tenants.values()];
  }

  async getTenant(tenantId: string): Promise<Tenant | undefined> {
    return this.tenants.get(tenantId);
  }

  async createTenant(input: TenantInput): Promise<Tenant> {
    const tenant: Tenant = { id: nanoid(), name: input.name, slug: input.slug, status: 'trial', createdAt: now() };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  async updateTenant(tenantId: string, patch: Partial<Pick<Tenant, 'name' | 'status' | 'slug'>>): Promise<Tenant> {
    const tenant = requireEntity(this.tenants.get(tenantId), 'TENANT_NOT_FOUND');
    const next = { ...tenant, ...patch };
    this.tenants.set(tenantId, next);
    return next;
  }

  async listBranches(tenantId: string): Promise<Branch[]> {
    return [...this.branches.values()].filter((item) => item.tenantId === tenantId);
  }

  async getBranch(branchId: string): Promise<Branch | undefined> {
    return this.branches.get(branchId);
  }

  async createBranch(input: BranchInput): Promise<Branch> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    const branch: Branch = {
      id: nanoid(),
      tenantId: input.tenantId,
      name: input.name,
      address: input.address,
      phone: input.phone,
      status: 'active',
      createdAt: now(),
    };
    this.branches.set(branch.id, branch);
    return branch;
  }

  async updateBranch(branchId: string, patch: Partial<Pick<Branch, 'name' | 'address' | 'phone' | 'status'>>): Promise<Branch> {
    const branch = requireEntity(this.branches.get(branchId), 'BRANCH_NOT_FOUND');
    const next = { ...branch, ...patch };
    this.branches.set(branchId, next);
    return next;
  }

  async deleteBranch(branchId: string): Promise<void> {
    requireEntity(this.branches.get(branchId), 'BRANCH_NOT_FOUND');
    this.branches.delete(branchId);
  }

  async listMembers(tenantId: string): Promise<Member[]> {
    return [...this.members.values()].filter((item) => item.tenantId === tenantId);
  }

  async getMember(memberId: string): Promise<Member | undefined> {
    return this.members.get(memberId);
  }

  async addMember(input: MemberInput): Promise<Member> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    const member: Member = {
      id: nanoid(),
      tenantId: input.tenantId,
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      role: input.role,
      additionalRoles: input.additionalRoles ?? [],
      branchIds: input.branchIds ?? [],
      phone: input.phone,
      specialization: input.specialization,
      qualifications: input.qualifications,
      licenseNumber: input.licenseNumber,
      status: 'active',
      createdAt: now(),
    };
    this.members.set(member.id, member);
    return member;
  }

  async updateMember(memberId: string, patch: Partial<Pick<Member, 'displayName' | 'role' | 'additionalRoles' | 'branchIds' | 'status' | 'phone' | 'specialization' | 'qualifications' | 'licenseNumber'>>): Promise<Member> {
    const member = requireEntity(this.members.get(memberId), 'MEMBER_NOT_FOUND');
    const next = { ...member, ...patch };
    this.members.set(memberId, next);
    return next;
  }

  async listPatients(tenantId: string): Promise<Patient[]> {
    return [...this.patients.values()].filter((item) => item.tenantId === tenantId);
  }

  async getPatient(patientId: string): Promise<Patient | undefined> {
    return this.patients.get(patientId);
  }

  async createPatient(input: PatientInput): Promise<Patient> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    const patient: Patient = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      patientCode: patientCode(),
      clinicPatientId: input.clinicPatientId,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email?.toLowerCase(),
      altPhone: input.altPhone,
      dob: input.dob,
      gender: input.gender,
      bloodGroup: input.bloodGroup,
      address: input.address,
      city: input.city,
      state: input.state,
      medicalHistory: input.medicalHistory,
      createdAt: now(),
    };
    this.patients.set(patient.id, patient);
    return patient;
  }

  async updatePatient(patientId: string, patch: Partial<Pick<Patient, 'clinicPatientId' | 'firstName' | 'lastName' | 'phone' | 'email' | 'altPhone' | 'dob' | 'gender' | 'bloodGroup' | 'address' | 'city' | 'state' | 'medicalHistory'>>): Promise<Patient> {
    const patient = requireEntity(this.patients.get(patientId), 'PATIENT_NOT_FOUND');
    const next = { ...patient, ...patch };
    this.patients.set(patientId, next);
    return next;
  }

  async listServices(tenantId: string): Promise<Service[]> {
    return [...this.services.values()].filter((item) => item.tenantId === tenantId);
  }

  async getService(serviceId: string): Promise<Service | undefined> {
    return this.services.get(serviceId);
  }

  async createService(input: ServiceInput): Promise<Service> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    const service: Service = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      name: input.name,
      durationMinutes: input.durationMinutes ?? 30,
      priceKobo: input.priceKobo ?? 0,
      currency: input.currency ?? 'NGN',
      active: true,
    };
    this.services.set(service.id, service);
    return service;
  }

  async updateService(
    serviceId: string,
    patch: Partial<Pick<Service, 'name' | 'durationMinutes' | 'priceKobo' | 'currency' | 'active' | 'branchId'>>,
  ): Promise<Service> {
    const service = requireEntity(this.services.get(serviceId), 'SERVICE_NOT_FOUND');
    const next = { ...service, ...patch };
    this.services.set(serviceId, next);
    return next;
  }

  async listAppointments(tenantId: string, filters?: AppointmentListFilters): Promise<Appointment[]> {
    const rows = [...this.appointments.values()].filter((item) => item.tenantId === tenantId);
    return applyAppointmentFilters(rows, filters);
  }

  async getAppointment(appointmentId: string): Promise<Appointment | undefined> {
    return this.appointments.get(appointmentId);
  }

  async createAppointment(input: AppointmentInput): Promise<Appointment> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    if (!this.branches.has(input.branchId)) throw notFound('BRANCH_NOT_FOUND');
    if (!this.patients.has(input.patientId)) throw notFound('PATIENT_NOT_FOUND');
    await assertAppointmentFits(this, input);
    const appointment: Appointment = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      patientId: input.patientId,
      doctorMemberId: input.doctorMemberId,
      serviceName: input.serviceName,
      startsAt: input.startsAt,
      status: 'requested',
      notes: input.notes,
      createdAt: now(),
    };
    this.appointments.set(appointment.id, appointment);
    return appointment;
  }

  async updateAppointment(
    appointmentId: string,
    patch: Partial<Pick<Appointment, 'startsAt' | 'serviceName' | 'doctorMemberId' | 'notes'>>,
  ): Promise<Appointment> {
    const appointment = requireEntity(this.appointments.get(appointmentId), 'APPOINTMENT_NOT_FOUND');
    const next = { ...appointment, ...patch };
    await assertAppointmentFits(this, {
      tenantId: next.tenantId,
      branchId: next.branchId,
      patientId: next.patientId,
      startsAt: next.startsAt,
      serviceName: next.serviceName,
      doctorMemberId: next.doctorMemberId,
      notes: next.notes,
    }, appointmentId);
    this.appointments.set(appointmentId, next);
    return next;
  }

  async transitionAppointment(appointmentId: string, status: Appointment['status']): Promise<Appointment> {
    const appointment = requireEntity(this.appointments.get(appointmentId), 'APPOINTMENT_NOT_FOUND');
    assertValidTransition(appointment.status, status);
    const next = { ...appointment, status };
    this.appointments.set(appointmentId, next);
    return next;
  }

  async visibleBranchesForMember(memberId: string): Promise<Branch[]> {
    const member = requireEntity(this.members.get(memberId), 'MEMBER_NOT_FOUND');
    const all = [...this.branches.values()].filter((branch) => branch.tenantId === member.tenantId);
    if (member.role === 'owner' || member.role === 'admin' || member.branchIds.length === 0) return all;
    return all.filter((branch) => member.branchIds.includes(branch.id));
  }

  async getTenantSnapshot(tenantId: string): Promise<TenantSnapshot> {
    const tenant = requireEntity(this.tenants.get(tenantId), 'TENANT_NOT_FOUND');
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
      referrals: await this.listReferrals(tenantId),
      staffMessages: await this.listStaffMessages(tenantId, ''),
      inventoryItems: await this.listInventoryItems(tenantId),
      inventoryBatches: await this.listInventoryBatches(tenantId),
      inventoryMovements: await this.listInventoryMovements(tenantId),
      suppliers: await this.listSuppliers(tenantId),
      auditLogs: await this.listAuditLogs(tenantId),
      offlineSync: true,
    };
  }

  async seedCelonDemo(): Promise<TenantSnapshot> {
    return seedCelonDemo(this);
  }

  async findUserByEmail(email: string): Promise<AuthUser | undefined> {
    const normalized = email.toLowerCase();
    return [...this.users.values()].find((user) => user.email === normalized);
  }

  async createUser(input: { email: string; passwordHash: string; displayName?: string }): Promise<{ id: string; email: string }> {
    const email = input.email.toLowerCase();
    const user: AuthUser = { id: nanoid(), email, passwordHash: input.passwordHash, displayName: input.displayName };
    this.users.set(user.id, user);
    return { id: user.id, email: user.email };
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) this.users.set(userId, { ...user, passwordHash });
  }

  async findActiveMembershipByUserId(userId: string): Promise<Member | undefined> {
    const membershipId = [...this.memberUserIds.entries()].find(([, id]) => id === userId)?.[0];
    if (!membershipId) return undefined;
    const member = this.members.get(membershipId);
    if (!member || member.status !== 'active') return undefined;
    return member;
  }

  async findMembershipByEmail(tenantId: string, email: string): Promise<Member | undefined> {
    const normalized = email.toLowerCase();
    return [...this.members.values()].find((member) => member.tenantId === tenantId && member.email === normalized);
  }

  async linkUserToMembership(membershipId: string, userId: string): Promise<void> {
    const member = requireEntity(this.members.get(membershipId), 'MEMBER_NOT_FOUND');
    this.memberUserIds.set(membershipId, userId);
    this.members.set(membershipId, { ...member, status: 'active' });
  }

  async listDoctorSchedules(tenantId: string, filters?: { branchId?: string; doctorMemberId?: string }): Promise<DoctorSchedule[]> {
    return [...this.doctorSchedules.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.branchId && item.branchId !== filters.branchId) return false;
      if (filters?.doctorMemberId && item.doctorMemberId !== filters.doctorMemberId) return false;
      return true;
    });
  }

  async getDoctorSchedule(scheduleId: string): Promise<DoctorSchedule | undefined> {
    return this.doctorSchedules.get(scheduleId);
  }

  async createDoctorSchedule(input: DoctorScheduleInput): Promise<DoctorSchedule> {
    validateDoctorScheduleInput(input, this.tenants.has(input.tenantId), this.branches.get(input.branchId), this.members.get(input.doctorMemberId));
    const schedule: DoctorSchedule = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      doctorMemberId: input.doctorMemberId,
      weekday: input.weekday,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      slotMinutes: input.slotMinutes ?? 30,
      active: true,
      createdAt: now(),
    };
    this.doctorSchedules.set(schedule.id, schedule);
    return schedule;
  }

  async updateDoctorSchedule(
    scheduleId: string,
    patch: Partial<Pick<DoctorSchedule, 'startsAt' | 'endsAt' | 'slotMinutes' | 'active'>>,
  ): Promise<DoctorSchedule> {
    const current = requireEntity(this.doctorSchedules.get(scheduleId), 'SCHEDULE_NOT_FOUND');
    const next = { ...current, ...patch };
    assertScheduleWindow(next.startsAt, next.endsAt, next.slotMinutes);
    this.doctorSchedules.set(scheduleId, next);
    return next;
  }

  async deleteDoctorSchedule(scheduleId: string): Promise<void> {
    requireEntity(this.doctorSchedules.get(scheduleId), 'SCHEDULE_NOT_FOUND');
    this.doctorSchedules.delete(scheduleId);
  }

  async listEncounters(tenantId: string, filters?: { patientId?: string; branchId?: string; appointmentId?: string }): Promise<Encounter[]> {
    return [...this.encounters.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.branchId && item.branchId !== filters.branchId) return false;
      if (filters?.appointmentId && item.appointmentId !== filters.appointmentId) return false;
      return true;
    });
  }

  async getEncounter(encounterId: string): Promise<Encounter | undefined> {
    return this.encounters.get(encounterId);
  }

  async createEncounter(input: EncounterInput): Promise<Encounter> {
    validateEncounterInput(
      input,
      this.tenants.has(input.tenantId),
      this.branches.get(input.branchId),
      this.patients.get(input.patientId),
      input.appointmentId ? this.appointments.get(input.appointmentId) : undefined,
    );
    const encounter: Encounter = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      doctorMemberId: input.doctorMemberId,
      status: 'open',
      reason: input.reason,
      diagnosis: input.diagnosis,
      clinicalNotes: input.clinicalNotes,
      vitals: input.vitals,
      specialistData: input.specialistData,
      startedAt: now(),
      createdAt: now(),
    };
    this.encounters.set(encounter.id, encounter);
    return encounter;
  }

  async updateEncounter(encounterId: string, patch: EncounterPatch): Promise<Encounter> {
    const current = requireEntity(this.encounters.get(encounterId), 'ENCOUNTER_NOT_FOUND');
    assertEncounterEditable(current);
    const next = { ...current, ...patch, status: current.status };
    this.encounters.set(encounterId, next);
    return next;
  }

  async signEncounter(encounterId: string): Promise<Encounter> {
    const current = requireEntity(this.encounters.get(encounterId), 'ENCOUNTER_NOT_FOUND');
    assertEncounterEditable(current);
    const next = { ...current, status: 'signed' as const, signedAt: now() };
    this.encounters.set(encounterId, next);
    return next;
  }

  async deleteEncounter(encounterId: string): Promise<void> {
    requireEntity(this.encounters.get(encounterId), 'ENCOUNTER_NOT_FOUND');
    this.encounters.delete(encounterId);
  }

  async listPrescriptions(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<Prescription[]> {
    return [...this.prescriptions.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      return true;
    });
  }

  async getPrescription(prescriptionId: string): Promise<Prescription | undefined> {
    return this.prescriptions.get(prescriptionId);
  }

  async createPrescription(input: PrescriptionInput): Promise<Prescription> {
    if (!input.items.length || input.items.some((item) => !item.medication?.trim())) throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    let patientId = input.patientId;
    let doctorMemberId: string | undefined = input.doctorMemberId;
    let encounterId: string | undefined = input.encounterId;
    if (input.encounterId) {
      const encounter = requireEntity(this.encounters.get(input.encounterId), 'ENCOUNTER_NOT_FOUND');
      if (encounter.tenantId !== input.tenantId) throw httpError('FORBIDDEN', 403);
      encounterId = encounter.id;
      if (!patientId) patientId = encounter.patientId;
      if (!doctorMemberId) doctorMemberId = encounter.doctorMemberId;
    }
    if (!patientId) throw httpError('PATIENT_ID_REQUIRED', 400);
    const prescription: Prescription = {
      id: nanoid(),
      tenantId: input.tenantId,
      encounterId: encounterId ?? '',
      patientId,
      doctorMemberId,
      items: input.items,
      notes: input.notes,
      status: 'draft',
      createdAt: now(),
    };
    this.prescriptions.set(prescription.id, prescription);
    return prescription;
  }

  async updatePrescription(prescriptionId: string, patch: PrescriptionPatch): Promise<Prescription> {
    const current = requireEntity(this.prescriptions.get(prescriptionId), 'PRESCRIPTION_NOT_FOUND');
    if (current.status !== 'draft') throw httpError('PRESCRIPTION_NOT_DRAFT', 409);
    if (patch.items && (!patch.items.length || patch.items.some((item) => !item.medication?.trim()))) {
      throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    }
    const next = { ...current, ...patch };
    this.prescriptions.set(prescriptionId, next);
    return next;
  }

  async issuePrescription(prescriptionId: string): Promise<Prescription> {
    const current = requireEntity(this.prescriptions.get(prescriptionId), 'PRESCRIPTION_NOT_FOUND');
    if (current.status !== 'draft') throw httpError('PRESCRIPTION_NOT_DRAFT', 409);
    if (!current.items.length) throw httpError('PRESCRIPTION_ITEMS_REQUIRED', 400);
    const next = { ...current, status: 'issued' as const, issuedAt: now() };
    this.prescriptions.set(prescriptionId, next);
    return next;
  }

  async listInvoices(tenantId: string, filters?: { patientId?: string; status?: Invoice['status'] }): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.status && item.status !== filters.status) return false;
      return true;
    });
  }

  async getInvoice(invoiceId: string): Promise<Invoice | undefined> {
    return this.invoices.get(invoiceId);
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    if (!this.branches.get(input.branchId) || this.branches.get(input.branchId)?.tenantId !== input.tenantId) throw notFound('BRANCH_NOT_FOUND');
    if (!this.patients.get(input.patientId) || this.patients.get(input.patientId)?.tenantId !== input.tenantId) throw notFound('PATIENT_NOT_FOUND');
    const totals = finalizeInvoiceFields({ lines: input.lines, discountKobo: input.discountKobo, taxKobo: input.taxKobo });
    this.invoiceSeq += 1;
    const invoice: Invoice = {
      id: nanoid(),
      tenantId: input.tenantId,
      branchId: input.branchId,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      encounterId: input.encounterId,
      invoiceNumber: `INV-${this.invoiceSeq.toString().padStart(5, '0')}`,
      lines: input.lines,
      currency: input.currency ?? 'NGN',
      issuedAt: undefined,
      createdAt: now(),
      ...totals,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
  }

  async updateInvoice(invoiceId: string, patch: InvoicePatch): Promise<Invoice> {
    const current = requireEntity(this.invoices.get(invoiceId), 'INVOICE_NOT_FOUND');
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
    const next = { ...current, lines, issuedAt, ...totals };
    this.invoices.set(invoiceId, next);
    return next;
  }

  async issueInvoice(invoiceId: string): Promise<Invoice> {
    const current = requireEntity(this.invoices.get(invoiceId), 'INVOICE_NOT_FOUND');
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
    const next = { ...current, issuedAt, ...totals };
    this.invoices.set(invoiceId, next);
    return next;
  }

  async recordInvoicePayment(invoiceId: string, amountKobo: number): Promise<Invoice> {
    const current = requireEntity(this.invoices.get(invoiceId), 'INVOICE_NOT_FOUND');
    const next = applyInvoicePayment(current, amountKobo);
    this.invoices.set(invoiceId, next);
    return next;
  }

  async voidInvoice(invoiceId: string): Promise<Invoice> {
    const current = requireEntity(this.invoices.get(invoiceId), 'INVOICE_NOT_FOUND');
    const totals = finalizeInvoiceFields({
      lines: current.lines,
      discountKobo: current.discountKobo,
      taxKobo: current.taxKobo,
      amountPaidKobo: current.amountPaidKobo,
      issuedAt: current.issuedAt,
      voided: true,
    });
    const next = { ...current, ...totals };
    this.invoices.set(invoiceId, next);
    return next;
  }

  async listPatientDocuments(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<PatientDocument[]> {
    return [...this.patientDocuments.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      return true;
    });
  }

  async createPatientDocument(input: PatientDocumentInput): Promise<PatientDocument> {
    const patient = requireEntity(this.patients.get(input.patientId), 'PATIENT_NOT_FOUND');
    if (patient.tenantId !== input.tenantId) throw httpError('FORBIDDEN', 403);
    if (input.encounterId) {
      const encounter = requireEntity(this.encounters.get(input.encounterId), 'ENCOUNTER_NOT_FOUND');
      if (encounter.tenantId !== input.tenantId || encounter.patientId !== input.patientId) throw httpError('ENCOUNTER_MISMATCH', 400);
    }
    const document: PatientDocument = {
      id: nanoid(),
      tenantId: input.tenantId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      title: input.title,
      documentType: input.documentType,
      fileUrl: input.fileUrl,
      notes: input.notes,
      createdAt: now(),
    };
    this.patientDocuments.set(document.id, document);
    return document;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | undefined> {
    return [...this.tenants.values()].find((tenant) => tenant.slug === slug);
  }

  async listPatientAccounts(tenantId: string): Promise<PatientAccount[]> {
    return [...this.patientAccounts.values()].filter((item) => item.tenantId === tenantId);
  }

  async getPatientAccount(accountId: string): Promise<PatientAccount | undefined> {
    return this.patientAccounts.get(accountId);
  }

  async findPatientAccountByEmail(tenantId: string, email: string): Promise<PatientAccount | undefined> {
    const normalized = email.toLowerCase();
    return [...this.patientAccounts.values()].find((item) => item.tenantId === tenantId && item.email === normalized);
  }

  async findPatientAccountByActivationTokenHash(tokenHash: string): Promise<PatientAccount | undefined> {
    return [...this.patientAccounts.values()].find((item) => item.activationTokenHash === tokenHash);
  }

  async findPatientAccountByPasswordResetTokenHash(tokenHash: string): Promise<PatientAccount | undefined> {
    return [...this.patientAccounts.values()].find((item) => item.passwordResetTokenHash === tokenHash);
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
    if (!this.tenants.has(input.tenantId)) throw notFound('TENANT_NOT_FOUND');
    if (!this.patients.has(input.patientId)) throw notFound('PATIENT_NOT_FOUND');
    const email = input.email.toLowerCase();
    if ([...this.patientAccounts.values()].some((item) => item.tenantId === input.tenantId && item.email === email)) {
      throw httpError('PATIENT_EMAIL_TAKEN', 409);
    }
    if ([...this.patientAccounts.values()].some((item) => item.tenantId === input.tenantId && item.patientId === input.patientId)) {
      throw httpError('PATIENT_ACCOUNT_EXISTS', 409);
    }
    const account: PatientAccount = {
      id: nanoid(),
      tenantId: input.tenantId,
      patientId: input.patientId,
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      activationTokenHash: input.activationTokenHash,
      activationTokenExpiresAt: input.activationTokenExpiresAt,
      activationTokenUsedAt: input.activationTokenUsedAt,
      status: input.status,
      createdAt: now(),
    };
    this.patientAccounts.set(account.id, account);
    return account;
  }

  async updatePatientAccount(
    accountId: string,
    patch: Partial<Omit<PatientAccount, 'id' | 'tenantId' | 'patientId' | 'email' | 'createdAt'>>,
  ): Promise<PatientAccount> {
    const current = requireEntity(this.patientAccounts.get(accountId), 'PATIENT_ACCOUNT_NOT_FOUND');
    const next = { ...current, ...patch };
    this.patientAccounts.set(accountId, next);
    return next;
  }

  async listNotificationJobs(tenantId: string, filters?: { status?: NotificationJob['status']; type?: NotificationJob['type'] }): Promise<NotificationJob[]> {
    return [...this.notificationJobs.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.status && item.status !== filters.status) return false;
      if (filters?.type && item.type !== filters.type) return false;
      return true;
    });
  }

  async getNotificationJob(jobId: string): Promise<NotificationJob | undefined> {
    return this.notificationJobs.get(jobId);
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
    const job: NotificationJob = {
      id: nanoid(),
      tenantId: input.tenantId,
      patientId: input.patientId,
      memberId: input.memberId,
      channel: input.channel,
      type: input.type,
      recipient: input.recipient,
      subject: input.subject,
      body: input.body,
      status: 'queued',
      scheduledFor: input.scheduledFor,
      createdAt: now(),
    };
    this.notificationJobs.set(job.id, job);
    return job;
  }

  async markNotificationSent(jobId: string, meta?: { provider?: string; providerMessageId?: string }): Promise<NotificationJob> {
    const current = requireEntity(this.notificationJobs.get(jobId), 'NOTIFICATION_NOT_FOUND');
    const next = { ...current, status: 'sent' as const, sentAt: now(), error: undefined, provider: meta?.provider ?? current.provider, providerMessageId: meta?.providerMessageId ?? current.providerMessageId };
    this.notificationJobs.set(jobId, next);
    return next;
  }

  async markNotificationFailed(jobId: string, error: string): Promise<NotificationJob> {
    const current = requireEntity(this.notificationJobs.get(jobId), 'NOTIFICATION_NOT_FOUND');
    const next = { ...current, status: 'failed' as const, error };
    this.notificationJobs.set(jobId, next);
    return next;
  }

  async cancelNotification(jobId: string): Promise<NotificationJob> {
    const current = requireEntity(this.notificationJobs.get(jobId), 'NOTIFICATION_NOT_FOUND');
    const next = { ...current, status: 'cancelled' as const };
    this.notificationJobs.set(jobId, next);
    return next;
  }

  async listAuditLogs(tenantId: string, filters?: { objectType?: string; objectId?: string; action?: string }): Promise<AuditLog[]> {
    return this.auditLogs.filter((item) => {
      if (item.tenantId !== tenantId) return false;
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
    this.auditLogs.push({
      id: nanoid(),
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorMemberId: input.actorMemberId,
      actorPatientAccountId: input.actorPatientAccountId,
      actorType: input.actorType,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      details: input.details,
      createdAt: now(),
    });
  }

  async findSyncOperation(tenantId: string, clientOperationId: string): Promise<SyncOperationRecord | undefined> {
    return this.syncOperations.get(`${tenantId}:${clientOperationId}`);
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
    const record: SyncOperationRecord = {
      id: nanoid(),
      tenantId: input.tenantId,
      clientOperationId: input.clientOperationId,
      entityType: input.entityType,
      operation: input.operation,
      status: input.status,
      serverObjectType: input.serverObjectType,
      serverObjectId: input.serverObjectId,
      error: input.error,
      payloadHash: input.payloadHash,
      createdAt: now(),
    };
    this.syncOperations.set(`${input.tenantId}:${input.clientOperationId}`, record);
    return record;
  }

  // Settings
  async getSettings(tenantId: string): Promise<ClinicSettings | null> {
    return this.settings.get(tenantId) ?? null;
  }

  async upsertSettings(tenantId: string, data: Partial<ClinicSettings>): Promise<ClinicSettings> {
    const existing = this.settings.get(tenantId);
    const settings: ClinicSettings = {
      id: existing?.id ?? nanoid(),
      tenantId,
      clinicName: data.clinicName ?? existing?.clinicName ?? '',
      clinicAddress: data.clinicAddress ?? existing?.clinicAddress ?? '',
      clinicLogoUrl: data.clinicLogoUrl ?? existing?.clinicLogoUrl ?? '',
      brandPrimaryColor: data.brandPrimaryColor ?? existing?.brandPrimaryColor ?? '#66f2ea',
      brandAccentColor: data.brandAccentColor ?? existing?.brandAccentColor ?? '#3b82f6',
      notificationTemplates: data.notificationTemplates ?? existing?.notificationTemplates ?? {},
      paystackPublicKey: data.paystackPublicKey ?? existing?.paystackPublicKey ?? '',
      paystackSecretKey: data.paystackSecretKey ?? existing?.paystackSecretKey ?? '',
      bankName: data.bankName ?? existing?.bankName ?? '',
      bankAccountName: data.bankAccountName ?? existing?.bankAccountName ?? '',
      bankAccountNumber: data.bankAccountNumber ?? existing?.bankAccountNumber ?? '',
      bankTransferEnabled: data.bankTransferEnabled ?? existing?.bankTransferEnabled ?? true,
      smtpHost: data.smtpHost ?? existing?.smtpHost ?? '',
      smtpPort: data.smtpPort ?? existing?.smtpPort ?? 587,
      smtpUser: data.smtpUser ?? existing?.smtpUser ?? '',
      smtpPass: data.smtpPass ?? existing?.smtpPass ?? '',
      smtpFromEmail: data.smtpFromEmail ?? existing?.smtpFromEmail ?? '',
      smtpFromName: data.smtpFromName ?? existing?.smtpFromName ?? '',
      walletBalance: data.walletBalance ?? existing?.walletBalance ?? 0,
      messagingEnabled: data.messagingEnabled ?? existing?.messagingEnabled ?? false,
      whatsappCostPerMsg: data.whatsappCostPerMsg ?? existing?.whatsappCostPerMsg ?? 80,
      smsCostPerMsg: data.smsCostPerMsg ?? existing?.smsCostPerMsg ?? 6,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.settings.set(tenantId, settings);
    return settings;
  }

  // Revenue
  async getRevenueReport(tenantId: string, _from?: string, _to?: string): Promise<{
    daily: Array<{ date: string; totalKobo: number; count: number }>;
    totalRevenueKobo: number;
    totalInvoices: number;
    paidInvoices: number;
    unpaidInvoices: number;
  }> {
    const invoices = [...this.invoices.values()].filter((inv) => inv.tenantId === tenantId);
    const paid = invoices.filter((inv) => inv.status === 'paid' || inv.status === 'part_paid');
    const daily = paid.length > 0
      ? [{ date: paid[0].createdAt.slice(0, 10), totalKobo: paid.reduce((s, i) => s + i.totalKobo, 0), count: paid.length }]
      : [];
    return {
      daily,
      totalRevenueKobo: paid.reduce((s, i) => s + i.totalKobo, 0),
      totalInvoices: invoices.length,
      paidInvoices: paid.length,
      unpaidInvoices: invoices.length - paid.length,
    };
  }

  // Paystack
  async createPaystackTransaction(tenantId: string, invoiceId: string | undefined, reference: string, amountKobo: number): Promise<PaystackTransaction> {
    const tx: PaystackTransaction = {
      id: nanoid(),
      tenantId,
      invoiceId,
      reference,
      amountKobo,
      status: 'pending',
      metadata: {},
      createdAt: now(),
    };
    this.paystackTxs.set(tx.id, tx);
    return tx;
  }

  async updatePaystackTransaction(reference: string, data: { status?: string; channel?: string; paidAt?: string; verifiedAt?: string }): Promise<PaystackTransaction> {
    const existing = [...this.paystackTxs.values()].find((tx) => tx.reference === reference);
    if (!existing) throw notFound('PAYSTACK_TRANSACTION_NOT_FOUND');
    const next = { ...existing, ...data };
    this.paystackTxs.set(existing.id, next);
    return next;
  }

  // Wallet
  async getWalletTransactions(tenantId: string, limit = 50): Promise<WalletTransaction[]> {
    return [...this.walletTransactions.values()]
      .filter((tx) => tx.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async recordWalletTransaction(
    tenantId: string,
    data: {
      amount: number;
      type: WalletTransaction['type'];
      reason: WalletTransaction['reason'];
      messageLogId?: string;
      paystackReference?: string;
      description?: string;
    },
  ): Promise<WalletTransaction> {
    const tx: WalletTransaction = {
      id: nanoid(),
      tenantId,
      amount: data.amount,
      type: data.type,
      reason: data.reason,
      messageLogId: data.messageLogId,
      paystackReference: data.paystackReference,
      description: data.description,
      createdAt: now(),
    };
    this.walletTransactions.set(tx.id, tx);
    return tx;
  }

  // Messages
  async createMessageLog(tenantId: string, data: { channel: string; recipient: string; subject?: string; body: string }): Promise<MessageLog> {
    const log: MessageLog = {
      id: nanoid(),
      tenantId,
      channel: data.channel,
      recipient: data.recipient,
      subject: data.subject,
      body: data.body,
      status: 'queued',
      createdAt: now(),
    };
    this.messageLogs.set(log.id, log);
    return log;
  }

  async updateMessageLog(id: string, data: { status?: string; provider?: string; providerMessageId?: string; sentAt?: string; error?: string }): Promise<MessageLog> {
    const existing = this.messageLogs.get(id);
    if (!existing) throw notFound('MESSAGE_LOG_NOT_FOUND');
    const next = { ...existing, ...data };
    this.messageLogs.set(id, next);
    return next;
  }

  async getMessageLogs(tenantId: string, limit = 50): Promise<MessageLog[]> {
    const all = [...this.messageLogs.values()]
      .filter((log) => log.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return all.slice(0, limit);
  }


  // Referrals
  async listReferrals(tenantId: string, filters?: { patientId?: string; encounterId?: string; toDoctorMemberId?: string; status?: Referral['status'] }): Promise<Referral[]> {
    return [...this.referrals.values()].filter((item) => {
      if (item.tenantId !== tenantId) return false;
      if (filters?.patientId && item.patientId !== filters.patientId) return false;
      if (filters?.encounterId && item.encounterId !== filters.encounterId) return false;
      if (filters?.toDoctorMemberId && item.toDoctorMemberId !== filters.toDoctorMemberId) return false;
      if (filters?.status && item.status !== filters.status) return false;
      return true;
    });
  }
  async createReferral(input: ReferralInput): Promise<Referral> {
    const referral: Referral = { id: nanoid(), tenantId: input.tenantId, encounterId: input.encounterId, patientId: input.patientId, fromDoctorMemberId: input.fromDoctorMemberId, toDoctorMemberId: input.toDoctorMemberId, referralType: input.referralType, specialty: input.specialty, externalClinicName: input.externalClinicName, externalClinicContact: input.externalClinicContact, reason: input.reason, notes: input.notes, status: 'pending', createdAt: now(), updatedAt: now() };
    this.referrals.set(referral.id, referral);
    return referral;
  }
  async updateReferral(referralId: string, patch: Partial<Pick<Referral, 'status' | 'notes' | 'toDoctorMemberId' | 'externalClinicName' | 'externalClinicContact'>>): Promise<Referral> {
    const current = requireEntity(this.referrals.get(referralId), 'REFERRAL_NOT_FOUND');
    const next = { ...current, ...patch, updatedAt: now() };
    this.referrals.set(referralId, next);
    return next;
  }
  // Staff portal messaging
  async listStaffMessages(tenantId: string, memberId: string): Promise<StaffMessage[]> {
    return [...this.staffMessages.values()].filter((item) => item.tenantId === tenantId && (item.senderMemberId === memberId || item.recipientMemberId === memberId || memberId === ''));
  }
  async createStaffMessage(input: StaffMessageInput): Promise<StaffMessage> {
    const msg: StaffMessage = { id: nanoid(), tenantId: input.tenantId, senderMemberId: input.senderMemberId, recipientMemberId: input.recipientMemberId, patientId: input.patientId, encounterId: input.encounterId, referralId: input.referralId, subject: input.subject, body: input.body, createdAt: now() };
    this.staffMessages.set(msg.id, msg);
    return msg;
  }
  async markStaffMessageRead(messageId: string, memberId: string): Promise<StaffMessage> {
    const current = requireEntity(this.staffMessages.get(messageId), 'STAFF_MESSAGE_NOT_FOUND');
    const next = { ...current, readAt: now() };
    this.staffMessages.set(messageId, next);
    return next;
  }
  // Inventory
  async listInventoryItems(tenantId: string): Promise<InventoryItem[]> {
    return [...this.inventoryItems.values()].filter((item) => item.tenantId === tenantId);
  }
  async createInventoryItem(input: InventoryItemInput): Promise<InventoryItem> {
    const item: InventoryItem = { id: nanoid(), tenantId: input.tenantId, name: input.name, sku: input.sku, category: input.category, unit: input.unit, currentStock: input.currentStock ?? 0, reorderLevel: input.reorderLevel ?? 0, unitCostKobo: input.unitCostKobo ?? 0, sellingPriceKobo: input.sellingPriceKobo ?? 0, status: 'active', createdAt: now(), updatedAt: now() };
    this.inventoryItems.set(item.id, item);
    return item;
  }
  async updateInventoryItem(itemId: string, patch: Partial<Pick<InventoryItem, 'name' | 'sku' | 'category' | 'unit' | 'reorderLevel' | 'unitCostKobo' | 'sellingPriceKobo' | 'status'>>): Promise<InventoryItem> {
    const current = requireEntity(this.inventoryItems.get(itemId), 'INVENTORY_ITEM_NOT_FOUND');
    const next = { ...current, ...patch, updatedAt: now() };
    this.inventoryItems.set(itemId, next);
    return next;
  }
  async recordInventoryMovement(itemId: string, data: InventoryMovementInput): Promise<{ item: InventoryItem; movement: InventoryMovement }> {
    const current = requireEntity(this.inventoryItems.get(itemId), 'INVENTORY_ITEM_NOT_FOUND');
    const previousQuantity = current.currentStock;
    const type = data.movementType === 'receive' ? 'purchase' : data.movementType === 'adjust' ? 'adjustment' : data.movementType;
    let delta = 0;
    if (type === 'purchase' || type === 'return') delta = Math.abs(data.quantity);
    if (type === 'dispense' || type === 'usage') delta = -Math.abs(data.quantity);
    if (type === 'adjustment') delta = data.quantity;
    const newQuantity = Math.max(0, previousQuantity + delta);
    const item: InventoryItem = { ...current, currentStock: newQuantity, updatedAt: now() };
    this.inventoryItems.set(itemId, item);
    let batchId = data.batchId;
    if (type === 'purchase') {
      const batch: InventoryBatch = { id: nanoid(), tenantId: data.tenantId, itemId, supplierId: data.supplierId, batchNumber: data.batchNumber, expiryDate: data.expiryDate, quantityRemaining: Math.abs(data.quantity), costPriceKobo: data.costPriceKobo ?? current.unitCostKobo, receivedAt: data.receivedAt ?? now(), createdAt: now(), updatedAt: now() };
      this.inventoryBatches.set(batch.id, batch);
      batchId = batch.id;
    } else if (batchId) {
      const batch = this.inventoryBatches.get(batchId);
      if (batch) this.inventoryBatches.set(batchId, { ...batch, quantityRemaining: Math.max(0, batch.quantityRemaining + delta), updatedAt: now() });
    }
    const movement: InventoryMovement = { id: nanoid(), tenantId: data.tenantId, itemId, batchId, supplierId: data.supplierId, movementType: type, quantity: Math.abs(data.quantity), reference: data.reference, reason: data.reason, notes: data.notes, previousQuantity, newQuantity, costPriceKobo: data.costPriceKobo, batchNumber: data.batchNumber, expiryDate: data.expiryDate, createdByMemberId: data.createdByMemberId, createdAt: now() };
    this.inventoryMovements.set(movement.id, movement);
    return { item, movement };
  }
  async listInventoryMovements(tenantId: string, itemId?: string): Promise<InventoryMovement[]> {
    return [...this.inventoryMovements.values()].filter((mov) => mov.tenantId === tenantId && (!itemId || mov.itemId === itemId));
  }
  async listInventoryBatches(tenantId: string, itemId?: string): Promise<InventoryBatch[]> {
    return [...this.inventoryBatches.values()].filter((batch) => batch.tenantId === tenantId && (!itemId || batch.itemId === itemId));
  }
  async listSuppliers(tenantId: string): Promise<Supplier[]> {
    return [...this.suppliers.values()].filter((supplier) => supplier.tenantId === tenantId);
  }
  async createSupplier(input: SupplierInput): Promise<Supplier> {
    const supplier: Supplier = { id: nanoid(), tenantId: input.tenantId, name: input.name, phone: input.phone, email: input.email, status: 'active', createdAt: now(), updatedAt: now() };
    this.suppliers.set(supplier.id, supplier);
    return supplier;
  }


  async close(): Promise<void> {}
}

export function createMemoryClinicRepository(): MemoryClinicRepository {
  return new MemoryClinicRepository();
}
