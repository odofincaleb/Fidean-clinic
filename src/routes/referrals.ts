import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerReferralsRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/referrals', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_referrals');
    const query = z.object({
      patientId: z.string().optional(),
      encounterId: z.string().optional(),
      toDoctorMemberId: z.string().optional(),
      status: z.enum(['pending', 'accepted', 'completed', 'cancelled']).optional(),
    }).parse(request.query);
    return { ok: true, referrals: await repo.listReferrals(auth.tenantId, query) };
  });

  app.post('/api/referrals', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_referrals');
    const input = z.object({
      tenantId: z.string(),
      encounterId: z.string(),
      patientId: z.string(),
      fromDoctorMemberId: z.string().optional(),
      toDoctorMemberId: z.string().optional(),
      referralType: z.enum(['inhouse_specialist', 'external_clinic']),
      specialty: z.string().optional(),
      externalClinicName: z.string().optional(),
      externalClinicContact: z.string().optional(),
      reason: z.string().min(1),
      notes: z.string().optional(),
    }).parse(request.body);
    if (input.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    return reply.code(201).send({ ok: true, referral: await repo.createReferral(input) });
  });

  app.patch('/api/referrals/:id', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_referrals');
    const params = z.object({ id: z.string() }).parse(request.params);
    const referrals = await repo.listReferrals(auth.tenantId, {});
    const referral = referrals.find((r) => r.id === params.id);
    if (!referral) throw httpError('REFERRAL_NOT_FOUND', 404);
    if (referral.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);
    const patch = z.object({
      status: z.enum(['pending', 'accepted', 'completed', 'cancelled']).optional(),
      notes: z.string().optional(),
      toDoctorMemberId: z.string().optional(),
      externalClinicName: z.string().optional(),
      externalClinicContact: z.string().optional(),
    }).parse(request.body);
    return { ok: true, referral: await repo.updateReferral(params.id, patch) };
  });
}
