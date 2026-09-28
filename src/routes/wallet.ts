import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerWalletRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/wallet/balance', async (request) => {
    const auth = await requireAuth(request, repo);
    const settings = await repo.getSettings(auth.tenantId);
    return {
      ok: true,
      balance: settings?.walletBalance ?? 0,
      messagingEnabled: settings?.messagingEnabled ?? false,
      whatsappCostPerMsg: settings?.whatsappCostPerMsg ?? 80,
      smsCostPerMsg: settings?.smsCostPerMsg ?? 6,
    };
  });

  app.get('/api/wallet/transactions', async (request) => {
    const auth = await requireAuth(request, repo);
    const query = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).parse(request.query);
    const transactions = await repo.getWalletTransactions(auth.tenantId, query.limit || 50);
    return { ok: true, transactions };
  });

  // Creates a Paystack transaction for wallet funding. The frontend opens the
  // returned authorizationUrl (or records the reference manually in fallback mode),
  // then Paystack charges the customer. Credits are applied when the payment is
  // verified (webhook / verify flow).
  // NOTE: The wallet is denominated in Naira only. Paystack requires the API
  // amount in kobo, so we multiply by 100 ONLY at the Paystack boundary.
  app.post('/api/wallet/topup', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const body = z.object({ amount: z.number().int().positive() }).parse(request.body);

    // Wallet top-ups use Fidean's company Paystack account, not the clinic's own keys.
    let secretKey = process.env.FIDEAN_PAYSTACK_SK;
    let publicKey = process.env.FIDEAN_PAYSTACK_PK;
    if (!secretKey || !publicKey) {
      try {
        const envContent = fs.readFileSync(new URL('../../.env.fidean', import.meta.url), 'utf-8');
        for (const line of envContent.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k === 'FIDEAN_PAYSTACK_SK') secretKey = v.join('=').trim();
          if (k === 'FIDEAN_PAYSTACK_PK') publicKey = v.join('=').trim();
        }
      } catch {}
    }
    if (!secretKey || !publicKey) throw httpError('PAYSTACK_NOT_CONFIGURED', 400);

    const reference = `topup_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const tx = await repo.createPaystackTransaction(auth.tenantId, undefined, reference, body.amount);

    // Call Paystack API to initialize the top-up transaction
    try {
      const paystackResp = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: auth.member?.email || '',
          amount: body.amount * 100,
          reference,
          currency: 'NGN',
          callback_url: 'http://169.58.111.70:4310/payment-callback',
          metadata: {
            tenantId: auth.tenantId,
            purpose: 'wallet_topup',
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
          amount: tx.amount,
          paystackPublicKey: publicKey,
        });
      }
    } catch (_) {
      // Paystack API call failed — fall through to local reference
    }

    return reply.send({
      ok: true,
      reference: tx.reference,
      amount: tx.amount,
      paystackPublicKey: publicKey,
    });
  });

  /* ── Wallet verify after Paystack callback ── */
  app.post('/api/wallet/verify', async (request, reply) => {
    const body = z.object({ reference: z.string() }).parse(request.body);
    const secretKey = process.env.FIDEAN_PAYSTACK_SK || (() => {
      try {
        const envContent = fs.readFileSync(new URL('../../.env.fidean', import.meta.url), 'utf-8');
        for (const line of envContent.split('\n')) {
          const [k, ...v] = line.split('=');
          if (k === 'FIDEAN_PAYSTACK_SK') return v.join('=').trim();
        }
      } catch {}
      return '';
    })();
    if (!secretKey) throw httpError('PAYSTACK_NOT_CONFIGURED', 400);

    try {
      const resp = await fetch(`https://api.paystack.co/transaction/verify/${body.reference}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const data = await resp.json() as any;
      if (data.status && data.data?.status === 'success') {
        const tenantId = data.data.metadata?.tenantId;
        const amount = Math.round((data.data.amount || 0) / 100);
        if (tenantId) {
          const settings = await repo.getSettings(tenantId);
          const newBalance = (settings?.walletBalance ?? 0) + amount;
          await repo.upsertSettings(tenantId, { walletBalance: newBalance });
          await repo.recordWalletTransaction(tenantId, {
            amount,
            type: 'credit',
            reason: 'topup',
            paystackReference: body.reference,
            description: 'Wallet top-up via Paystack',
          });
        }
        return reply.send({ ok: true, amount, tenantId });
      }
      throw httpError('PAYMENT_VERIFICATION_FAILED', 400);
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) throw err;
      throw httpError('PAYSTACK_VERIFICATION_ERROR', 502);
    }
  });
}