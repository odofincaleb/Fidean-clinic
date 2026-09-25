import type { ClinicRepository, AppointmentInput } from '../repositories/ClinicRepository.js';
import { httpError } from '../http/errors.js';
import { assertDoctorForBooking, assertNoConflicts, matchingSchedule, resolveDurationMinutes } from './availability.js';

export async function assertAppointmentFits(repo: ClinicRepository, input: AppointmentInput, ignoreAppointmentId?: string): Promise<void> {
  const [schedules, appointments, services] = await Promise.all([
    repo.listDoctorSchedules(input.tenantId),
    repo.listAppointments(input.tenantId),
    repo.listServices(input.tenantId),
  ]);
  const durationMinutes = resolveDurationMinutes({ serviceId: input.serviceId, serviceName: input.serviceName }, services);
  const durationFor = (item: typeof appointments[number]) => resolveDurationMinutes({ serviceName: item.serviceName }, services);
  if (input.doctorMemberId) {
    const doctor = await repo.getMember(input.doctorMemberId);
    if (!doctor || doctor.tenantId !== input.tenantId) throw httpError('INVALID_DOCTOR', 404);
    assertDoctorForBooking(doctor, input.branchId);
    if (!matchingSchedule(schedules, {
      tenantId: input.tenantId,
      branchId: input.branchId,
      doctorMemberId: input.doctorMemberId,
      startsAt: input.startsAt,
      durationMinutes,
    })) {
      throw httpError('DOCTOR_NOT_AVAILABLE', 409);
    }
  }
  assertNoConflicts({
    tenantId: input.tenantId,
    patientId: input.patientId,
    doctorMemberId: input.doctorMemberId,
    startsAt: input.startsAt,
    durationMinutes,
    appointments,
    ignoreAppointmentId,
    existingDuration: durationFor,
  });
}
