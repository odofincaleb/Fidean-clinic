import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/context.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerSettingsRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const settings = await repo.getSettings(auth.tenantId);
    return reply.send(settings || {});
  });

  app.put('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const body = request.body as Record<string, unknown>;
    const settings = await repo.upsertSettings(auth.tenantId, body);
    return reply.send(settings);
  });
}