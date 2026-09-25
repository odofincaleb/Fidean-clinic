import { httpError } from '../http/errors.js';
import type { Appointment, DoctorSchedule, Member, Service } from './types.js';

const BLOCKING = new Set(['requested', 'confirmed', 'checked_in', 'completed']);

export function utcWeekday(iso: string): number {
  return new Date(iso).getUTCDay();
}

export function utcHm(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function resolveDurationMinutes(input: { serviceId?: string; serviceName: string }, services: Service[]): number {
  if (input.serviceId) {
    const match = services.find((item) => item.id === input.serviceId && item.active);
    if (match) return match.durationMinutes;
  }
  const byName = services.find((item) => item.active && item.name.toLowerCase() === input.serviceName.toLowerCase());
  return byName?.durationMinutes ?? 30;
}

export function assertDoctorForBooking(doctor: Member | undefined, branchId: string): Member {
  if (!doctor || doctor.status !== 'active') throw httpError('INVALID_DOCTOR', 404);
  if (doctor.role !== 'doctor') throw httpError('INVALID_DOCTOR', 400);
  if (doctor.branchIds.length > 0 && !doctor.branchIds.includes(branchId)) throw httpError('INVALID_DOCTOR', 400);
  return doctor;
}

export function matchingSchedule(
  schedules: DoctorSchedule[],
  input: { tenantId: string; branchId: string; doctorMemberId: string; startsAt: string; durationMinutes: number },
): DoctorSchedule | undefined {
  const weekday = utcWeekday(input.startsAt);
  const startHm = utcHm(input.startsAt);
  const endHm = utcHm(addMinutes(input.startsAt, input.durationMinutes));
  return schedules.find((item) => {
    if (!item.active) return false;
    if (item.tenantId !== input.tenantId || item.branchId !== input.branchId) return false;
    if (item.doctorMemberId !== input.doctorMemberId) return false;
    if (item.weekday !== weekday) return false;
    return startHm >= item.startsAt && endHm <= item.endsAt;
  });
}

export function assertNoConflicts(input: {
  tenantId: string;
  patientId: string;
  doctorMemberId?: string;
  startsAt: string;
  durationMinutes: number;
  appointments: Appointment[];
  ignoreAppointmentId?: string;
  existingDuration: (item: Appointment) => number;
}): void {
  const end = addMinutes(input.startsAt, input.durationMinutes);
  for (const item of input.appointments) {
    if (item.tenantId !== input.tenantId) continue;
    if (input.ignoreAppointmentId && item.id === input.ignoreAppointmentId) continue;
    if (!BLOCKING.has(item.status)) continue;
    const itemEnd = addMinutes(item.startsAt, input.existingDuration(item));
    if (!rangesOverlap(input.startsAt, end, item.startsAt, itemEnd)) continue;
    if (input.doctorMemberId && item.doctorMemberId === input.doctorMemberId) {
      throw httpError('APPOINTMENT_CONFLICT', 409);
    }
    if (item.patientId === input.patientId) {
      throw httpError('PATIENT_APPOINTMENT_CONFLICT', 409);
    }
  }
}

export function buildAvailabilitySlots(input: {
  date: string;
  schedules: DoctorSchedule[];
  appointments: Appointment[];
  durationFor: (item: Appointment) => number;
  slotMinutes?: number;
}): { slotMinutes: number; slots: Array<{ startsAt: string; available: boolean; reason?: string }> } {
  const weekday = utcWeekday(`${input.date}T12:00:00.000Z`);
  const daySchedules = input.schedules.filter((item) => item.active && item.weekday === weekday);
  const slotMinutes = input.slotMinutes ?? daySchedules[0]?.slotMinutes ?? 30;
  const slots: Array<{ startsAt: string; available: boolean; reason?: string }> = [];
  for (const schedule of daySchedules) {
    let cursor = hmToMinutes(schedule.startsAt);
    const end = hmToMinutes(schedule.endsAt);
    while (cursor + slotMinutes <= end) {
      const hh = String(Math.floor(cursor / 60)).padStart(2, '0');
      const mm = String(cursor % 60).padStart(2, '0');
      const startsAt = `${input.date}T${hh}:${mm}:00.000Z`;
      const durationMinutes = slotMinutes;
      try {
        assertNoConflicts({
          tenantId: schedule.tenantId,
          patientId: '__availability__',
          doctorMemberId: schedule.doctorMemberId,
          startsAt,
          durationMinutes,
          appointments: input.appointments,
          existingDuration: input.durationFor,
        });
        slots.push({ startsAt, available: true });
      } catch (error) {
        const message = (error as Error).message;
        slots.push({ startsAt, available: false, reason: message === 'PATIENT_APPOINTMENT_CONFLICT' ? 'APPOINTMENT_CONFLICT' : message });
      }
      cursor += slotMinutes;
    }
  }
  return { slotMinutes, slots };
}
