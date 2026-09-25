import type { ClinicRepository } from './ClinicRepository.js';
import { MemoryClinicRepository } from './MemoryClinicRepository.js';
import { PostgresClinicRepository } from './PostgresClinicRepository.js';

export { MemoryClinicRepository } from './MemoryClinicRepository.js';
export { PostgresClinicRepository } from './PostgresClinicRepository.js';
export type { ClinicRepository } from './ClinicRepository.js';

export function createClinicRepository(env: NodeJS.ProcessEnv = process.env): ClinicRepository {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return new PostgresClinicRepository(databaseUrl);
  }
  return new MemoryClinicRepository();
}

let cached: ClinicRepository | undefined;

export function getClinicRepository(): ClinicRepository {
  cached ??= createClinicRepository();
  return cached;
}

export function resetClinicRepositoryCache(): void {
  cached = undefined;
}
