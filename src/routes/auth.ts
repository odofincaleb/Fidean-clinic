import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth, signToken } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

const registerInput = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  qualifications: z.string().optional(),
  licenseNumber: z.string().optional(),
});

const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const inviteInput = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'branch_manager', 'doctor', 'receptionist', 'nurse', 'accountant', 'store_manager', 'viewer']),
  branchIds: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  qualifications: z.string().optional(),
  licenseNumber: z.string().optional(),
  password: z.string().min(8).optional(),
});

function publicUser(user: { id: string; email: string; displayName?: string } | undefined) {
  if (!user) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export function registerAuthRoutes(app: FastifyInstance, repo: ClinicRepository): void {
  app.get('/api/tenants/resolve', async (request) => {
    const query = z.object({ slug: z.string().min(1) }).parse(request.query);
    const tenants = await repo.listTenants();
    const tenant = tenants.find((t) => t.slug === query.slug);
    if (!tenant) throw httpError('TENANT_NOT_FOUND', 404);
    const settings = await repo.getSettings(tenant.id);
    return {
      ok: true,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status },
      settings: settings ? { clinicName: settings.clinicName, clinicLogoUrl: settings.clinicLogoUrl, brandPrimaryColor: settings.brandPrimaryColor, brandAccentColor: settings.brandAccentColor } : null,
    };
  });

  app.post('/api/auth/register', async (request, reply) => {
    const input = registerInput.parse(request.body);
    const email = input.email.toLowerCase();
    if (await repo.findUserByEmail(email)) {
      throw httpError('EMAIL_TAKEN', 409);
    }
    const slugTaken = (await repo.listTenants()).some((tenant) => tenant.slug === input.slug);
    if (slugTaken) {
      throw httpError('SLUG_TAKEN', 409);
    }
    const tenant = await repo.createTenant({ name: input.name, slug: input.slug });
    const passwordHash = await bcrypt.hash(input.password, 10);
    const user = await repo.createUser({ email, passwordHash, displayName: input.displayName });
    const member = await repo.addMember({
      tenantId: tenant.id,
      email,
      role: 'owner',
      displayName: input.displayName,
      phone: input.phone,
      specialization: input.specialization,
      qualifications: input.qualifications,
      licenseNumber: input.licenseNumber,
    });
    await repo.linkUserToMembership(member.id, user.id);
    const linked = (await repo.getMember(member.id)) ?? member;
    const token = signToken({ memberId: linked.id, tenantId: tenant.id, role: linked.role, email: linked.email });
    return reply.code(201).send({ ok: true, token, tenant, member: linked, user: publicUser({ ...user, displayName: input.displayName }) });
  });

  app.post('/api/auth/login', async (request) => {
    const input = loginInput.parse(request.body);
    const user = await repo.findUserByEmail(input.email);
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) {
      throw httpError('INVALID_CREDENTIALS', 401);
    }
    // Super admin bypass membership check
    const isSuperAdmin = (user as any).isSuperAdmin === true;
    if (isSuperAdmin) {
      const token = signToken({ memberId: '', tenantId: '', role: 'super_admin', email: user.email });
      return { ok: true, token, tenant: null, member: null, user: publicUser(user), isSuperAdmin: true };
    }
    const member = await repo.findActiveMembershipByUserId(user.id);
    if (!member) {
      throw httpError('NO_ACTIVE_MEMBERSHIP', 403);
    }
    const tenant = await repo.getTenant(member.tenantId);
    if (!tenant) throw httpError('TENANT_NOT_FOUND', 404);
    const token = signToken({ memberId: member.id, tenantId: member.tenantId, role: member.role, email: member.email });
    return { ok: true, token, tenant, member, user: publicUser(user) };
  });

  app.get('/api/auth/me', async (request) => {
    const auth = await requireAuth(request, repo);
    const tenant = await repo.getTenant(auth.tenantId);
    if (!tenant) throw httpError('TENANT_NOT_FOUND', 404);
    const user = await repo.findUserByEmail(auth.member.email);
    return { ok: true, user: publicUser(user), member: auth.member, tenant };
  });

  // Staff: update
  app.post('/api/staff/:id/update', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_staff');
    const p = z.object({ id: z.string() }).parse(request.params);
    const patch = z.object({ displayName: z.string().optional(), role: z.string().optional(), phone: z.string().optional(), specialization: z.string().optional(), qualifications: z.string().optional(), licenseNumber: z.string().optional(), password: z.string().min(8).optional() }).parse(request.body);
    const member = await repo.getMember(p.id);
    if (!member || member.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    // If password provided, hash and update the user record
    if (patch.password) {
      const bcrypt = await import('bcryptjs').then(m => m.default);
      const passwordHash = await bcrypt.hash(patch.password, 10);
      await repo.updateUserPassword(member.userId, passwordHash);
    }
    const { password, ...memberPatch } = patch;
    return { ok: true, member: await repo.updateMember(p.id, memberPatch) };
  });
  // Staff: delete
  app.post('/api/staff/:id/delete', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    const p = z.object({ id: z.string() }).parse(request.params);
    const member = await repo.getMember(p.id);
    if (!member || member.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    await repo.deleteMember(p.id);
    return { ok: true };
  });

  app.post('/api/tenants/:tenantId/invite', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member.role, 'manage_staff');
    const params = z.object({ tenantId: z.string() }).parse(request.params);
    if (auth.tenantId !== params.tenantId) throw httpError('FORBIDDEN', 403);
    const input = inviteInput.parse(request.body);
    const email = input.email.toLowerCase();
    const existing = await repo.findMembershipByEmail(params.tenantId, email);
    if (existing) throw httpError('MEMBERSHIP_EXISTS', 409);
    const member = await repo.addMember({
      tenantId: params.tenantId,
      email,
      role: input.role,
      branchIds: input.branchIds,
      displayName: input.displayName,
      phone: input.phone,
      specialization: input.specialization,
      qualifications: input.qualifications,
      licenseNumber: input.licenseNumber,
    });
    // If password provided, create user account directly (skip invite email)
    if (input.password) {
      const passwordHash = await bcrypt.hash(input.password, 10);
      const user = await repo.createUser({ email, passwordHash, displayName: input.displayName });
      await repo.updateMember(member.id, { status: 'active', userId: user.id });
    } else {
      const invited = await repo.updateMember(member.id, { status: 'active' });
    }
    return reply.code(201).send({ ok: true, member: await repo.getMember(member.id) });
  });
}
