import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertBranchAccess, assertCan, canPerform } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import { audit, queuePatientNotification, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const vitals = z.object({
  bloodPressure: z.string().optional(),
  temperatureC: z.number().optional(),
  weightKg: z.number().optional(),
  pulseBpm: z.number().optional(),
}).optional();

function canManageSchedules(role: string): boolean {
  return role === 'owner' || role === 'admin' || role === 'branch_manager';
}

export function registerClinicalRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/doctor-schedules', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({ branchId: z.string().optional(), doctorMemberId: z.string().optional() }).parse(request.query);
    let schedules = await repo.listDoctorSchedules(auth.tenantId, query);
    if (auth.member.role === 'branch_manager') {
      schedules = schedules.filter((item) => auth.member.branchIds.includes(item.branchId));
    }
    return { ok: true, schedules };
  });

  app.post('/api/doctor-schedules', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canManageSchedules(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const input = z.object({
      tenantId: z.string(),
      branchId: z.string(),
      doctorMemberId: z.string(),
      weekday: z.number().int().min(0).max(6),
      startsAt: time,
      endsAt: time,
      slotMinutes: z.number().int().min(5).optional(),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, input.branchId);
    return reply.code(201).send({ ok: true, schedule: await repo.createDoctorSchedule(input) });
  });

  app.patch('/api/doctor-schedules/:scheduleId', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageSchedules(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ scheduleId: z.string() }).parse(request.params);
    const schedule = await repo.getDoctorSchedule(params.scheduleId);
    if (!schedule) throw httpError('SCHEDULE_NOT_FOUND', 404);
    if (schedule.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, schedule.branchId);
    const patch = z.object({
      startsAt: time.optional(),
      endsAt: time.optional(),
      slotMinutes: z.number().int().min(5).optional(),
      active: z.boolean().optional(),
    }).parse(request.body);
    return { ok: true, schedule: await repo.updateDoctorSchedule(params.scheduleId, patch) };
  });

  app.delete('/api/doctor-schedules/:scheduleId', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canManageSchedules(auth.member.role)) throw httpError('FORBIDDEN', 403);
    const params = z.object({ scheduleId: z.string() }).parse(request.params);
    const schedule = await repo.getDoctorSchedule(params.scheduleId);
    if (!schedule) throw httpError('SCHEDULE_NOT_FOUND', 404);
    if (schedule.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, schedule.branchId);
    await repo.deleteDoctorSchedule(params.scheduleId);
    return { ok: true };
  });

  app.get('/api/encounters', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'view_patients');
    const query = z.object({
      patientId: z.string().optional(),
      branchId: z.string().optional(),
      appointmentId: z.string().optional(),
    }).parse(request.query);
    let encounters = await repo.listEncounters(auth.tenantId, query);
    if (auth.member.role !== 'owner' && auth.member.role !== 'admin') {
      encounters = encounters.filter((item) => auth.member.branchIds.includes(item.branchId));
    }
    return { ok: true, encounters };
  });

  app.post('/api/encounters', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const input = z.object({
      tenantId: z.string(),
      branchId: z.string(),
      patientId: z.string(),
      appointmentId: z.string().optional(),
      doctorMemberId: z.string().optional(),
      reason: z.string().optional(),
      diagnosis: z.string().optional(),
      clinicalNotes: z.string().optional(),
      vitals,
      specialistData: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, input.branchId);
    return reply.code(201).send({ ok: true, encounter: await repo.createEncounter(input) });
  });

  app.patch('/api/encounters/:encounterId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const params = z.object({ encounterId: z.string() }).parse(request.params);
    const encounter = await repo.getEncounter(params.encounterId);
    if (!encounter) throw httpError('ENCOUNTER_NOT_FOUND', 404);
    if (encounter.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, encounter.branchId);
    const patch = z.object({
      reason: z.string().optional(),
      diagnosis: z.string().optional(),
      clinicalNotes: z.string().optional(),
      doctorMemberId: z.string().optional(),
      vitals,
      specialistData: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    return { ok: true, encounter: await repo.updateEncounter(params.encounterId, patch) };
  });

  // Sign encounter (also records the signing doctor)
  app.post('/api/encounters/:encounterId/sign', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const params = z.object({ encounterId: z.string() }).parse(request.params);
    const encounter = await repo.getEncounter(params.encounterId);
    if (!encounter) throw httpError('ENCOUNTER_NOT_FOUND', 404);
    if (encounter.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, encounter.branchId);
    const signed = await repo.signEncounter(params.encounterId, auth.member.id);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'encounter_sign', objectType: 'encounter', objectId: signed.id });
    return { ok: true, encounter: signed };
  });

  app.delete('/api/encounters/:encounterId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const params = z.object({ encounterId: z.string() }).parse(request.params);
    const encounter = await repo.getEncounter(params.encounterId);
    if (!encounter) throw httpError('ENCOUNTER_NOT_FOUND', 404);
    if (encounter.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    assertBranchAccess(auth.member, encounter.branchId);
    await repo.deleteEncounter(params.encounterId);
    return { ok: true };
  });

  app.get('/api/prescriptions', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'view_patients');
    const query = z.object({ patientId: z.string().optional(), encounterId: z.string().optional() }).parse(request.query);
    return { ok: true, prescriptions: await repo.listPrescriptions(auth.tenantId, query) };
  });

  app.post('/api/prescriptions', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const input = z.object({
      tenantId: z.string(),
      encounterId: z.string().optional(),
      patientId: z.string().optional(),
      doctorMemberId: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(z.object({
        medication: z.string().min(1),
        dosage: z.string().optional(),
        frequency: z.string().optional(),
        duration: z.string().optional(),
        instructions: z.string().optional(),
      })).min(1),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    if (input.encounterId) {
      const encounter = await repo.getEncounter(input.encounterId);
      if (!encounter) throw httpError('ENCOUNTER_NOT_FOUND', 404);
      if (encounter.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
      assertBranchAccess(auth.member, encounter.branchId);
    } else {
      if (!input.patientId) throw httpError('PATIENT_ID_REQUIRED', 400);
      const patient = await repo.getPatient(input.patientId);
      if (!patient) throw httpError('PATIENT_NOT_FOUND', 404);
    }
    return reply.code(201).send({ ok: true, prescription: await repo.createPrescription(input) });
  });

  app.patch('/api/prescriptions/:prescriptionId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    const params = z.object({ prescriptionId: z.string() }).parse(request.params);
    const prescription = await repo.getPrescription(params.prescriptionId);
    if (!prescription) throw httpError('PRESCRIPTION_NOT_FOUND', 404);
    if (prescription.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const patch = z.object({
      notes: z.string().optional(),
      doctorMemberId: z.string().optional(),
      items: z.array(z.object({
        medication: z.string().min(1),
        dosage: z.string().optional(),
        frequency: z.string().optional(),
        duration: z.string().optional(),
        instructions: z.string().optional(),
      })).min(1).optional(),
    }).parse(request.body);
    return { ok: true, prescription: await repo.updatePrescription(params.prescriptionId, patch) };
  });

  app.post('/api/prescriptions/:prescriptionId/issue', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'write_encounter');
    if (auth.member.role === 'nurse') throw httpError('FORBIDDEN', 403);
    const params = z.object({ prescriptionId: z.string() }).parse(request.params);
    const prescription = await repo.getPrescription(params.prescriptionId);
    if (!prescription) throw httpError('PRESCRIPTION_NOT_FOUND', 404);
    if (prescription.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const issued = await repo.issuePrescription(params.prescriptionId);
    await queuePatientNotification(repo, {
      tenantId: auth.tenantId,
      patientId: issued.patientId,
      memberId: auth.member.id,
      type: 'prescription_issued',
      subject: 'Prescription issued',
      body: 'A prescription was issued. Sending providers are not connected yet.',
    });
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'prescription_issue', objectType: 'prescription', objectId: issued.id });
    return { ok: true, prescription: issued };
  });

  app.get('/api/invoices', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'view_billing') && !canPerform(auth.member.role, 'manage_billing')) {
      throw httpError('FORBIDDEN', 403);
    }
    const query = z.object({
      patientId: z.string().optional(),
      status: z.enum(['draft', 'issued', 'part_paid', 'paid', 'void']).optional(),
    }).parse(request.query);
    let invoices = await repo.listInvoices(auth.tenantId, query);
    if (auth.member.role === 'branch_manager') {
      invoices = invoices.filter((item) => auth.member.branchIds.includes(item.branchId));
    }
    return { ok: true, invoices };
  });

  app.post('/api/invoices', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const input = z.object({
      tenantId: z.string(),
      branchId: z.string(),
      patientId: z.string(),
      appointmentId: z.string().optional(),
      encounterId: z.string().optional(),
      discountKobo: z.number().int().nonnegative().optional(),
      taxKobo: z.number().int().nonnegative().optional(),
      hmoInsuranceId: z.string().optional(),
      hmoCoverageKobo: z.number().int().nonnegative().optional(),
      currency: z.enum(['NGN', 'USD']).optional(),
      lines: z.array(z.object({
        description: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPriceKobo: z.number().int().nonnegative(),
        inventoryItemId: z.string().optional(),
      })).min(1),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const invoice = await repo.createInvoice(input);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'invoice_create', objectType: 'invoice', objectId: invoice.id });
    return reply.code(201).send({ ok: true, invoice });
  });

  app.patch('/api/invoices/:invoiceId', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const params = z.object({ invoiceId: z.string() }).parse(request.params);
    const invoice = await repo.getInvoice(params.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const patch = z.object({
      discountKobo: z.number().int().nonnegative().optional(),
      taxKobo: z.number().int().nonnegative().optional(),
      issuedAt: z.string().datetime().optional(),
      hmoCoverageKobo: z.number().int().nonnegative().optional(),
      hmoInsuranceId: z.string().optional(),
      lines: z.array(z.object({
                      description: z.string().min(1),
                      quantity: z.number().int().positive(),
                      unitPriceKobo: z.number().int().nonnegative(),
                      inventoryItemId: z.string().optional(),
                    })).optional(),
    }).parse(request.body);
    const updated = await repo.updateInvoice(params.invoiceId, patch);
    if (!invoice.issuedAt && updated.issuedAt) {
      await queuePatientNotification(repo, {
        tenantId: auth.tenantId,
        patientId: updated.patientId,
        memberId: auth.member.id,
        type: 'invoice_issued',
        subject: 'Invoice issued',
        body: `Invoice ${updated.invoiceNumber} was issued.`,
      });
    }
    return { ok: true, invoice: updated };
  });

  app.post('/api/invoices/:invoiceId/payment', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const params = z.object({ invoiceId: z.string() }).parse(request.params);
    const invoice = await repo.getInvoice(params.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const body = z.object({ amountKobo: z.number().int().positive() }).parse(request.body);
    const paid = await repo.recordInvoicePayment(params.invoiceId, body.amountKobo);
    await queuePatientNotification(repo, {
      tenantId: auth.tenantId,
      patientId: paid.patientId,
      memberId: auth.member.id,
      type: 'invoice_payment_received',
      subject: 'Payment received',
      body: `Payment of ₦${(body.amountKobo).toLocaleString()} recorded for ${paid.invoiceNumber}.`,
    });
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'invoice_payment', objectType: 'invoice', objectId: paid.id, details: { amountKobo: body.amountKobo } });
    return { ok: true, invoice: paid };
  });

  app.post('/api/invoices/:invoiceId/issue', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const params = z.object({ invoiceId: z.string() }).parse(request.params);
    const invoice = await repo.getInvoice(params.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const issued = await repo.issueInvoice(params.invoiceId);
    await queuePatientNotification(repo, {
      tenantId: auth.tenantId,
      patientId: issued.patientId,
      memberId: auth.member.id,
      type: 'invoice_issued',
      subject: `Invoice ${issued.invoiceNumber} – Payment Required`,
      body: `Invoice ${issued.invoiceNumber} for ₦${(issued.totalKobo).toLocaleString()} has been issued. Balance due: ₦${((issued.totalKobo - issued.amountPaidKobo)).toLocaleString()}. Please log into the patient portal to make payment.`,
    });
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'invoice_issue', objectType: 'invoice', objectId: issued.id });
    // Send email immediately via SMTP
    try {
      const patient = await repo.getPatient(issued.patientId);
      const settings = await repo.getSettings(auth.tenantId);
      if (patient?.email) {
        const { sendNotification } = await import('../notifications/provider.js');
        await sendNotification({
          tenantId: auth.tenantId,
          channel: 'email',
          to: patient.email,
          recipient: patient.email,
          subject: `Invoice ${issued.invoiceNumber} from ${settings.clinicName || 'Your Clinic'}`,
          body: `Dear ${patient.firstName},\n\nInvoice ${issued.invoiceNumber} has been issued for ₦${(issued.totalKobo).toLocaleString()}.\n\nAmount Paid: ₦${(issued.amountPaidKobo).toLocaleString()}\nBalance Due: ₦${((issued.totalKobo - issued.amountPaidKobo)).toLocaleString()}\n\nPlease log into your patient portal to view and pay this invoice.\n\nThank you,\n${settings.clinicName || 'Your Clinic'}`,
        }, settings);
      }
    } catch (_) {}
    return { ok: true, invoice: issued };
  });

  app.post('/api/invoices/:invoiceId/void', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_billing');
    const params = z.object({ invoiceId: z.string() }).parse(request.params);
    const invoice = await repo.getInvoice(params.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const voided = await repo.voidInvoice(params.invoiceId);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'invoice_void', objectType: 'invoice', objectId: voided.id, details: { amountPaidKobo: voided.amountPaidKobo } });
    return { ok: true, invoice: voided };
  });

  app.get('/api/patient-documents', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'view_patients');
    const query = z.object({ patientId: z.string().optional(), encounterId: z.string().optional() }).parse(request.query);
    return { ok: true, documents: await repo.listPatientDocuments(auth.tenantId, query) };
  });

  app.post('/api/patient-documents', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    if (!canPerform(auth.member.role, 'write_encounter') && !canPerform(auth.member.role, 'create_appointment')) {
      throw httpError('FORBIDDEN', 403);
    }
    const input = z.object({
      tenantId: z.string(),
      patientId: z.string(),
      encounterId: z.string().optional(),
      title: z.string().min(1),
      documentType: z.enum(['report', 'scan', 'lab', 'consent', 'other']),
      fileUrl: z.string().optional(),
      notes: z.string().optional(),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    return reply.code(201).send({ ok: true, document: await repo.createPatientDocument(input) });
  });
}
