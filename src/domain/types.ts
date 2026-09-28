export type Role = 'owner' | 'admin' | 'branch_manager' | 'doctor' | 'receptionist' | 'nurse' | 'accountant' | 'store_manager' | 'viewer';

export type Permission =
  | 'manage_subscription'
  | 'manage_staff'
  | 'manage_branches'
  | 'manage_appointments'
  | 'create_appointment'
  | 'view_patients'
  | 'write_encounter'
  | 'view_billing'
  | 'manage_billing'
  | 'view_reports'
  | 'manage_inventory'
  | 'send_staff_messages'
  | 'manage_referrals';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'trial' | 'suspended';
  createdAt: string;
}

export interface Branch {
  id: string;
  tenantId: string;
  name: string;
  address?: string;
  phone?: string;
  status: 'active' | 'inactive';
  createdAt: string;
}

export interface Member {
  id: string;
  tenantId: string;
  email: string;
  displayName?: string;
  role: Role;
  branchIds: string[];
  status: 'invited' | 'active' | 'revoked';
  phone?: string;
  specialization?: string;
  qualifications?: string;
  licenseNumber?: string;
  createdAt: string;
}

export interface Patient {
  id: string;
  tenantId: string;
  branchId?: string;
  patientCode: string;
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
  createdAt: string;
}

export interface Service {
  id: string;
  tenantId: string;
  branchId?: string;
  name: string;
  durationMinutes: number;
  priceKobo: number;
  currency: 'NGN' | 'USD';
  active: boolean;
}

export interface Appointment {
  id: string;
  tenantId: string;
  branchId: string;
  patientId: string;
  doctorMemberId?: string;
  serviceName: string;
  startsAt: string;
  status: 'requested' | 'confirmed' | 'checked_in' | 'completed' | 'cancelled' | 'no_show';
  notes?: string;
  createdAt: string;
}

export interface DoctorSchedule {
  id: string;
  tenantId: string;
  branchId: string;
  doctorMemberId: string;
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
  active: boolean;
  createdAt: string;
}

export interface EncounterVitals {
  bloodPressure?: string;
  temperatureC?: number;
  weightKg?: number;
  pulseBpm?: number;
}

export interface Encounter {
  id: string;
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  doctorMemberId?: string;
  status: 'open' | 'signed' | 'cancelled';
  reason?: string;
  diagnosis?: string;
  clinicalNotes?: string;
  vitals?: EncounterVitals;
  specialistData?: Record<string, unknown>;
  startedAt: string;
  signedAt?: string;
  createdAt: string;
}


