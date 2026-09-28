import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePatientAuth } from '../auth/context.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerPaymentsRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.post('/api/payments/initialize', async (request, reply) => {
    let auth: any;
    try {
      auth = await requireAuth(request, repo);
    } catch {
      try {
        auth = await requirePatientAuth(request, repo);
      } catch {
        throw httpError('AUTH_REQUIRED', 401);
      }
    }
    const body = z.object({ invoiceId: z.string() }).parse(request.body);

    const invoice = await repo.getInvoice(body.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);

    const settings = await repo.getSettings(auth.tenantId);
    const secretKey = settings?.paystackSecretKey;
    const publicKey = settings?.paystackPublicKey;
    if (!secretKey || !publicKey) throw httpError('PAYSTACK_NOT_CONFIGURED', 400);

    const amount = invoice.totalKobo - invoice.amountPaidKobo;
    const reference = `pay_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const tx = await repo.createPaystackTransaction(auth.tenantId, body.invoiceId, reference, amount);

    // Call Paystack API to initialize transaction.
    // Paystack API expects the amount in kobo (smallest unit); the DB stores Naira.
    // This * 100 is the ONLY kobo denominator in the system and is required by Paystack.
    try {
      const paystackResp = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: auth.member?.email || auth.email || '',
          amount: amount * 100,
          reference,
          currency: invoice.currency || 'NGN',
          callback_url: 'http://169.58.111.70:4310/payment-callback',
          metadata: {
            invoiceId: body.invoiceId,
            tenantId: auth.tenantId,
          },
        }),
      });
      const paystackData = await paystackResp.json() as any;
      if (paystackData.status && paystackData.data?.authorization_url) {
        return reply.send({
          ok: true,
          reference: tx.reference,
          authorizationUrl: paystackData.data.authorization_url,
          accessCode: paystackData.data.access_code,
          amountKobo: tx.amountKobo,
          paystackPublicKey: publicKey,
        });
      }
    } catch (_) {
      // Paystack API call failed — fall through to local reference
    }

    return reply.send({
      ok: true,
      reference: tx.reference,
      amountKobo: tx.amountKobo,
      paystackPublicKey: publicKey || '',
    });
  });

  app.post('/api/payments/verify', async (request) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({ reference: z.string() }).parse(request.body);

    const settings = await repo.getSettings(auth.tenantId);
    const secretKey = settings?.paystackSecretKey;
    if (!secretKey) throw httpError('PAYSTACK_NOT_CONFIGURED', 400);

    // Verify with Paystack API
    try {
      const response = await fetch(`https://api.paystack.co/transaction/verify/${body.reference}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const data = await response.json() as { status: boolean; data?: { status: string; channel: string; paid_at: string } };
      if (data.status && data.data?.status === 'success') {
        const tx = await repo.updatePaystackTransaction(body.reference, {
          status: 'success',
          channel: data.data.channel,
          paidAt: data.data.paid_at,
          verifiedAt: new Date().toISOString(),
        });
        // Update invoice as paid
        if (tx.invoiceId) {
          const invoice = await repo.getInvoice(tx.invoiceId);
          if (invoice) {
            const newPaid = invoice.amountPaidKobo + tx.amountKobo;
            const newStatus = newPaid >= invoice.totalKobo ? 'paid' : 'part_paid';
            await repo.updateInvoice(tx.invoiceId, { amountPaidKobo: newPaid, status: newStatus });
          }
        }
        return { ok: true, transaction: tx };
      }
      throw httpError('PAYMENT_VERIFICATION_FAILED', 400);
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw httpError('PAYSTACK_VERIFICATION_ERROR', 502);
    }
  });

  // Record bank transfer payment (manual)
  app.post('/api/payments/bank-transfer', async (request) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({
      invoiceId: z.string(),
      amountKobo: z.number().int().positive(),
      reference: z.string().optional(),
    }).parse(request.body);

    const invoice = await repo.getInvoice(body.invoiceId);
    if (!invoice) throw httpError('INVOICE_NOT_FOUND', 404);
    if (invoice.tenantId !== auth.tenantId) throw httpError('FORBIDDEN', 403);

    const reference = body.reference || `bt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const tx = await repo.createPaystackTransaction(auth.tenantId, body.invoiceId, reference, body.amountKobo);
    await repo.updatePaystackTransaction(reference, {
      status: 'success',
      channel: 'bank_transfer',
      paidAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    });

    const newPaid = invoice.amountPaidKobo + body.amountKobo;
    const newStatus = newPaid >= invoice.totalKobo ? 'paid' : 'part_paid';
    await repo.updateInvoice(body.invoiceId, { amountPaidKobo: newPaid, status: newStatus });

    return { ok: true, transaction: tx };
  });

  // Paystack webhook: verify payment and update invoice / credit wallet topup.
  // Paystack sends event.data.amount in kobo — convert to Naira at this boundary only.
  app.post('/api/payments/webhook', async (request, reply) => {
    const event = request.body as any;
    if (event?.event === 'charge.success' && event?.data?.reference && event?.data?.metadata?.tenantId) {
      try {
        const tenantId = event.data.metadata.tenantId;
        const amount = Math.round((event.data.amount || 0) / 100);

        // Wallet top-up flow
        if (event.data.metadata?.purpose === 'wallet_topup') {
          const settings = await repo.getSettings(tenantId);
          const newBalance = (settings?.walletBalance ?? 0) + amount;
          await repo.upsertSettings(tenantId, { walletBalance: newBalance });
          await repo.recordWalletTransaction(tenantId, {
            amount,
            type: 'credit',
            reason: 'topup',
            paystackReference: event.data.reference,
            description: 'Wallet top-up via Paystack',
          });
          try { await repo.updatePaystackTransaction(event.data.reference, { status: 'success', channel: 'card', paidAt: new Date().toISOString(), verifiedAt: new Date().toISOString() }); } catch (_) {}
          return reply.code(200).send({ ok: true });
        }

        // Invoice payment flow
        if (event.data.metadata?.invoiceId) {
          const invoiceId = event.data.metadata.invoiceId;
          await repo.recordInvoicePayment(invoiceId, amount);
          // Update transaction record
          try { await repo.updatePaystackTransaction(event.data.reference, { status: 'success', channel: 'card', paidAt: new Date().toISOString(), verifiedAt: new Date().toISOString() }); } catch (_) {}
          // Queue notification
          await repo.queueNotification({
            tenantId,
            patientId: event.data.metadata.patientId || '',
            memberId: '',
            channel: 'email',
            type: 'payment_received',
            recipient: event.data.customer?.email || '',
            subject: 'Payment received',
            body: `Payment of ₦${(amount).toLocaleString()} was received.`,
          });
        }
      } catch (_) {}
    }
    return reply.code(200).send({ ok: true });
  });
}