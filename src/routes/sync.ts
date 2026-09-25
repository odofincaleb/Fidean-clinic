import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { applySyncOperations } from '../domain/sync.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

const operationSchema = z.object({
  clientOperationId: z.string().min(1),
  entityType: z.enum(['patient', 'appointment', 'encounter', 'prescription', 'invoice', 'patientDocument']),
  operation: z.enum(['create', 'update']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().optional(),
});

export function registerSyncRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.post('/api/sync/operations', async (request) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({ operations: z.array(operationSchema).min(1).max(100) }).parse(request.body);
    const results = await applySyncOperations(repo, auth.tenantId, body.operations);
    return { ok: true, results };
  });
}
