import { buildServer } from '../src/server.js';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';

const repo = new MemoryClinicRepository();
const app = buildServer({ repository: repo });

// NEVER hit the real WhatsApp API from a test — blank the token so sends fail
// fast with WHATSAPP_TOKEN_NOT_CONFIGURED (proving validation/wallet/dedupe
// without any external side effect).
process.env.WHATSAPP_ACCESS_TOKEN = '';

const demoRes = await app.inject({ method: 'POST', url: '/api/demo/celon' });
const demo = await demoRes.json();
const token = demo.token;
const tid = demo.snapshot.tenant.id;
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

// Fund the wallet + enable messaging (NO WhatsApp token in env -> sends fail
// fast with WHATSAPP_TOKEN_NOT_CONFIGURED — nothing real goes out).
const s = await app.inject({ method: 'GET', url: '/api/settings', headers: H });
let settings = await s.json();
settings.messagingEnabled = true;
settings.walletBalance = 50000;
await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: settings });

const okRes = await app.inject({
  method: 'GET',
  url: '/api/wallet/balance',
  headers: H,
});
console.log('balance after fund:', (await okRes.json()).balance);

// ── Test 1: dedupe + invalid filtering + job lifecycle ──
const b = await app.inject({
  method: 'POST',
  url: '/api/messages/broadcast',
  headers: H,
  payload: {
    channel: 'whatsapp',
    body: 'Test announcement',
    recipients: [
      { phone: '+2348012345678', name: 'A' },
      { phone: '08012345678', name: 'A dup (leading 0)' },
      { phone: '123', name: 'junk' },
      { phone: '2349012345678', name: 'B' },
    ],
  },
});
const bj = await b.json();
console.log('TEST1 create:', b.status, JSON.stringify(bj.totals));
const expect = { requested: 4, total: 2, dupesRemoved: 1, invalid: 1, totalCost: 160, balance: 50000 };
for (const [k, v] of Object.entries(expect)) {
  console.log(`  ${k}: got=${JSON.stringify(bj.totals[k])} want=${JSON.stringify(v)} ${bj.totals[k] === v ? 'OK' : 'FAIL'}`);
}
if (!bj.jobId) throw new Error('no jobId');

await new Promise((r) => setTimeout(r, 500));
const j = await app.inject({ method: 'GET', url: `/api/messages/broadcast/${bj.jobId}`, headers: H });
const job = (await j.json()).job;
console.log(`TEST1 job: status=${job.status} sent=${job.sent} failed=${job.failed} skipped=${job.skipped}`);
console.log(`  results[0]:`, JSON.stringify(job.results[0]));
const bal2 = await (await app.inject({ method: 'GET', url: '/api/wallet/balance', headers: H })).json();
console.log(`  balance after failed run (must stay 50000): ${bal2.balance}`);

// ── Test 2: fail-closed wallet (no job, nothing sent) ──
settings.walletBalance = 150; // covers 1 msg only; 2 unique recipients need 160
await app.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: settings });
const f = await app.inject({
  method: 'POST',
  url: '/api/messages/broadcast',
  headers: H,
  payload: {
    channel: 'whatsapp',
    body: 'x',
    recipients: [{ phone: '08012345678' }, { phone: '08098765432' }],
  },
});
const fj = await f.json();
console.log('TEST2 fail-closed:', f.status, fj.error, '| balance:', (await (await app.inject({ method: 'GET', url: '/api/wallet/balance', headers: H })).json()).balance);

// ── Test 3: job scoping (other tenant cannot read the job) ──
const d2 = await app.inject({ method: 'POST', url: '/api/demo/celon' }); // second demo = different tenant? (memory repo may reuse) — just attempt
const tok2 = (await d2.json()).token;
if (tok2) {
  const other = await app.inject({ method: 'GET', url: `/api/messages/broadcast/${bj.jobId}`, headers: { authorization: `Bearer ${tok2}` } });
  console.log('TEST3 cross-tenant read:', other.status, '(expect 404 — 403 also acceptable)');
}

await app.close();
console.log('DONE');