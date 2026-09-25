import { httpError } from '../http/errors.js';
import { assertScheduleWindow } from '../domain/clinical.js';
import type { Appointment, Branch, Encounter, Member, Patient } from '../domain/types.js';
import type { DoctorScheduleInput, EncounterInput } from './ClinicRepository.js';

export function validateDoctorScheduleInput(
  input: DoctorScheduleInput,
  tenantExists: boolean,
  branch: Branch | undefined,
  doctor: Member | undefined,
): void {
  if (!tenantExists) throw httpError('TENANT_NOT_FOUND', 404);
  if (!branch || branch.tenantId !== input.tenantId) throw httpError('BRANCH_NOT_FOUND', 404);
  if (!doctor || doctor.tenantId !== input.tenantId) throw httpError('DOCTOR_NOT_FOUND', 404);
  if (input.weekday < 0 || input.weekday > 6) throw httpError('INVALID_WEEKDAY', 400);
  assertScheduleWindow(input.startsAt, input.endsAt, input.slotMinutes ?? 30);
}

export function validateEncounterInput(
  input: EncounterInput,
  tenantExists: boolean,
  branch: Branch | undefined,
  patient: Patient | undefined,
  appointment: Appointment | undefined,
): void {
  if (!tenantExists) throw httpError('TENANT_NOT_FOUND', 404);
  if (!branch || branch.tenantId !== input.tenantId) throw httpError('BRANCH_NOT_FOUND', 404);
  if (!patient || patient.tenantId !== input.tenantId) throw httpError('PATIENT_NOT_FOUND', 404);
  if (input.appointmentId) {
    if (!appointment) throw httpError('APPOINTMENT_NOT_FOUND', 404);
    if (appointment.tenantId !== input.tenantId || appointment.branchId !== input.branchId || appointment.patientId !== input.patientId) {
      throw httpError('APPOINTMENT_MISMATCH', 400);
    }
  }
}

export function assertEncounterEditable(encounter: Encounter): void {
  if (encounter.status === 'signed') throw httpError('ENCOUNTER_SIGNED', 409);
  if (encounter.status === 'cancelled') throw httpError('ENCOUNTER_CANCELLED', 409);
}
