import { createMemoryClinicRepository } from '../repositories/MemoryClinicRepository.js';

export function createMemoryStore() {
  return createMemoryClinicRepository();
}

export type { MemoryClinicRepository as MemoryStore } from '../repositories/MemoryClinicRepository.js';
