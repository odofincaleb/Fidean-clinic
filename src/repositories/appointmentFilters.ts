import type { Appointment } from '../domain/types.js';
import type { AppointmentListFilters } from './ClinicRepository.js';

export function applyAppointmentFilters(appointments: Appointment[], filters?: AppointmentListFilters): Appointment[] {
  if (!filters) return appointments;
  return appointments.filter((item) => {
    if (filters.branchId && item.branchId !== filters.branchId) return false;
    if (filters.doctorMemberId && item.doctorMemberId !== filters.doctorMemberId) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.from && item.startsAt < filters.from) return false;
    if (filters.to && item.startsAt > filters.to) return false;
    return true;
  });
}
