import type {
  Appointment,
  AuditLog,
  Branch,
  ClinicSettings,
  DoctorSchedule,
  Encounter,
  EncounterVitals,
  InventoryItem,
  InventoryBatch,
  InventoryMovement,
  Invoice,
  InvoiceLine,
  Member,
  MessageLog,
  NotificationJob,
  Patient,
  PatientAccount,
  PatientDocument,
  PaystackTransaction,
  Prescription,
  Referral,
  PrescriptionItem,
  Service,
  StaffMessage,
  Supplier,
  SyncEntityType,
  SyncOperationRecord,
  Tenant,
  TenantSnapshot,
  WalletTransaction,
} from '../domain/types.js';

export interface TenantInput {
  name: string;
  slug: string;
}

export interface BranchInput {
  tenantId: string;
  name: string;
  address?: string;
  phone?: string;
}

export interface MemberInput {
  tenantId: string;
  email: string;
  role: Member['role'];
  additionalRoles?: Member['role'][];
  branchIds?: string[];
  displayName?: string;
  phone?: string;
  specialization?: string;
  qualifications?: string;
  licenseNumber?: string;
}

export interface PatientInput {
  tenantId: string;
  branchId?: string;
  clinicPatientId?: string;
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  altPhone?: string;
  dob?: string;
  gender?: string;
  bloodGroup?: string;
  address?: string;
  city?: string;
  state?: string;
  medicalHistory?: string;
}

export interface ServiceInput {
  tenantId: string;
  branchId?: string;
  name: string;
  durationMinutes?: number;
  priceKobo?: number;
  currency?: Service['currency'];
}

export interface AppointmentInput {
  tenantId: string;
  branchId: string;
  patientId: string;
  startsAt: string;
  serviceName: string;
  doctorMemberId?: string;
  serviceId?: string;
  notes?: string;
}

export interface AppointmentListFilters {
  branchId?: string;
  doctorMemberId?: string;
  from?: string;
  to?: string;
  status?: Appointment['status'];
}

export interface DoctorScheduleInput {
  tenantId: string;
  branchId: string;
  doctorMemberId: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotMinutes?: number;
}

export interface EncounterInput {
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  doctorMemberId?: string;
  reason?: string;
  diagnosis?: string;
  clinicalNotes?: string;
  vitals?: EncounterVitals;
  specialistData?: Record<string, unknown>;
}

export type EncounterPatch = Partial<Pick<Encounter, 'reason' | 'diagnosis' | 'clinicalNotes' | 'vitals' | 'doctorMemberId' | 'status' | 'specialistData'>>;


export interface ReferralInput {
  tenantId: string;
  encounterId: string;
  patientId: string;
  fromDoctorMemberId?: string;
  toDoctorMemberId?: string;
  referralType: Referral['referralType'];
  specialty?: string;
  externalClinicName?: string;
  externalClinicContact?: string;
  reason: string;
  notes?: string;
}

export interface StaffMessageInput {
  tenantId: string;
  senderMemberId: string;
  recipientMemberId: string;
  patientId?: string;
  encounterId?: string;
  referralId?: string;
  subject?: string;
  body: string;
}

export interface InventoryItemInput {
  tenantId: string;
  name: string;
  sku?: string;
  category?: string;
  unit?: string;
  currentStock?: number;
  reorderLevel?: number;
  unitCostKobo?: number;
  sellingPriceKobo?: number;
}

export interface SupplierInput {
  tenantId: string;
  name: string;
  phone?: string;
  email?: string;
}

export interface InventoryMovementInput {
  tenantId: string;
  movementType: InventoryMovement['movementType'];
  quantity: number;
  batchId?: string;
  supplierId?: string;
  reference?: string;
  reason?: string;
  notes?: string;
  costPriceKobo?: number;
  batchNumber?: string;
  expiryDate?: string;
  receivedAt?: string;
  createdByMemberId?: string;
}

export interface PrescriptionInput {
  tenantId: string;
  encounterId?: string;
  patientId?: string;
  doctorMemberId?: string;
  items: PrescriptionItem[];
  notes?: string;
}

export type PrescriptionPatch = Partial<Pick<Prescription, 'items' | 'notes' | 'doctorMemberId'>>;

export interface InvoiceInput {
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  encounterId?: string;
  lines: InvoiceLine[];
  discountKobo?: number;
  taxKobo?: number;
  hmoInsuranceId?: string;
  hmoCoverageKobo?: number;
  currency?: Invoice['currency'];
}

