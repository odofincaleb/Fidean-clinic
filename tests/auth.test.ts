import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { MemoryClinicRepository } from '../src/repositories/MemoryClinicRepository.js';
import { buildServer } from '../src/server.js';
import { SECRET, signToken } from '../src/auth/context.js';

async function registerClinic(app: ReturnType<typeof buildServer>, slug = 'auth-clinic') {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      name: 'Auth Clinic',
      slug,
      email: `owner-${slug}@example.com`,
      password: 'secret123',
      displayName: 'Clinic Owner',
    },
  });
}

describe('JWT auth flow', () => {
  it('register creates tenant + user + owner membership', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const response = await registerClinic(app, 'new-clinic');
    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body.tenant.name).toBe('Auth Clinic');
    expect(body.member.role).toBe('owner');
    expect(body.member.status).toBe('active');
    expect(body.token).toBeTruthy();
    const user = await repo.findUserByEmail('owner-new-clinic@example.com');
    expect(user?.passwordHash).toMatch(/^\$2[aby]\$/);
    await app.close();
  });

  it('login returns JWT with valid claims', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    await registerClinic(app, 'login-clinic');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner-login-clinic@example.com', password: 'secret123' },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    const claims = jwt.verify(body.token, SECRET()) as jwt.JwtPayload;
    expect(claims.sub).toBe(body.member.id);
    expect(claims.tenantId).toBe(body.tenant.id);
    expect(claims.email).toBe('owner-login-clinic@example.com');
    expect(claims.role).toBe('owner');
    await app.close();
  });

  it('login with wrong password returns 401', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    await registerClinic(app, 'wrong-pass');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner-wrong-pass@example.com', password: 'nope-nope' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('INVALID_CREDENTIALS');
    await app.close();
  });

  it('/api/auth/me returns current user', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const registered = (await registerClinic(app, 'me-clinic')).json();
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${registered.token}` },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.user.email).toBe('owner-me-clinic@example.com');
    expect(body.member.id).toBe(registered.member.id);
    expect(body.tenant.id).toBe(registered.tenant.id);
    await app.close();
  });

  it('invite creates membership with status=invited', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const registered = (await registerClinic(app, 'invite-clinic')).json();
    const response = await app.inject({
      method: 'POST',
      url: `/api/tenants/${registered.tenant.id}/invite`,
      headers: { authorization: `Bearer ${registered.token}` },
      payload: { email: 'staff@example.com', role: 'receptionist' },
    });
    const body = response.json();
    expect(response.statusCode).toBe(201);
    expect(body.member.status).toBe('invited');
    expect(body.member.email).toBe('staff@example.com');
    await app.close();
  });

  it('JWT with expired/invalid token returns 401', async () => {
    const repo = new MemoryClinicRepository();
    const app = buildServer({ repository: repo });
    const registered = (await registerClinic(app, 'token-clinic')).json();
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(invalid.statusCode).toBe(401);

    const expired = jwt.sign(
      {
        sub: registered.member.id,
        tenantId: registered.tenant.id,
        role: 'owner',
        email: registered.member.email,
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      SECRET(),
    );
    const expiredResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(signToken({ memberId: registered.member.id, tenantId: registered.tenant.id, role: 'owner', email: registered.member.email })).toBeTruthy();
    await app.close();
  });
});
