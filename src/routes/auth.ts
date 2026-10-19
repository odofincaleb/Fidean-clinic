import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth, signToken } from '../auth/context.js';
import { assertCan } from '../auth/rbac.js';
import { httpError } from '../http/errors.js';
import { audit, staffAudit } from '../domain/clinicEvents.js';
import { PASSWORD_RESET_TTL_MS, expiresAt, hashToken, newDevToken } from '../auth/tokens.js';
import { sendEmail } from '../notifications/emailSender.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

// Where the "set a new password" page lives. Guests reach it from a reset link,
// so it must be a stable public URL (not a tenant slug). Base chosen to match the
// secure portal origin we stand the app up on.
const RESET_BASE_URL = 'https://clinic.169.58.111.70.sslip.io';

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
  role: z.enum(['owner', 'admin', 'branch_manager', 'store_manager', 'pharmacist', 'doctor', 'receptionist', 'nurse', 'accountant', 'viewer']),
  additionalRoles: z.array(z.enum(['owner', 'admin', 'branch_manager', 'store_manager', 'pharmacist', 'doctor', 'receptionist', 'nurse', 'accountant', 'viewer'])).optional(),
  branchIds: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  qualifications: z.string().optional(),
  licenseNumber: z.string().optional(),
  specialistTag: z.string().optional(),
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
    await audit(repo, { tenantId: tenant.id, ...staffAudit(linked.id), action: 'tenant_create', objectType: 'tenant', objectId: tenant.id });
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

  // Forgot password: issue a one-time reset token and email a reset link.
  // Always answers the same way whether or not the email is registered, so an
  // attacker can never enumerate accounts (mirrors the patient reset flow).
  app.post('/api/auth/forgot-password', async (request) => {
    const input = z.object({ email: z.string().email() }).parse(request.body);
    const generic = { ok: true, message: 'If that email is registered, a reset link has been sent.' };
    const user = await repo.findUserByEmail(input.email.toLowerCase());
    if (user) {
      const token = newDevToken();
      await repo.setUserPasswordReset(user.id, hashToken(token), expiresAt(PASSWORD_RESET_TTL_MS));
      const member = await repo.findActiveMembershipByUserId(user.id);
      if (member) {
        const settings = await repo.getSettings(member.tenantId);
        if (settings?.smtpHost) {
          await sendEmail(
            settings,
            user.email,
            'Reset your clinic portal password',
            `Hello${member.displayName ? ' ' + member.displayName : ''},\n\n` +
            `We received a request to reset your clinic portal password. Click the link below to choose a new one:\n\n` +
            `${RESET_BASE_URL}/reset-password?token=${token}\n\n` +
            `This link expires in 24 hours. If you did not request it, you can safely ignore this email.`,
          );
        }
      }
    }
    return { ...generic };
  });

  // Complete a password reset: validate the one-time token, then set the new password.
  app.post('/api/auth/reset-password', async (request) => {
    const input = z.object({ token: z.string().min(8), password: z.string().min(8) }).parse(request.body);
    const user = await repo.findUserByPasswordResetTokenHash(hashToken(input.token));
    if (!user) throw httpError('INVALID_PASSWORD_RESET_TOKEN', 401);
    if (user.resetTokenUsedAt) throw httpError('PASSWORD_RESET_TOKEN_USED', 409);
    if (user.resetTokenExpiresAt && new Date(user.resetTokenExpiresAt).getTime() < Date.now()) {
      throw httpError('PASSWORD_RESET_TOKEN_EXPIRED', 410);
    }
    const passwordHash = await bcrypt.hash(input.password, 10);
    await repo.updateUserPassword(user.id, passwordHash);
    await repo.clearUserPasswordReset(user.id);
    return { ok: true };
  });

  // Staff: update their OWN profile (self-service; role/branch changes stay with managers).
  app.post('/api/auth/profile', async (request) => {
    const auth = await requireAuth(request, repo);
    const input = z.object({
      displayName: z.string().optional(),
      phone: z.string().optional(),
      specialization: z.string().optional(),
      qualifications: z.string().optional(),
      licenseNumber: z.string().optional(),
    }).parse(request.body);
    if (!auth.member.id) {
      // Super admin has no member seat to update.
      return { ok: true, member: null };
    }
    const member = await repo.updateMember(auth.member.id, input);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'profile_update', objectType: 'member', objectId: auth.member.id });
    return { ok: true, member };
  });

  // Staff: change their own password (verifies the current password first).
  app.post('/api/auth/change-password', async (request) => {
    const auth = await requireAuth(request, repo);
    const input = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) }).parse(request.body);
    const user = await repo.findUserByEmail(auth.member.email);
    if (!user || !(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      throw httpError('WRONG_CURRENT_PASSWORD', 401);
    }
    const passwordHash = await bcrypt.hash(input.newPassword, 10);
    await repo.updateUserPassword(user.id, passwordHash);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'password_change', objectType: 'member', objectId: auth.member.id });
    return { ok: true };
  });

  // Staff: update
  app.post('/api/staff/:id/update', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_staff');
    const p = z.object({ id: z.string() }).parse(request.params);
    const patch = z.object({ displayName: z.string().optional(), role: z.string().optional(), additionalRoles: z.array(z.enum(['owner', 'admin', 'branch_manager', 'store_manager', 'pharmacist', 'doctor', 'receptionist', 'nurse', 'accountant', 'viewer'])).optional(), phone: z.string().optional(), specialization: z.string().optional(), qualifications: z.string().optional(), licenseNumber: z.string().optional(), specialistTag: z.string().optional(), password: z.string().min(8).optional() }).parse(request.body);
    const member = await repo.getMember(p.id);
    if (!member || member.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    // Guard the owner account: a member may not demote their own owner seat.
    if (member.id === auth.member.id && member.role === 'owner' && patch.role && patch.role !== 'owner') {
      throw httpError('CANNOT_DEMOTE_OWNER', 403);
    }
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
    assertCan(auth.member, 'manage_staff');
    const p = z.object({ id: z.string() }).parse(request.params);
    const member = await repo.getMember(p.id);
    if (!member || member.tenantId !== auth.tenantId) throw httpError('NOT_FOUND', 404);
    // Guard the owner account and self-deletion: a user may not delete their own
    // seat, and the owner seat is never deletable.
    if (member.id === auth.member.id) throw httpError('CANNOT_DELETE_SELF', 403);
    if (member.role === 'owner') throw httpError('CANNOT_DELETE_OWNER', 403);
    await repo.deleteMember(p.id);
    await audit(repo, { tenantId: auth.tenantId, ...staffAudit(auth.member.id), action: 'staff_delete', objectType: 'member', objectId: p.id });
    return { ok: true };
  });

  app.post('/api/tenants/:tenantId/invite', async (request, reply) => {
    const auth = await requireAuth(request, repo);
    assertCan(auth.member, 'manage_staff');
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
    // If password provided, create user account directly (skip invite email).
    // Must use linkUserToMembership(): updateMember() cannot write user_id, and
    // login resolves the membership via findActiveMembershipByUserId(), so
    // without this link the account gets NO_ACTIVE_MEMBERSHIP on login.
    if (input.password) {
      const passwordHash = await bcrypt.hash(input.password, 10);
      const user = await repo.createUser({ email, passwordHash, displayName: input.displayName });
      await repo.linkUserToMembership(member.id, user.id);
      await repo.updateMember(member.id, { status: 'active' });
    } else {
      const invited = await repo.updateMember(member.id, { status: 'active' });
    }
    return reply.code(201).send({ ok: true, member: await repo.getMember(member.id) });
  });
}