export type InvoicePatch = Partial<Pick<Invoice, 'lines' | 'discountKobo' | 'taxKobo' | 'issuedAt' | 'hmoCoverageKobo' | 'hmoInsuranceId'>>;

export interface PatientDocumentInput {
  tenantId: string;
  patientId: string;
  encounterId?: string;
  title: string;
  documentType: PatientDocument['documentType'];
  fileUrl?: string;
  notes?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  displayName?: string;
  isSuperAdmin?: boolean;
}

export interface ClinicRepository {
  storageMode(): 'postgres' | 'memory';
  listTenants(): Promise<Tenant[]>;
  getTenant(tenantId: string): Promise<Tenant | undefined>;
  createTenant(input: TenantInput): Promise<Tenant>;
  updateTenant(tenantId: string, patch: Partial<Pick<Tenant, 'name' | 'status' | 'slug'>>): Promise<Tenant>;

  listBranches(tenantId: string): Promise<Branch[]>;
  getBranch(branchId: string): Promise<Branch | undefined>;
  createBranch(input: BranchInput): Promise<Branch>;
  updateBranch(branchId: string, patch: Partial<Pick<Branch, 'name' | 'address' | 'phone' | 'status'>>): Promise<Branch>;
  deleteBranch(branchId: string): Promise<void>;

  listMembers(tenantId: string): Promise<Member[]>;
  getMember(memberId: string): Promise<Member | undefined>;
  updateMember(memberId: string, patch: Partial<Pick<Member, 'displayName' | 'role' | 'additionalRoles' | 'phone' | 'specialization'>>): Promise<Member>;
  deleteMember(memberId: string): Promise<void>;
  addMember(input: MemberInput): Promise<Member>;
  updateMember(memberId: string, patch: Partial<Pick<Member, 'displayName' | 'role' | 'additionalRoles' | 'branchIds' | 'status' | 'phone' | 'specialization' | 'qualifications' | 'licenseNumber'>>): Promise<Member>;

  listPatients(tenantId: string): Promise<Patient[]>;
  getPatient(patientId: string): Promise<Patient | undefined>;
  createPatient(input: PatientInput): Promise<Patient>;
  updatePatient(patientId: string, patch: Partial<Pick<Patient, 'branchId' | 'clinicPatientId' | 'firstName' | 'lastName' | 'phone' | 'email' | 'altPhone' | 'dob' | 'gender' | 'bloodGroup' | 'address' | 'city' | 'state' | 'medicalHistory'>>): Promise<Patient>;

  listServices(tenantId: string): Promise<Service[]>;
  getService(serviceId: string): Promise<Service | undefined>;
  createService(input: ServiceInput): Promise<Service>;
  deleteService(serviceId: string): Promise<void>;
  listHmoInsurances(tenantId: string, patientId?: string): Promise<HmoInsurance[]>;
  getHmoInsurance(id: string): Promise<HmoInsurance | undefined>;
  createHmoInsurance(input: Omit<HmoInsurance, 'id' | 'createdAt'>): Promise<HmoInsurance>;
  updateHmoInsurance(id: string, patch: Partial<Pick<HmoInsurance, 'hmoName' | 'hmoNumber' | 'coverageType' | 'coverageValue' | 'active'>>): Promise<HmoInsurance>;
  deleteHmoInsurance(id: string): Promise<void>;

  updateService(serviceId: string, patch: Partial<Pick<Service, 'name' | 'durationMinutes' | 'priceKobo' | 'currency' | 'active' | 'branchId'>>): Promise<Service>;

  listAppointments(tenantId: string, filters?: AppointmentListFilters): Promise<Appointment[]>;
  getAppointment(appointmentId: string): Promise<Appointment | undefined>;
  createAppointment(input: AppointmentInput): Promise<Appointment>;
  updateAppointment(appointmentId: string, patch: Partial<Pick<Appointment, 'startsAt' | 'serviceName' | 'doctorMemberId' | 'notes'>>): Promise<Appointment>;
  transitionAppointment(appointmentId: string, status: Appointment['status']): Promise<Appointment>;

  visibleBranchesForMember(memberId: string): Promise<Branch[]>;
  getTenantSnapshot(tenantId: string): Promise<TenantSnapshot>;
  seedCelonDemo(): Promise<TenantSnapshot>;
  close(): Promise<void>;

