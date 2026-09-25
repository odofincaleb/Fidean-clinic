import { createHash, randomBytes } from 'node:crypto';

export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newDevToken(): string {
  return randomBytes(24).toString('hex');
}

export function expiresAt(ttlMs: number, from = new Date()): string {
  return new Date(from.getTime() + ttlMs).toISOString();
}
