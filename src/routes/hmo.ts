import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertCan, canPerform, memberCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository, HmoInsurance } from '../repositories/ClinicRepository.js';

export function registerHmoRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  // List HMO insurances for a patient
  app.get('/api/hmo', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({ patientId: z.string().optional() }).parse(request.query);
    return { ok: true, insurances: await repo.listHmoInsurances(auth.tenantId, query.patientId) };
  });

  // Get single HMO
  app.get('/api/hmo/:id', async (request) => {
    const auth = await requireAuth(request, repo);
    const params = z.object({ id: z.string() }).parse(request.params);
    const ins = await repo.getHmoInsurance(params.id);
    if (!ins || ins.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    return { ok: true, insurance: ins };
  });

  // Delete HMO (via POST for browser compatibility)
  app.post('/api/hmo/:id/delete', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!memberCan(auth.member, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const params = z.object({ id: z.string() }).parse(request.params);
    const ins = await repo.getHmoInsurance(params.id);
    if (!ins || ins.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    await repo.deleteHmoInsurance(params.id);
    return { ok: true };
  });
  app.delete('/api/hmo/:id', async (request) => {
    const auth = await requireAuth(request, repo);
    if (!memberCan(auth.member, 'view_patients')) throw httpError('FORBIDDEN', 403);
    const params = z.object({ id: z.string() }).parse(request.params);
    const ins = await repo.getHmoInsurance(params.id);
    if (!ins || ins.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    await repo.deleteHmoInsurance(params.id);
    return { ok: true };
  });

  app.post('/api/hmo', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_billing');
    const input = z.object({
      patientId: z.string(),
      hmoName: z.string().min(1),
      hmoNumber: z.string().optional(),
      coverageType: z.enum(['percentage', 'fixed']),
      coverageValue: z.number().nonnegative(),
    }).parse(request.body);
    const insurance = await repo.createHmoInsurance({
      tenantId: auth.tenantId, ...input, active: true,
    });
    return reply.code(201).send({ ok: true, insurance });
  });

  // Update HMO
  app.patch('/api/hmo/:id', async (request) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_billing');
    const params = z.object({ id: z.string() }).parse(request.params);
    const patch = z.object({
      hmoName: z.string().min(1).optional(),
      hmoNumber: z.string().optional(),
      coverageType: z.enum(['percentage', 'fixed']).optional(),
      coverageValue: z.number().nonnegative().optional(),
      active: z.boolean().optional(),
    }).parse(request.body);
    const ins = await repo.getHmoInsurance(params.id);
    if (!ins || ins.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    return { ok: true, insurance: await repo.updateHmoInsurance(params.id, patch) };
  });
}