  findUserByEmail(email: string): Promise<AuthUser | undefined>;
  createUser(input: { email: string; passwordHash: string; displayName?: string }): Promise<{ id: string; email: string }>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  findActiveMembershipByUserId(userId: string): Promise<Member | undefined>;
  findMembershipByEmail(tenantId: string, email: string): Promise<Member | undefined>;
  linkUserToMembership(membershipId: string, userId: string): Promise<void>;

  listDoctorSchedules(tenantId: string, filters?: { branchId?: string; doctorMemberId?: string }): Promise<DoctorSchedule[]>;
  getDoctorSchedule(scheduleId: string): Promise<DoctorSchedule | undefined>;
  createDoctorSchedule(input: DoctorScheduleInput): Promise<DoctorSchedule>;
  updateDoctorSchedule(scheduleId: string, patch: Partial<Pick<DoctorSchedule, 'startsAt' | 'endsAt' | 'slotMinutes' | 'active'>>): Promise<DoctorSchedule>;
  deleteDoctorSchedule(scheduleId: string): Promise<void>;

  listEncounters(tenantId: string, filters?: { patientId?: string; branchId?: string; appointmentId?: string }): Promise<Encounter[]>;
  getEncounter(encounterId: string): Promise<Encounter | undefined>;
  createEncounter(input: EncounterInput): Promise<Encounter>;
  updateEncounter(encounterId: string, patch: EncounterPatch): Promise<Encounter>;
  signEncounter(encounterId: string, doctorMemberId?: string): Promise<Encounter>;
  deleteEncounter(encounterId: string): Promise<void>;

