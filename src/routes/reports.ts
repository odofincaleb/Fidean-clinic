import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerReportsRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/reports/revenue', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
    }).parse(request.query);
    const report = await repo.getRevenueReport(auth.tenantId, query.from, query.to);
    return { ok: true, report };
  });
}