# Cursor QA Fix Prompt — Fidean Clinic SaaS Phase 1

Devin QA checked `/root/fidean_workspaces/fidean-clinic-saas` after your Phase 1 handoff. The handoff claims do NOT match the actual workspace files currently present.

## QA finding
The workspace still appears to be the earlier in-memory v0.1.0 MVP, not the persistent Phase 1 foundation.

Verified actual state:
- `npm test` passes, but only **3 tests**, not 12.
- `npm run build` passes.
- `package.json` has no `seed`, no `docker compose`, no `pg` dependency, and no Postgres-related scripts.
- `src/server.ts` imports only `store/singleton.js` and directly uses an in-memory store.
- No detected source markers for:
  - `ClinicRepository`
  - `DATABASE_URL`
  - `x-tenant-id`
  - `x-member-id`
  - Postgres implementation
  - `/api/members`
  - `/api/services`
  - appointment transition endpoints
- Browser UI still shows only the original simple dashboard:
  - hero
  - Load Celon 2-branch demo
  - Branches
  - Appointments
- Browser UI does **not** show the claimed tabs:
  - Overview
  - Branches
  - Patients
  - Appointments
  - Staff
  - Services

## Required correction
Actually implement the Phase 1 features in the workspace, then rerun verification.

## Required Phase 1 implementation

### 1. Repository layer
Create a shared repository contract, for example:

```ts
src/repositories/ClinicRepository.ts
src/repositories/MemoryClinicRepository.ts
src/repositories/PostgresClinicRepository.ts
src/repositories/index.ts
```

The app should choose:

```ts
DATABASE_URL set -> PostgresClinicRepository
DATABASE_URL absent -> MemoryClinicRepository
```

### 2. PostgreSQL persistence
Use `docs/schema.sql` as the source of truth and implement Postgres CRUD with `pg`.

Add dependencies/scripts:

```json
"pg": "latest"
```

Dev dependency if needed:

```json
"@types/pg": "latest"
```

Add scripts:

```json
"seed": "tsx src/scripts/seed.ts"
```

Optional but useful:

```json
"db:schema": "psql $DATABASE_URL -f docs/schema.sql"
```

Create `.env.example` with:

```env
PORT=4310
HOST=127.0.0.1
DATABASE_URL=
```

If adding Docker, include `docker-compose.yml` for local Postgres.

### 3. Auth placeholder + RBAC
Add middleware that reads:

```http
x-tenant-id
x-member-id
```

Mutating routes must enforce backend RBAC, not only UI hiding.

Examples:
- owner/admin can manage all tenant data.
- branch_manager can manage assigned branch appointments/patients, not other branches.
- doctor can read own appointments/encounters and create clinical notes later.
- receptionist can create appointments but not manage subscription/staff.

### 4. CRUD endpoints
Implement real CRUD for:

```text
tenants
branches
members
patients
services
appointments
```

Minimum routes:

```text
GET/POST /api/tenants
GET/PATCH /api/tenants/:tenantId
GET/POST /api/branches
GET/PATCH /api/branches/:branchId
GET/POST /api/members
GET/PATCH /api/members/:memberId
GET/POST /api/patients
GET/PATCH /api/patients/:patientId
GET/POST /api/services
GET/PATCH /api/services/:serviceId
GET/POST /api/appointments
GET/PATCH /api/appointments/:appointmentId
GET /api/tenants/:tenantId/snapshot
```

### 5. Appointment workflow endpoints
Implement status transitions:

```text
requested -> confirmed
confirmed -> checked_in
checked_in -> completed
requested/confirmed -> cancelled
```

Reject invalid transitions with HTTP 400/409.

Add endpoint like:

```text
POST /api/appointments/:appointmentId/transition
body: { "status": "confirmed" }
```

### 6. Dashboard tabs
Update UI to include real tabs:

```text
Overview
Branches
Patients
Appointments
Staff
Services
```

Each tab should render data from the API. Forms can be simple but must work against the backend.

### 7. Celon seed
Implement:

```bash
npm run seed
```

And keep:

```text
POST /api/demo/celon
```

Seed should create:
- Tenant: Celon Dental Clinic
- Branches: Lekki, Ikeja
- owner
- doctor assigned to both branches
- one demo patient
- one demo appointment
- at least two services

### 8. Tests
Expand tests to cover at least:
- tenant can have multiple branches
- patients are tenant-wide
- appointment belongs to tenant + branch
- branch manager cannot mutate another branch
- receptionist can create appointment
- invalid appointment transition rejected
- valid appointment workflow accepted
- Memory repository CRUD
- Repository factory chooses memory when no DATABASE_URL
- Postgres repository module compiles without DATABASE_URL
- API returns 401/403 when auth headers missing/insufficient on protected mutations
- Celon demo returns 2 branches

## Required final verification output
After implementation, run and report exact output:

```bash
npm install
npm test
npm run build
npm run seed
npm run dev
```

Smoke checks:

```bash
curl -sS http://127.0.0.1:4310/health
curl -sS -X POST http://127.0.0.1:4310/api/demo/celon
curl -sS http://127.0.0.1:4310/api/tenants/<tenantId>/snapshot
```

Browser check:
- Open `http://127.0.0.1:4310/`
- Confirm all six tabs render.
- Confirm no console errors.

## Do not claim complete until
- Tests show the expanded count, not the old 3 tests.
- Source contains `ClinicRepository`, `PostgresClinicRepository`, `DATABASE_URL`, `x-tenant-id`, and `x-member-id`.
- UI contains all six tabs.
- API mutating routes enforce backend RBAC.