export interface Referral {
  id: string;
  tenantId: string;
  encounterId: string;
  patientId: string;
  fromDoctorMemberId?: string;
  toDoctorMemberId?: string;
  referralType: 'inhouse_specialist' | 'external_clinic';
  specialty?: string;
  externalClinicName?: string;
  externalClinicContact?: string;
  reason: string;
  notes?: string;
  status: 'pending' | 'accepted' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface StaffMessage {
  id: string;
  tenantId: string;
  senderMemberId: string;
  recipientMemberId: string;
  patientId?: string;
  encounterId?: string;
  referralId?: string;
  subject?: string;
  body: string;
  readAt?: string;
  createdAt: string;
}

export interface InventoryItem {
  id: string;
  tenantId: string;
  name: string;
  sku?: string;
  category?: 'Drug' | 'Consumable' | 'Lab Item' | 'Other' | string;
  unit?: string;
  currentStock: number;
  reorderLevel: number;
  unitCostKobo: number;
  sellingPriceKobo: number;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface Supplier {
  id: string;
  tenantId: string;
  name: string;
  phone?: string;
  email?: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface InventoryBatch {
  id: string;
  tenantId: string;
  itemId: string;
  supplierId?: string;
  batchNumber?: string;
  expiryDate?: string;
  quantityRemaining: number;
  costPriceKobo: number;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type InventoryMovementType = 'purchase' | 'dispense' | 'usage' | 'adjustment' | 'return' | 'receive' | 'adjust';

export interface InventoryMovement {
  id: string;
  tenantId: string;
  itemId: string;
  batchId?: string;
  supplierId?: string;
  movementType: InventoryMovementType;
  quantity: number;
  reference?: string;
  reason?: string;
  notes?: string;
  previousQuantity?: number;
  newQuantity?: number;
  costPriceKobo?: number;
  batchNumber?: string;
  expiryDate?: string;
  createdByMemberId?: string;
  createdAt: string;
}

export interface PrescriptionItem {
  medication: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}

export interface Prescription {
  id: string;
  tenantId: string;
  encounterId: string;
  patientId: string;
  doctorMemberId?: string;
  items: PrescriptionItem[];
  notes?: string;
  status: 'draft' | 'issued' | 'cancelled';
  issuedAt?: string;
  createdAt: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceKobo: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  encounterId?: string;
  invoiceNumber: string;
  lines: InvoiceLine[];
  subtotalKobo: number;
  discountKobo: number;
  taxKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  hmoCoverageKobo: number;
  hmoInsuranceId?: string;
  currency: 'NGN' | 'USD';
  status: 'draft' | 'issued' | 'part_paid' | 'paid' | 'void';
  issuedAt?: string;
  createdAt: string;
  balanceKobo: number;
}

export interface HmoInsurance {
  id: string;
  tenantId: string;
  patientId: string;
  hmoName: string;
  hmoNumber?: string;
  coverageType: 'percentage' | 'fixed';
  coverageValue: number;
  active: boolean;
  createdAt: string;
}

export interface PatientDocument {
  id: string;
  tenantId: string;
  patientId: string;
  encounterId?: string;
  title: string;
  documentType: 'report' | 'scan' | 'lab' | 'consent' | 'other';
  fileUrl?: string;
  notes?: string;
  createdAt: string;
}

export interface PatientAccount {
  id: string;
  tenantId: string;
  patientId: string;
  email: string;
  passwordHash?: string;
  activationTokenHash?: string;
  activationTokenExpiresAt?: string;
  activationTokenUsedAt?: string;
  passwordResetTokenHash?: string;
  passwordResetTokenExpiresAt?: string;
  passwordResetTokenUsedAt?: string;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  lastLoginAt?: string;
}

export interface PublicPatientAccount {
  id: string;
  tenantId: string;
  patientId: string;
  email: string;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  lastLoginAt?: string;
  activationTokenExpiresAt?: string;
  activationTokenUsedAt?: string;
}

export interface NotificationJob {
  id: string;
  tenantId: string;
  patientId?: string;
  memberId?: string;
  channel: 'email' | 'sms' | 'whatsapp';
  type:
    | 'patient_portal_invite'
    | 'appointment_created'
    | 'appointment_reminder'
    | 'prescription_issued'
    | 'invoice_issued'
    | 'invoice_payment_received'
    | 'patient_password_reset';
  recipient: string;
  subject?: string;
  body: string;
  status: 'queued' | 'sent' | 'failed' | 'cancelled';
  scheduledFor?: string;
  sentAt?: string;
  error?: string;
  provider?: string;
  providerMessageId?: string;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  tenantId: string;
  actorUserId?: string;
  actorMemberId?: string;
  actorPatientAccountId?: string;
  actorType?: 'staff' | 'patient' | 'system';
  action: string;
  objectType?: string;
  objectId?: string;
  details?: unknown;
  createdAt: string;
}

export interface ClinicSettings {
  id: string;
  tenantId: string;
  clinicName: string;
  clinicAddress: string;
  clinicLogoUrl: string;
  brandPrimaryColor: string;
  brandAccentColor: string;
  notificationTemplates: Record<string, string>;
  paystackPublicKey: string;
  paystackSecretKey: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber?: string;
  bankTransferEnabled?: boolean;
  smtpHost?: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFromEmail: string;
  smtpFromName: string;
  createdAt: string;
  updatedAt: string;
  walletBalance: number;
  messagingEnabled: boolean;
  whatsappCostPerMsg: number;
  smsCostPerMsg: number;
  smsSenderId?: string;
}

export interface WalletTransaction {
  id: string;
  tenantId: string;
  amount: number;
  type: 'credit' | 'debit';
  reason: 'topup' | 'whatsapp_msg' | 'sms_msg';
  messageLogId?: string;
  paystackReference?: string;
  description?: string;
  createdAt: string;
}

export interface PaystackTransaction {
  id: string;
  tenantId: string;
  invoiceId?: string;
  reference: string;
  amountKobo: number;
  status: string;
  channel?: string;
  paidAt?: string;
  verifiedAt?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MessageLog {
  id: string;
  tenantId: string;
  channel: string;
  recipient: string;
  subject?: string;
  body: string;
  status: string;
  provider?: string;
  providerMessageId?: string;
  sentAt?: string;
  error?: string;
  createdAt: string;
}

export interface TenantSnapshot {
  tenant: Tenant;
  settings: Record<string, any>;
  branches: Branch[];
  members: Member[];
  patients: Patient[];
  services: Service[];
  appointments: Appointment[];
  doctorSchedules: DoctorSchedule[];
  encounters: Encounter[];
  prescriptions: Prescription[];
  invoices: Invoice[];
  patientDocuments: PatientDocument[];
  patientAccounts: PublicPatientAccount[];
  notificationJobs: NotificationJob[];
  auditLogs: AuditLog[];
  offlineSync: true;
  referrals: Referral[];
  staffMessages: StaffMessage[];
  inventoryItems: InventoryItem[];
  inventoryBatches: InventoryBatch[];
  inventoryMovements: InventoryMovement[];
  suppliers: Supplier[];
}

export type SyncEntityType = 'patient' | 'appointment' | 'encounter' | 'prescription' | 'invoice' | 'patientDocument';

export interface SyncOperationRecord {
  id: string;
  tenantId: string;
  clientOperationId: string;
  entityType: SyncEntityType;
  operation: 'create' | 'update';
  status: 'synced' | 'failed' | 'conflict';
  serverObjectType?: string;
  serverObjectId?: string;
  error?: string;
  payloadHash: string;
  createdAt: string;
}

export interface SyncOperationInput {
  clientOperationId: string;
  entityType: SyncEntityType;
  operation: 'create' | 'update';
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface SyncOperationResult {
  clientOperationId: string;
  status: 'synced' | 'failed' | 'conflict';
  serverId?: string;
  entityType: SyncEntityType;
  error?: string;
  message?: string;
}
