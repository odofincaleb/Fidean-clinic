import type { Appointment } from './types.js';
import { httpError } from '../http/errors.js';

const allowed: Record<Appointment['status'], Appointment['status'][]> = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled'],
  checked_in: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function assertValidTransition(from: Appointment['status'], to: Appointment['status']): void {
  if (!allowed[from]?.includes(to)) {
    throw httpError(`INVALID_TRANSITION:${from}->${to}`, 409);
  }
}