  listPrescriptions(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<Prescription[]>;
  getPrescription(prescriptionId: string): Promise<Prescription | undefined>;
  createPrescription(input: PrescriptionInput): Promise<Prescription>;
  updatePrescription(prescriptionId: string, patch: PrescriptionPatch): Promise<Prescription>;
  issuePrescription(prescriptionId: string): Promise<Prescription>;

  listInvoices(tenantId: string, filters?: { patientId?: string; status?: Invoice['status'] }): Promise<Invoice[]>;
  getInvoice(invoiceId: string): Promise<Invoice | undefined>;
  createInvoice(input: InvoiceInput): Promise<Invoice>;
  updateInvoice(invoiceId: string, patch: InvoicePatch): Promise<Invoice>;
  recordInvoicePayment(invoiceId: string, amountKobo: number): Promise<Invoice>;
  voidInvoice(invoiceId: string): Promise<Invoice>;

  listPatientDocuments(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<PatientDocument[]>;
  createPatientDocument(input: PatientDocumentInput): Promise<PatientDocument>;

  getTenantBySlug(slug: string): Promise<Tenant | undefined>;

  listPatientAccounts(tenantId: string): Promise<PatientAccount[]>;
  getPatientAccount(accountId: string): Promise<PatientAccount | undefined>;
  findPatientAccountByEmail(tenantId: string, email: string): Promise<PatientAccount | undefined>;
  findPatientAccountByActivationTokenHash(tokenHash: string): Promise<PatientAccount | undefined>;
  findPatientAccountByPasswordResetTokenHash(tokenHash: string): Promise<PatientAccount | undefined>;
  createPatientAccount(input: {
    tenantId: string;
    patientId: string;
    email: string;
    status: PatientAccount['status'];
    passwordHash?: string;
    activationTokenHash?: string;
    activationTokenExpiresAt?: string;
    activationTokenUsedAt?: string;
  }): Promise<PatientAccount>;
  updatePatientAccount(accountId: string, patch: Partial<Omit<PatientAccount, 'id' | 'tenantId' | 'patientId' | 'email' | 'createdAt'>>): Promise<PatientAccount>;

  listNotificationJobs(tenantId: string, filters?: { status?: NotificationJob['status']; type?: NotificationJob['type'] }): Promise<NotificationJob[]>;
  getNotificationJob(jobId: string): Promise<NotificationJob | undefined>;
  queueNotification(input: {
    tenantId: string;
    patientId?: string;
    memberId?: string;
    channel: NotificationJob['channel'];
    type: NotificationJob['type'];
    recipient: string;
    subject?: string;
    body: string;
    scheduledFor?: string;
  }): Promise<NotificationJob>;
  markNotificationSent(jobId: string, meta?: { provider?: string; providerMessageId?: string }): Promise<NotificationJob>;
  markNotificationFailed(jobId: string, error: string): Promise<NotificationJob>;
  cancelNotification(jobId: string): Promise<NotificationJob>;

  issueInvoice(invoiceId: string): Promise<Invoice>;

  listAuditLogs(tenantId: string, filters?: { objectType?: string; objectId?: string; action?: string }): Promise<AuditLog[]>;
  findSyncOperation(tenantId: string, clientOperationId: string): Promise<SyncOperationRecord | undefined>;
  recordSyncOperation(input: {
    tenantId: string;
    clientOperationId: string;
    entityType: SyncEntityType;
    operation: 'create' | 'update';
    status: SyncOperationRecord['status'];
    serverObjectType?: string;
    serverObjectId?: string;
    error?: string;
    payloadHash: string;
  }): Promise<SyncOperationRecord>;

  recordAuditLog(input: {
    tenantId: string;
    actorUserId?: string;
    actorMemberId?: string;
    actorPatientAccountId?: string;
    actorType?: 'staff' | 'patient' | 'system';
    action: string;
    objectType?: string;
    objectId?: string;
    details?: unknown;
  }): Promise<void>;


  // Referrals
  listReferrals(tenantId: string, filters?: { patientId?: string; encounterId?: string; toDoctorMemberId?: string; status?: Referral['status'] }): Promise<Referral[]>;
  createReferral(input: ReferralInput): Promise<Referral>;
  updateReferral(referralId: string, patch: Partial<Pick<Referral, 'status' | 'notes' | 'toDoctorMemberId' | 'externalClinicName' | 'externalClinicContact'>>): Promise<Referral>;

  // Staff portal messaging
  listStaffMessages(tenantId: string, memberId: string): Promise<StaffMessage[]>;
  createStaffMessage(input: StaffMessageInput): Promise<StaffMessage>;
  markStaffMessageRead(messageId: string, memberId: string): Promise<StaffMessage>;

  // Inventory
  listInventoryItems(tenantId: string): Promise<InventoryItem[]>;
  createInventoryItem(input: InventoryItemInput): Promise<InventoryItem>;
  updateInventoryItem(itemId: string, patch: Partial<Pick<InventoryItem, 'name' | 'sku' | 'category' | 'unit' | 'reorderLevel' | 'unitCostKobo' | 'sellingPriceKobo' | 'status'>>): Promise<InventoryItem>;
  recordInventoryMovement(itemId: string, data: InventoryMovementInput): Promise<{ item: InventoryItem; movement: InventoryMovement }>;
  listInventoryMovements(tenantId: string, itemId?: string): Promise<InventoryMovement[]>;
  listInventoryBatches(tenantId: string, itemId?: string): Promise<InventoryBatch[]>;
  listSuppliers(tenantId: string): Promise<Supplier[]>;
  createSupplier(input: SupplierInput): Promise<Supplier>;

  // Settings
  getSettings(tenantId: string): Promise<ClinicSettings | null>;
  upsertSettings(tenantId: string, data: Partial<ClinicSettings>): Promise<ClinicSettings>;

  // Revenue Reports
  getRevenueReport(tenantId: string, from?: string, to?: string): Promise<{
    daily: Array<{ date: string; totalKobo: number; count: number }>;
    totalRevenueKobo: number;
    totalInvoices: number;
    paidInvoices: number;
    unpaidInvoices: number;
  }>;

  // Paystack
  createPaystackTransaction(tenantId: string, invoiceId: string | undefined, reference: string, amountKobo: number): Promise<PaystackTransaction>;
  updatePaystackTransaction(reference: string, data: { status?: string; channel?: string; paidAt?: string; verifiedAt?: string }): Promise<PaystackTransaction>;

  // Wallet
  getWalletTransactions(tenantId: string, limit?: number): Promise<WalletTransaction[]>;
  recordWalletTransaction(tenantId: string, data: {
    amount: number;
    type: WalletTransaction['type'];
    reason: WalletTransaction['reason'];
    messageLogId?: string;
    paystackReference?: string;
    description?: string;
  }): Promise<WalletTransaction>;

  // Messages
  createMessageLog(tenantId: string, data: { channel: string; recipient: string; subject?: string; body: string }): Promise<MessageLog>;
  updateMessageLog(id: string, data: { status?: string; provider?: string; providerMessageId?: string; sentAt?: string; error?: string }): Promise<MessageLog>;
  getMessageLogs(tenantId: string, limit?: number): Promise<MessageLog[]>;
}
