# Cursor Phase 1 Prompt — Fidean Clinic SaaS

You are continuing `/root/fidean_workspaces/fidean-clinic-saas`.

## Goal
Turn the current in-memory Fastify MVP into a persistent multi-tenant clinic SaaS foundation.

## Non-negotiables
- Clean-room implementation. Do not copy KiviCare Pro/add-on code.
- Tenant can have many branches.
- Patient belongs to tenant, not a single branch.
- Appointment belongs to tenant + branch + patient.
- Backend RBAC first; UI hiding is not security.
- Payment/Paystack is out of scope until Caleb explicitly approves.

## Start by running

```bash
npm install
npm test
npm run build
npm run dev
```

## Phase 1 deliverables

1. Add PostgreSQL repository using `docs/schema.sql` as the base.
2. Keep the existing MemoryStore tests passing.
3. Add repository interface tests for tenant/branch/patient/appointment behavior.
4. Add auth placeholder middleware with tenant/member context.
5. Add CRUD endpoints:
   - tenants
   - branches
   - members
   - patients
   - services
   - appointments
6. Add simple dashboard UI pages/tabs:
   - Overview
   - Branches
   - Patients
   - Appointments
   - Staff
   - Services
7. Add appointment status transitions:
   - requested → confirmed
   - confirmed → checked_in
   - checked_in → completed
   - requested/confirmed → cancelled
8. Add seed script for Celon Dental with two branches.

## Verification required

- `npm test` passes.
- `npm run build` passes.
- Local server boots.
- `/health` returns ok.
- `/api/demo/celon` returns 2 branches.
- UI loads and shows tenant/branches/appointments.
