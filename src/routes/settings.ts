import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export function registerSettingsRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    // Settings holds clinic branding, SMTP, Paystack keys and wallet config —
    // restrict to staff who can manage staff (owner / admin / branch_manager),
    // mirroring the sidebar gating. Not every authenticated staff member.
    assertCan(auth.member, 'manage_staff');
    const settings = await repo.getSettings(auth.tenantId);
    return reply.send(settings || {});
  });

  app.put('/api/settings', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_staff');
    const body = request.body as Record<string, unknown>;
    const settings = await repo.upsertSettings(auth.tenantId, body);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'settings_update', objectType: 'settings', objectId: auth.tenantId });
    return reply.send(settings);
  });
}