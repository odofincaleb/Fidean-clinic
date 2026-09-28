import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import type { Member } from '../domain/types.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export interface AuthContext {
  tenantId: string;
  member: Member;
}

export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: string;
  email: string;
  iat?: number;
  exp?: number;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export const SECRET = () => process.env.JWT_SECRET || 'dev-fallback-secret';

export function signToken(payload: { memberId: string; tenantId: string; role: string; email: string }): string {
  return jwt.sign(
    { typ: 'staff', type: 'staff', sub: payload.memberId, tenantId: payload.tenantId, role: payload.role, email: payload.email },
    SECRET(),
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
  );
}

export function signPatientToken(payload: { patientAccountId: string; tenantId: string; patientId: string; email: string }): string {
  return jwt.sign(
    { typ: 'patient', type: 'patient', patientAccountId: payload.patientAccountId, tenantId: payload.tenantId, patientId: payload.patientId, email: payload.email },
    SECRET(),
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
  );
}

export interface PatientAuthContext {
  tenantId: string;
  patientId: string;
  patientAccountId: string;
  email: string;
}

export async function requireAuth(request: FastifyRequest, repo: ClinicRepository): Promise<AuthContext> {
  const authHeader = headerValue(request.headers.authorization).trim();
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let payload: JwtPayload & { typ?: string };
    try {
      payload = jwt.verify(token, SECRET()) as JwtPayload & { typ?: string };
    } catch {
      throw httpError('INVALID_TOKEN', 401);
    }
    if (payload.typ === 'patient') throw httpError('STAFF_AUTH_REQUIRED', 403);
    // Super admin: no membership lookup needed
    if (payload.role === 'super_admin' && payload.tenantId === '') {
      return { tenantId: '', member: { id: '', email: payload.email, role: 'super_admin' as any, tenantId: '', status: 'active' as const, displayName: 'Super Admin', branchIds: [], phone: '', specialization: '', qualifications: '', licenseNumber: '', userId: '' } };
    }
    const member = await repo.getMember(payload.sub);
    if (!member || member.tenantId !== payload.tenantId || member.status !== 'active') {
      throw httpError('FORBIDDEN', 403);
    }
    return { tenantId: member.tenantId, member };
  }

  const tenantId = headerValue(request.headers['x-tenant-id']).trim();
  const memberId = headerValue(request.headers['x-member-id']).trim();
  if (tenantId && memberId) {
    const member = await repo.getMember(memberId);
    if (member && member.tenantId === tenantId && member.status === 'active') {
      return { tenantId, member };
    }
    throw httpError('FORBIDDEN', 403);
  }
  throw httpError('AUTH_REQUIRED', 401);
}

export async function requirePatientAuth(request: FastifyRequest, repo: ClinicRepository): Promise<PatientAuthContext> {
  const authHeader = headerValue(request.headers.authorization).trim();
  if (!authHeader.startsWith('Bearer ')) throw httpError('AUTH_REQUIRED', 401);
  let payload: { typ?: string; patientAccountId?: string; tenantId?: string; patientId?: string; email?: string };
  try {
    payload = jwt.verify(authHeader.slice(7), SECRET()) as typeof payload;
  } catch {
    throw httpError('INVALID_TOKEN', 401);
  }
  if (payload.typ !== 'patient' || !payload.patientAccountId || !payload.tenantId || !payload.patientId) {
    throw httpError('PATIENT_AUTH_REQUIRED', 403);
  }
  const account = await repo.getPatientAccount(payload.patientAccountId);
  if (!account || account.tenantId !== payload.tenantId) throw httpError('PATIENT_ACCOUNT_INACTIVE', 403);
  if (account.status === 'disabled') throw httpError('PATIENT_ACCOUNT_DISABLED', 403);
  if (account.status !== 'active') throw httpError('PATIENT_ACCOUNT_INACTIVE', 403);
  return { tenantId: account.tenantId, patientId: account.patientId, patientAccountId: account.id, email: account.email };
}
