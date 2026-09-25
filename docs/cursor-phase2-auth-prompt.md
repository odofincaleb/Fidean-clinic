# Cursor Phase 2B Prompt — Real Auth (JWT + bcrypt)

You are continuing in `/root/fidean_workspaces/fidean-clinic-saas` via SSH.

## Goal
Replace the header-based auth placeholders (`x-tenant-id`, `x-member-id`) with real JWT auth using bcrypt password hashing, login/register endpoints, and staff invitation flow.

## Non-negotiables
- Keep ALL existing 15 tests passing (test suite uses MemoryClinicRepository with injected repo, not JWT).
- Keep the `ClinicRepository` interface unchanged — do not break memory store or Postgres.
- The `requireAuth` return type `AuthContext { tenantId, member }` MUST stay the same shape so the rest of the server routes work unchanged.
- Backwards-compat: the `POST /api/demo/celon` endpoint should still work without auth (it's a dev/debug convenience).
- `.env` needs `JWT_SECRET` (and `JWT_EXPIRES_IN` optional).
- Use `bcryptjs` (pure JS, no native compile) and `jsonwebtoken`.
- `@types/bcryptjs` and `@types/jsonwebtoken` as devDependencies.

## What to implement

### 1. Dependencies
```bash
npm install bcryptjs jsonwebtoken
npm install --save-dev @types/bcryptjs @types/jsonwebtoken
```

### 2. `.env` additions
Add to `.env.example` and `.env`:
```env
JWT_SECRET=clinic-saas-dev-secret-change-in-production
JWT_EXPIRES_IN=7d
```

### 3. Auth endpoints (`src/routes/auth.ts`)
Create a new auth routes file, register it in `src/server.ts`:

**POST /api/auth/register**
- Body: `{ name, slug, email, password, displayName? }`
- Creates tenant, creates user with bcrypt hashed password, creates membership (role=owner, status=active), links user_id to membership
- Returns JWT + tenant + member
- Validation: email not already registered, slug not taken

**POST /api/auth/login**
- Body: `{ email, password }`
- Find user by email (query `users` table), verify bcrypt
- Find active membership for that user (query `tenant_memberships` where user_id=user.id AND status='active')
- Returns JWT + tenant + member
- Error: `401 INVALID_CREDENTIALS` if email not found or password wrong
- Error: `403 NO_ACTIVE_MEMBERSHIP` if user exists but no active membership

**GET /api/auth/me**
- Requires Bearer token
- Returns current user + member + tenant

**POST /api/tenants/:tenantId/invite**
- Requires `manage_staff` permission
- Body: `{ email, role, branchIds?, displayName? }`
- Creates `tenant_memberships` row with status='invited', no user_id (user hasn't registered yet)
- Returns the membership
- Later: email sending out of scope, but the membership record is ready for it

### 4. Repository additions
Add to `ClinicRepository` interface and both `MemoryClinicRepository` + `PostgresClinicRepository`:

```ts
findUserByEmail(email: string): Promise<{ id: string; email: string; passwordHash: string; displayName?: string } | undefined>
createUser(input: { email: string; passwordHash: string; displayName?: string }): Promise<{ id: string; email: string }>
findActiveMembershipByUserId(userId: string): Promise<Member | undefined>
findMembershipByEmail(tenantId: string, email: string): Promise<Member | undefined>
linkUserToMembership(membershipId: string, userId: string): Promise<void>
```

For `MemoryClinicRepository`, store users in a `Map<string, {...}>` and store membership→user links.

For `PostgresClinicRepository`:
- `findUserByEmail`: `SELECT id, email, password_hash, display_name FROM users WHERE email = $1`
- `createUser`: `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email`
- `findActiveMembershipByUserId`: `SELECT * FROM tenant_memberships WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1` (then mapMember)
- `findMembershipByEmail`: `SELECT * FROM tenant_memberships WHERE tenant_id = $1 AND email = $2`
- `linkUserToMembership`: `UPDATE tenant_memberships SET user_id = $1, status = 'active', accepted_at = now() WHERE id = $2`

### 5. Auth middleware rewrite (`src/auth/context.ts`)
Replace the header-based `requireAuth` with JWT-based:

```ts
import type { FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import type { Member } from '../domain/types.js';
import { httpError } from '../http/errors.js';
import type { ClinicRepository } from '../repositories/ClinicRepository.js';

export interface AuthContext {
  tenantId: string;
  member: Member;
}

export interface JwtPayload {
  sub: string;       // member id
  tenantId: string;
  role: string;
  email: string;
  iat?: number;
  exp?: number;
}

const SECRET = () => process.env.JWT_SECRET || 'dev-fallback-secret';

export function signToken(payload: { memberId: string; tenantId: string; role: string; email: string }): string {
  return jwt.sign(payload, SECRET(), { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

export async function requireAuth(request: FastifyRequest, repo: ClinicRepository): Promise<AuthContext> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw httpError('AUTH_REQUIRED', 401);
  }
  const token = authHeader.slice(7);
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, SECRET()) as JwtPayload;
  } catch {
    throw httpError('INVALID_TOKEN', 401);
  }
  const member = await repo.getMember(payload.sub);
  if (!member || member.tenantId !== payload.tenantId || member.status !== 'active') {
    throw httpError('FORBIDDEN', 403);
  }
  return { tenantId: member.tenantId, member };
}
```

### 6. Server wiring (`src/server.ts`)
- Import and register the auth routes
- `POST /api/auth/login` and `POST /api/auth/register` must NOT require auth themselves (use `preHandler` or just don't call `requireAuth` in those handlers)
- Keep `POST /api/demo/celon` unprotected
- Keep `GET /health` unprotected
- All other routes still use `requireAuth` — the middleware change is internal (JWT decode instead of header read)

### 7. UI update (`public/app.js`, `public/index.html`, `public/style.css`)
- Add a login/register form to the main page (or a new section)
- Demo button stays for convenience
- On login success or demo seed, store JWT in `localStorage` and set it as a global variable
- The `headers()` function sets `Authorization: Bearer <token>` instead of `x-tenant-id` / `x-member-id`
- On page load, check localStorage for existing JWT, decode it, and if valid, load the dashboard automatically (skip the demo button click)
- `GET /api/tenants/:tenantId/snapshot` still works without auth headers (it's currently unprotected — keep it that way so the UI snapshot refresh works)
- Add a simple login form: email + password + Login button, and a "Register" toggle
- Add a simple register form: name, slug, email, password, displayName + Register button
- Style the login/register form to look decent alongside the existing dashboard

### 8. `POST /api/auth/register` in seed consideration
The existing `npm run seed` and `POST /api/demo/celon` create members without user accounts. This is fine for dev — they bypass auth. The seed is a dev shortcut. Keep it working.

### 9. Tests
- The existing 15 tests all use `buildServer({ repository: repo })` with injected memory repos, and the tests set `x-tenant-id` / `x-member-id` headers. These tests must still pass **unchanged**.
- To achieve this: make `requireAuth` try JWT Bearer first, but if the header is `x-tenant-id` / `x-member-id` instead (backwards compat), accept that as well. OR: just update the test auth headers to use Bearer token (generate tokens in tests). PREFERRED: keep backwards compat in requireAuth so existing tests don't need to change. Check for `x-tenant-id` + `x-member-id` as fallback after Bearer fails.
- Add new tests for auth flow:
  - register creates tenant + user + owner membership
  - login returns JWT with valid claims
  - login with wrong password returns 401
  - /api/auth/me returns current user
  - invite creates membership with status='invited'
  - JWT with expired/invalid token returns 401

## Required final verification

```bash
npm install
npm test
npm run build
npm run seed
npm run dev
```

Smoke:

```bash
# Register a new tenant
curl -sS -X POST http://127.0.0.1:4310/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Clinic","slug":"test-clinic","email":"admin@test.com","password":"secret123","displayName":"Admin"}'

# Login
curl -sS -X POST http://127.0.0.1:4310/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.com","password":"secret123"}'

# Me
curl -sS http://127.0.0.1:4310/api/auth/me \
  -H 'Authorization: Bearer <token>'

# Create appointment with JWT
curl -sS -X POST http://127.0.0.1:4310/api/appointments \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"tenantId":"...","branchId":"...","patientId":"...","startsAt":"2026-09-10T10:00:00Z","serviceName":"Checkup"}'

# Invite staff
curl -sS -X POST http://127.0.0.1:4310/api/tenants/<tenantId>/invite \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"email":"staff@test.com","role":"receptionist","branchIds":["..."]}'
```

Browser check:
- Open `http://127.0.0.1:4310/`
- See login/register form
- Register a new clinic
- Dashboard loads with the new tenant
- All six tabs render
- No console errors

## Do not claim complete until
- `npm test` passes (all 15 existing tests + new auth tests)
- `npm run build` passes
- Login/register/invite endpoints return correct responses
- UI shows login form and can authenticate
- Demo button still works
- Dashboard renders with JWT-authenticated data