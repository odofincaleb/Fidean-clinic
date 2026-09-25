import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerMessagesRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.post('/api/messages/send', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({
      channel: z.enum(['email', 'sms', 'whatsapp']),
      recipient: z.string().min(1),
      subject: z.string().optional(),
      body: z.string().min(1),
    }).parse(request.body);

    const log = await repo.createMessageLog(auth.tenantId, {
      channel: body.channel,
      recipient: body.recipient,
      subject: body.subject,
      body: body.body,
    });

    return reply.code(201).send({ ok: true, message: log });
  });

  app.get('/api/messages', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({ limit: z.coerce.number().int().positive().optional() }).parse(request.query);
    const logs = await repo.getMessageLogs(auth.tenantId, query.limit);
    return { ok: true, messages: logs };
  });
}