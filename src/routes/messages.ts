import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { httpError } from '../http/errors.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';
import { sendNotification } from '../notifications/provider.js';
import { sendWhatsAppMessage } from '../notifications/whatsappSender.js';
import { sendSmsMessage } from '../notifications/smsSender.js';

export function registerMessagesRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.post('/api/messages/send', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({
          channel: z.enum(['email', 'sms', 'whatsapp']),
          recipient: z.string().min(1),
          subject: z.string().optional(),
          body: z.string().min(1),
          templateName: z.string().optional(),
          templateParams: z.array(z.string()).optional(),
        }).parse(request.body);

    const settings = await repo.getSettings(auth.tenantId);
    const log = await repo.createMessageLog(auth.tenantId, {
      channel: body.channel,
      recipient: body.recipient,
      subject: body.subject,
      body: body.body,
    });

    // SMS/WhatsApp are wallet-funded channels. Email uses the tenant SMTP config.
    if (body.channel === 'sms' || body.channel === 'whatsapp') {
      if (!settings?.messagingEnabled) {
        await repo.updateMessageLog(log.id, { status: 'failed', error: 'MESSAGING_DISABLED' });
        throw httpError('MESSAGING_DISABLED', 403);
      }
      const cost = body.channel === 'whatsapp'
        ? (settings.whatsappCostPerMsg ?? 80)
        : (settings.smsCostPerMsg ?? 6);
      const balance = settings.walletBalance ?? 0;
      if (balance < cost) {
        await repo.updateMessageLog(log.id, { status: 'failed', error: 'INSUFFICIENT_WALLET_BALANCE' });
        throw httpError('INSUFFICIENT_WALLET_BALANCE', 402);
      }

      // Attempt the real send first — only deduct on success.
      const templateName = body.channel === 'whatsapp' ? (body.templateName || 'clinic_announcement_msg') : undefined;
      const sendResult = body.channel === 'whatsapp'
        ? await sendWhatsAppMessage({
            to: body.recipient,
            template: { name: templateName, bodyParams: body.templateParams || [body.body] },
          })
        : await sendSmsMessage({ to: body.recipient, body: body.body, senderId: settings?.smsSenderId || undefined });
      if (!sendResult.ok) {
        await repo.updateMessageLog(log.id, { status: 'failed', provider: body.channel, error: sendResult.error });
        throw httpError('MESSAGE_SEND_FAILED', 502);
      }

      // Deduct from wallet using actual units charged by provider, not flat cost.
      const actualUnits = body.channel === 'sms' ? (sendResult.chargedUnits ?? 1) : 1;
      const actualCost = Math.ceil(actualUnits * cost);
      console.log('[SMS COST] units='+actualUnits+' cost='+actualCost+' balance='+balance);
      const newBalance = balance - actualCost;
      await repo.upsertSettings(auth.tenantId, { walletBalance: newBalance });
      await repo.recordWalletTransaction(auth.tenantId, {
        amount: actualCost,
        type: 'debit',
        reason: body.channel === 'whatsapp' ? 'whatsapp_msg' : 'sms_msg',
        messageLogId: log.id,
        description: `${body.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'} message to ${body.recipient}`,
      });
      const sent = await repo.updateMessageLog(log.id, {
        status: 'sent',
        provider: body.channel,
        providerMessageId: sendResult.providerMessageId,
        sentAt: new Date().toISOString(),
      });

      await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'message_send', objectType: 'message_log', objectId: sent.id, details: { channel: body.channel, cost: actualCost } });
    return reply.code(201).send({ ok: true, message: sent, cost: actualCost, chargedUnits: actualUnits, balance: newBalance });
    }

    // Email: attempt real send via tenant SMTP; keep the log queued if SMTP isn't configured.
    try {
      const result = await sendNotification(
        { tenantId: auth.tenantId, channel: 'email', recipient: body.recipient, subject: body.subject, body: body.body } as any,
        settings as any,
      );
      if (result.ok) {
        const sent = await repo.updateMessageLog(log.id, {
          status: 'sent',
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          sentAt: new Date().toISOString(),
        });
        return reply.code(201).send({ ok: true, message: sent });
      }
      await repo.updateMessageLog(log.id, { status: 'failed', provider: 'smtp', error: result.error });
      throw httpError('MESSAGE_SEND_FAILED', 502);
    } catch (err) {
      throw err;
    }
  });

  app.get('/api/messages', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({ limit: z.coerce.number().int().positive().optional() }).parse(request.query);
    const logs = await repo.getMessageLogs(auth.tenantId, query.limit);
    return { ok: true, messages: logs };
  });
}