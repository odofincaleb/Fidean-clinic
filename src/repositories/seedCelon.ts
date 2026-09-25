import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { sendNotificationDryRun } from '../notifications/provider.js';
import type { ClinicRepository } from './ClinicRepository.js';

const DEMO_PATIENT_EMAIL = 'demo.patient@example.com';
const DEMO_PATIENT_PASSWORD = 'Passw0rd123';

export async function seedCelonDemo(repo: ClinicRepository) {
  const tenant = await repo.createTenant({ name: 'Celon Dental Clinic', slug: `celon-dental-${nanoid(6).toLowerCase()}` });
  const lekki = await repo.createBranch({ tenantId: tenant.id, name: 'Lekki Branch', address: 'Lekki, Lagos' });
  const ikeja = await repo.createBranch({ tenantId: tenant.id, name: 'Ikeja Branch', address: 'Ikeja, Lagos' });
  await repo.addMember({ tenantId: tenant.id, email: 'owner@celondentalclinic.com', role: 'owner', displayName: 'Clinic Owner' });
  const doctor = await repo.addMember({
    tenantId: tenant.id,
    branchIds: [lekki.id, ikeja.id],
    email: 'doctor@celondentalclinic.com',
    role: 'doctor',
    displayName: 'Lead Dentist',
  });
  await repo.createService({ tenantId: tenant.id, name: 'Dental Consultation', durationMinutes: 30, priceKobo: 1500000 });
  await repo.createService({ tenantId: tenant.id, name: 'Teeth Cleaning', durationMinutes: 45, priceKobo: 2500000 });
  const patient = await repo.createPatient({
    tenantId: tenant.id,
    firstName: 'Demo',
    lastName: 'Patient',
    phone: '+234****0000',
    email: DEMO_PATIENT_EMAIL,
    dob: '1990-01-15',
    gender: 'male',
    address: '123 Celon Street, Victoria Island',
  });
  await repo.createDoctorSchedule({
    tenantId: tenant.id,
    branchId: lekki.id,
    doctorMemberId: doctor.id,
    weekday: 1,
    startsAt: '09:00',
    endsAt: '17:00',
    slotMinutes: 30,
  });
  await repo.createDoctorSchedule({
    tenantId: tenant.id,
    branchId: ikeja.id,
    doctorMemberId: doctor.id,
    weekday: 2,
    startsAt: '10:00',
    endsAt: '16:00',
    slotMinutes: 30,
  });
  const appointment = await repo.createAppointment({
    tenantId: tenant.id,
    branchId: lekki.id,
    patientId: patient.id,
    doctorMemberId: doctor.id,
    startsAt: '2026-09-14T09:00:00.000Z',
    serviceName: 'Dental Consultation',
  });
  const encounter = await repo.createEncounter({
    tenantId: tenant.id,
    branchId: lekki.id,
    patientId: patient.id,
    appointmentId: appointment.id,
    doctorMemberId: doctor.id,
    reason: 'Tooth pain',
    diagnosis: 'Caries',
    clinicalNotes: 'Demo encounter for Celon Dental.',
    vitals: { bloodPressure: '120/80', temperatureC: 36.8 },
  });
  await repo.signEncounter(encounter.id);
  const prescription = await repo.createPrescription({
    tenantId: tenant.id,
    encounterId: encounter.id,
    patientId: patient.id,
    doctorMemberId: doctor.id,
    items: [{ medication: 'Amoxicillin', dosage: '500mg', frequency: '8 hourly', duration: '5 days', instructions: 'After meals' }],
  });
  await repo.issuePrescription(prescription.id);
  const invoice = await repo.createInvoice({
    tenantId: tenant.id,
    branchId: lekki.id,
    patientId: patient.id,
    appointmentId: appointment.id,
    encounterId: encounter.id,
    lines: [{ description: 'Dental Consultation', quantity: 1, unitPriceKobo: 1500000 }],
  });
  await repo.issueInvoice(invoice.id);
  await repo.createPatientDocument({
    tenantId: tenant.id,
    patientId: patient.id,
    encounterId: encounter.id,
    title: 'Demo panoramic report',
    documentType: 'report',
    fileUrl: 'https://example.invalid/celon-demo-report',
    notes: 'Metadata only',
  });
  const now = new Date().toISOString();
  await repo.createPatientAccount({
    tenantId: tenant.id,
    patientId: patient.id,
    email: DEMO_PATIENT_EMAIL,
    status: 'active',
    passwordHash: await bcrypt.hash(DEMO_PATIENT_PASSWORD, 10),
    activationTokenHash: 'seeded',
    activationTokenExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    activationTokenUsedAt: now,
  });
  const inviteJob = await repo.queueNotification({
    tenantId: tenant.id,
    patientId: patient.id,
    channel: 'email',
    type: 'patient_portal_invite',
    recipient: DEMO_PATIENT_EMAIL,
    subject: 'Activate your clinic portal',
    body: 'Demo queued invite. No external email is sent in this phase.',
  });
  await repo.queueNotification({
    tenantId: tenant.id,
    patientId: patient.id,
    channel: 'email',
    type: 'prescription_issued',
    recipient: DEMO_PATIENT_EMAIL,
    subject: 'Prescription issued',
    body: 'Demo queued prescription notice.',
  });
  await repo.queueNotification({
    tenantId: tenant.id,
    patientId: patient.id,
    channel: 'email',
    type: 'invoice_issued',
    recipient: DEMO_PATIENT_EMAIL,
    subject: 'Invoice issued',
    body: 'Demo queued invoice notice.',
  });
  const dry = await sendNotificationDryRun(inviteJob);
  if (dry.ok) await repo.markNotificationSent(inviteJob.id, { provider: dry.provider, providerMessageId: dry.providerMessageId });

  // Demo staff messages
  const ownerMember = (await repo.listMembers(tenant.id)).find(m => m.role === 'owner');
  if (!ownerMember) { throw new Error('Owner not found — cannot seed staff messages'); }

  await repo.createStaffMessage({
    tenantId: tenant.id,
    senderMemberId: doctor.id,
    recipientMemberId: ownerMember.id,
    subject: 'Welcome to Celon Dental',
    body: 'Hi, welcome to the Celon Dental workspace! This is a demo message from the lead dentist. Let me know if you need any setup changes.',
  });
  const msg2 = await repo.createStaffMessage({
    tenantId: tenant.id,
    senderMemberId: ownerMember.id,
    recipientMemberId: doctor.id,
    subject: 'Lab results update',
    body: 'The panoramic X-ray for Demo Patient is ready for review. Please check the shared drive.',
  });
  await repo.markStaffMessageRead(msg2.id, doctor.id);

  // Demo inventory suppliers, products, purchase batches, and low-stock examples
  const medPlus = await repo.createSupplier({ tenantId: tenant.id, name: 'MedPlus Wholesale', phone: '+234****2200', email: 'supply@example.com' });
  const dentalDepot = await repo.createSupplier({ tenantId: tenant.id, name: 'Dental Depot Lagos', phone: '+234****3300' });
  const amoxicillin = await repo.createInventoryItem({
    tenantId: tenant.id,
    name: 'Amoxicillin 500mg',
    sku: 'AMX-500',
    category: 'Drug',
    unit: 'tablet',
    currentStock: 0,
    reorderLevel: 50,
    unitCostKobo: 45000,
    sellingPriceKobo: 65000,
  });
  await repo.recordInventoryMovement(amoxicillin.id, { tenantId: tenant.id, movementType: 'purchase', quantity: 120, supplierId: medPlus.id, costPriceKobo: 45000, batchNumber: 'AM001', expiryDate: '2026-11-10', reason: 'Opening stock', createdByMemberId: ownerMember.id });
  await repo.recordInventoryMovement(amoxicillin.id, { tenantId: tenant.id, movementType: 'purchase', quantity: 80, supplierId: medPlus.id, costPriceKobo: 44000, batchNumber: 'AM002', expiryDate: '2027-03-15', reason: 'Opening stock', createdByMemberId: ownerMember.id });
  const gloves = await repo.createInventoryItem({
    tenantId: tenant.id,
    name: 'Surgical Gloves (Box)',
    sku: 'SG-100',
    category: 'Consumable',
    unit: 'box',
    currentStock: 0,
    reorderLevel: 20,
    unitCostKobo: 120000,
    sellingPriceKobo: 160000,
  });
  await repo.recordInventoryMovement(gloves.id, { tenantId: tenant.id, movementType: 'purchase', quantity: 15, supplierId: medPlus.id, costPriceKobo: 120000, batchNumber: 'SG2401', expiryDate: '2027-01-30', reason: 'Opening stock', createdByMemberId: ownerMember.id });
  const resin = await repo.createInventoryItem({
    tenantId: tenant.id,
    name: 'Dental Composite Resin',
    sku: 'DCR-01',
    category: 'Other',
    unit: 'syringe',
    currentStock: 0,
    reorderLevel: 10,
    unitCostKobo: 350000,
    sellingPriceKobo: 500000,
  });
  await repo.recordInventoryMovement(resin.id, { tenantId: tenant.id, movementType: 'purchase', quantity: 8, supplierId: dentalDepot.id, costPriceKobo: 350000, batchNumber: 'DCR-EXP', expiryDate: '2026-10-05', reason: 'Opening stock', createdByMemberId: ownerMember.id });
  await repo.recordAuditLog({ tenantId: tenant.id, actorType: 'system', action: 'patient_account_invite', objectType: 'patient_account', objectId: patient.id, details: { email: DEMO_PATIENT_EMAIL } });
  await repo.recordAuditLog({ tenantId: tenant.id, actorType: 'system', action: 'prescription_issue', objectType: 'prescription', objectId: prescription.id });
  await repo.recordAuditLog({ tenantId: tenant.id, actorType: 'system', action: 'invoice_create', objectType: 'invoice', objectId: invoice.id });
  await repo.recordAuditLog({ tenantId: tenant.id, actorType: 'system', action: 'encounter_sign', objectType: 'encounter', objectId: encounter.id });
  return repo.getTenantSnapshot(tenant.id);
}
