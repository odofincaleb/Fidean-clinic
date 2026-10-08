import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerStaffMessagesRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/staff-messages', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({
      memberId: z.string().optional(),
    }).parse(request.query);
    const memberId = query.memberId ?? auth.member.id;
    return { ok: true, messages: await repo.listStaffMessages(auth.tenantId, memberId) };
  });

  app.post('/api/staff-messages', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'send_staff_messages');
    const input = z.object({
      recipientMemberId: z.string(),
      patientId: z.string().optional(),
      encounterId: z.string().optional(),
      referralId: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().min(1),
    }).parse(request.body);
    // Sender + tenant come from the authenticated session, never the client body
    // (the old schema required tenantId/senderMemberId from the form, which the
    // form never sent → every send 400'd silently).
    const recipient = await repo.getMember(input.recipientMemberId);
    if (!recipient || recipient.tenantId !== auth.tenantId || recipient.status !== 'active') {
      throw httpError('RECIPIENT_NOT_FOUND', 404);
    }
    return reply.code(201).send({ ok: true, message: await repo.createStaffMessage({
      tenantId: auth.tenantId,
      senderMemberId: auth.member.id,
      recipientMemberId: input.recipientMemberId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      referralId: input.referralId,
      subject: input.subject,
      body: input.body,
    }) });
  });

  app.post('/api/staff-messages/:id/read', async (request) => {
    const auth = await requireAuth(request, repo);
    const params = z.object({ id: z.string() }).parse(request.params);
    const messages = await repo.listStaffMessages(auth.tenantId, auth.member.id);
    const msg = messages.find((m) => m.id === params.id);
    if (!msg) throw httpError('STAFF_MESSAGE_NOT_FOUND', 404);
    if (msg.recipientMemberId !== auth.member.id) throw httpError('FORBIDDEN', 403);
    return { ok: true, message: await repo.markStaffMessageRead(params.id, auth.member.id) };
  });

  app.post('/api/staff-messages/read-all', async (request) => {
    const auth = await requireAuth(request, repo);
    const messages = await repo.listStaffMessages(auth.tenantId, auth.member.id);
    let marked = 0;
    for (const m of messages) {
      if (m.recipientMemberId === auth.member.id && !m.readAt) {
        await repo.markStaffMessageRead(m.id, auth.member.id);
        marked++;
      }
    }
    return { ok: true, marked };
  });
}
