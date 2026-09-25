# Cursor Phase 3C Prompt — Security Hardening + Availability Guardrails + Production Readiness

## ROLE
You are Cursor implementing Phase 3C for Fidean Clinic SaaS in the shared SSH workspace:

```text
/root/fidean_workspaces/fidean-clinic-saas
```

This is a clean-room, Fidean-owned standalone clinic SaaS. KiviCare may be used only as workflow/market reference. Do NOT copy KiviCare source code, table names beyond generic domain concepts, route names, UI templates, assets, license/payment logic, or identifiers.

## VERIFIED BASELINE BEFORE THIS PHASE
Devin independently QA-verified Phase 3B:

- App: Fastify + TypeScript + PostgreSQL 16.
- `/health` returns `0.5.0`.
- Tests: `47 passed`.
- Build: `npm run build` / `tsc --noEmit` passes.
- Seed/demo: Celon snapshot includes:
  - branches: 2
  - doctorSchedules: 2
  - appointments: 1
  - encounters: 1
  - prescriptions: 1
  - invoices: 1
  - patientDocuments: 1
  - patientAccounts: 1
  - notificationJobs: 3
  - auditLogs: 4
- Staff tabs verified:
  - Overview, Branches, Patients, Appointments, Staff, Services
  - Calendar, Schedules, Encounters, Prescriptions, Billing, Documents
  - Patient Portal, Notifications, Audit Logs
- Patient portal login verified with demo patient:
  - appointments: 1
  - prescriptions: 1
  - invoices: 1
  - documents: 1
- Billing hardening verified:
  - overpay rejected with `PAYMENT_EXCEEDS_BALANCE`.
- Staff-vs-patient JWT separation verified:
  - staff JWT rejected by patient `/me` with `PATIENT_AUTH_REQUIRED`.
  - patient JWT rejected by staff endpoint with `STAFF_AUTH_REQUIRED`.

Known limitations documented in README:

- Activation tokens are SHA-256 hashed but have no expiry yet.
- Draft invoices remain payable and auto-issue on first payment.
- Patient accounts are unique per `(tenantId, email)` and `(tenantId, patientId)`.
- Notification jobs are queued only; no external sending.
- No real file uploads.
- Audit `actorUserId` is omitted because schema FK points to `users.id`, while many actions use membership context.

## PHASE 3C GOAL
Move the product closer to a safe pilot by hardening the system around security, appointment integrity, and operational readiness.

Implement:

1. Patient activation token expiry + one-time-use safeguards.
2. Patient account lifecycle controls: resend invite, disable account, password reset request/complete.
3. Correct audit actor model for staff membership and patient accounts.
4. Appointment availability/conflict guardrails using doctor schedules.
5. Draft invoice payment hardening: require issuing before payment.
6. Notification provider abstraction in dry-run/dev mode only.
7. Operational readiness endpoints/views for settings/status — no production deploy.
8. Tests, seed/demo expansion, live smoke, and browser QA.

This phase must **not** add external paid/risky integrations. It should make the current product safer and more clinic-realistic.

## EXPLICITLY OUT OF SCOPE
Do NOT implement these in Phase 3C:

- Paystack, Stripe, WooCommerce, KnitPay, or any real payment gateway.
- Real SMS/WhatsApp/email sending to external providers.
- OpenAI/OpenRouter/AI clinical assistant.
- Telemedicine/Zoom/Google Meet.
- Mobile app.
- WordPress connector/plugin.
- Production deployment or Nginx/PM2 setup.
- Real binary file uploads/storage.
- Multi-clinic subscription billing.

For notifications, implement provider abstraction and dry-run logging only.

---

# STEP 1 — DISCOVERY BEFORE EDITING
Run and inspect before changing code:

```bash
pwd
git status --short
sed -n '1,280p' README.md
sed -n '1,320p' docs/schema.sql
sed -n '1,320p' src/domain/types.ts
sed -n '1,320p' src/domain/clinical.ts
sed -n '1,280p' src/auth/context.ts
sed -n '1,420p' src/repositories/ClinicRepository.ts
sed -n '1,520p' src/repositories/MemoryClinicRepository.ts
sed -n '1,640p' src/repositories/PostgresClinicRepository.ts
sed -n '1,420p' src/routes/portal.ts
sed -n '1,420p' src/routes/clinical.ts
sed -n '1,420p' src/server.ts
sed -n '1,560p' public/app.js
sed -n '1,340p' public/index.html
sed -n '1,340p' public/style.css
sed -n '1,360p' tests/patient-portal-notifications.test.ts
sed -n '1,360p' tests/clinical-workflow.test.ts
```

Do not proceed if the workspace materially differs from the verified Phase 3B baseline above.

---

# REQUIRED FEATURE 1 — PATIENT ACTIVATION TOKEN EXPIRY + ONE-TIME USE

## Data model changes
Update `PatientAccount` to include:

```ts
activationTokenExpiresAt?: string;
activationTokenUsedAt?: string;
passwordResetTokenHash?: string;
passwordResetTokenExpiresAt?: string;
passwordResetTokenUsedAt?: string;
```

Update PostgreSQL table `patient_accounts`:

```sql
activation_token_expires_at timestamptz,
activation_token_used_at timestamptz,
password_reset_token_hash text,
password_reset_token_expires_at timestamptz,
password_reset_token_used_at timestamptz
```

Because this project currently applies `docs/schema.sql` in a fresh database flow, update that schema. If migration support exists or is simple, also add a migration under `docs/migrations/` or `src/migrations/`, but do not overbuild.

## Activation rules
When creating a patient invite:

- Generate random token as now.
- Store SHA-256 hash only.
- Set `activationTokenExpiresAt` to now + 72 hours.
- `activationTokenUsedAt` starts undefined/null.
- Return the raw token only in local/dev response as currently done.

When activating:

Reject with clear errors:

- unknown token: `INVALID_ACTIVATION_TOKEN`, HTTP 401.
- expired token: `ACTIVATION_TOKEN_EXPIRED`, HTTP 410.
- already used token: `ACTIVATION_TOKEN_USED`, HTTP 409.
- disabled account: `PATIENT_ACCOUNT_DISABLED`, HTTP 403.

On success:

- Hash password.
- Set status `active`.
- Clear or retain activation token hash? Safe default: retain hash for audit but set `activationTokenUsedAt` and reject reuse. If you clear hash, ensure reuse still rejects deterministically if possible. Prefer retaining hash + usedAt.
- Set `activationTokenUsedAt`.
- Record audit log.

## Resend invite
Add staff endpoint:

```text
POST /api/patient-auth/:accountId/resend-invite
```

Rules:

- staff auth required.
- owner/admin/receptionist/doctor can resend if they can view the patient.
- account must belong to tenant.
- account status must be `invited`; reject active/disabled with `PATIENT_ACCOUNT_NOT_INVITED`, HTTP 409.
- generate new activation token hash and expiry.
- queue `patient_portal_invite` notification.
- record audit.
- return raw token in dev response only.

---

# REQUIRED FEATURE 2 — PATIENT ACCOUNT LIFECYCLE + PASSWORD RESET

## Disable patient account
Add staff endpoint:

```text
POST /api/patient-auth/:accountId/disable
```

Rules:

- owner/admin only by default. If you allow doctor/receptionist, document why. Safe default: owner/admin.
- account must belong to tenant.
- set status `disabled`.
- patient JWT should no longer work after disable.
- record audit.

## Password reset request
Add public endpoint:

```text
POST /api/patient-auth/password-reset/request
```

Body:

```json
{
  "tenantSlug": "...",
  "email": "patient@example.com"
}
```

Rules:

- Always return `{ "ok": true }` to avoid account enumeration.
- If tenant/account exists and active:
  - create reset token hash.
  - set expiry to now + 60 minutes.
  - queue notification job type `patient_password_reset`.
  - record audit.
  - include raw `resetToken` only in local/dev response if current pattern supports dev-safe return.
- If no account, do nothing but still return ok.

Update `NotificationJob['type']` to include:

```ts
'patient_password_reset'
```

## Password reset complete
Add public endpoint:

```text
POST /api/patient-auth/password-reset/complete
```

Body:

```json
{
  "token": "...",
  "password": "NewPassw0rd123"
}
```

Rules:

- unknown token: `INVALID_PASSWORD_RESET_TOKEN`, HTTP 401.
- expired: `PASSWORD_RESET_TOKEN_EXPIRED`, HTTP 410.
- already used: `PASSWORD_RESET_TOKEN_USED`, HTTP 409.
- disabled account: `PATIENT_ACCOUNT_DISABLED`, HTTP 403.
- success hashes new password, sets usedAt, records audit, returns `{ ok: true }`.
- Old password must no longer login; new password must login.

---

# REQUIRED FEATURE 3 — CORRECT AUDIT ACTOR MODEL

The current schema has `actor_user_id uuid REFERENCES users(id)` but actions frequently know membership id, not user id. Fix this without breaking existing tests.

## Schema/model
Update `AuditLog` type to support:

```ts
actorUserId?: string;
actorMemberId?: string;
actorPatientAccountId?: string;
actorType?: 'staff' | 'patient' | 'system';
```

Update `audit_logs` table:

```sql
actor_member_id uuid REFERENCES tenant_memberships(id) ON DELETE SET NULL,
actor_patient_account_id uuid REFERENCES patient_accounts(id) ON DELETE SET NULL,
actor_type text CHECK (actor_type IN ('staff','patient','system'))
```

## Recording rules
Update `recordAuditLog` to accept actor fields.

For staff-authenticated actions:

- set `actorType: 'staff'`.
- set `actorMemberId` to current membership id.
- set `actorUserId` only if available.

For patient-authenticated actions:

- set `actorType: 'patient'`.
- set `actorPatientAccountId`.

For seed/system demo:

- set `actorType: 'system'`.

Record actor metadata for:

- patient invite/resend/disable.
- patient activation/password reset.
- encounter sign.
- prescription issue/cancel if implemented.
- invoice create/issue/payment/void.
- notification queue/state transitions.

## Route output
`GET /api/audit-logs` should return these actor fields.

---

# REQUIRED FEATURE 4 — APPOINTMENT AVAILABILITY + CONFLICT GUARDRAILS

Current appointment creation is too permissive. Add schedule-aware checks.

## Requirements
When creating an appointment with `doctorMemberId`:

1. Doctor/member must belong to tenant.
2. Doctor must be active.
3. Doctor role should be `doctor` or owner/admin explicitly allowed. Safe default: role must be `doctor`.
4. Doctor must be assigned to the branch OR branch rules must permit it.
5. There must be an active doctor schedule for:
   - same tenant
   - same branch
   - same doctor
   - matching weekday
   - appointment start time within schedule start/end
6. Prevent conflicting overlapping appointments for the same doctor.
7. Prevent double-booking the same patient at the same time.

Use `serviceName` or service duration if available:

- If request body includes `serviceId`, use service duration.
- If only `serviceName`, attempt to match active service by name in tenant/branch and use duration.
- Fallback duration: 30 minutes.

## Error codes
Use explicit errors:

- `DOCTOR_NOT_AVAILABLE`, HTTP 409.
- `APPOINTMENT_CONFLICT`, HTTP 409.
- `PATIENT_APPOINTMENT_CONFLICT`, HTTP 409.
- `INVALID_DOCTOR`, HTTP 400 or 404.

## Availability endpoint
Add staff endpoint:

```text
GET /api/availability?branchId=&doctorMemberId=&date=YYYY-MM-DD
```

Returns:

```json
{
  "ok": true,
  "date": "2026-09-15",
  "branchId": "...",
  "doctorMemberId": "...",
  "slotMinutes": 30,
  "slots": [
    { "startsAt": "2026-09-15T09:00:00.000Z", "available": true },
    { "startsAt": "2026-09-15T09:30:00.000Z", "available": false, "reason": "APPOINTMENT_CONFLICT" }
  ]
}
```

Rules:

- Requires staff auth.
- Applies tenant and branch RBAC.
- Uses doctor schedule + existing appointments.
- Do not require timezone perfection; assume server/local UTC for this phase, but document it as a limitation.

## UI
Update appointment/calendar UI to show:

- Availability check form or button.
- Slots for selected doctor/branch/date.
- Clear error messages when conflicting appointment creation is rejected.

---

# REQUIRED FEATURE 5 — INVOICE ISSUE BEFORE PAYMENT

The README says draft invoices remain payable. Phase 3C should harden this.

## Add issue endpoint if missing
Add:

```text
POST /api/invoices/:invoiceId/issue
```

Rules:

- Requires `manage_billing`.
- Draft invoice can be issued.
- Set `issuedAt` and status `issued`.
- Queue `invoice_issued` notification.
- Record audit.

## Payment rules
Update payment endpoint:

- If invoice is `draft`, reject with `INVOICE_NOT_ISSUED`, HTTP 409.
- If invoice is `void`, reject with `INVOICE_VOID`, HTTP 409.
- If amount exceeds balance, reject with `PAYMENT_EXCEEDS_BALANCE`, HTTP 409.
- Keep part-paid/paid logic.
- Queue `invoice_payment_received` notification on success.
- Record audit with actor fields.

Update tests that depended on draft auto-issue.

Update README limitation: draft invoices are no longer payable; they require issue first.

---

# REQUIRED FEATURE 6 — NOTIFICATION PROVIDER ABSTRACTION, DRY RUN ONLY

Do not send real messages. Add a clean abstraction so real providers can be plugged in later.

## Types
Add:

```ts
export interface NotificationProviderResult {
  ok: boolean;
  provider: 'dry_run';
  providerMessageId?: string;
  error?: string;
}
```

Add provider module, e.g.:

```text
src/notifications/provider.ts
```

It should support only dry-run now:

```ts
sendNotificationDryRun(job: NotificationJob): Promise<NotificationProviderResult>
```

Dry run should:

- validate recipient/channel/body enough to catch obvious bad jobs.
- return a fake providerMessageId like `dryrun_<jobId>`.
- never call external network.

## Send queued endpoint
Add staff endpoint:

```text
POST /api/notifications/:jobId/send-dry-run
```

Rules:

- owner/admin only.
- job must be queued.
- calls dry-run provider.
- if ok, mark sent; if fail, mark failed.
- record audit.

Do not remove existing mark-sent/mark-failed/cancel dev endpoints.

## Schema optional
If useful, add fields:

```sql
provider text,
provider_message_id text
```

Not required if this complicates mapping, but preferred.

---

# REQUIRED FEATURE 7 — OPERATIONAL READINESS / SETTINGS VIEW

Add a simple non-secret status endpoint and dashboard view.

## Endpoint
Add staff/admin endpoint:

```text
GET /api/system/status
```

Rules:

- owner/admin only.
- Returns no secrets.
- Include:
  - service version.
  - database mode: `postgres` or `memory`.
  - current time.
  - notification provider mode: `dry_run`.
  - feature flags/status booleans:
    - patientPortal: true
    - notificationsQueue: true
    - dryRunNotifications: true
    - paymentGateway: false
    - realFileUploads: false
    - aiClinicalAssistant: false

Example:

```json
{
  "ok": true,
  "service": "fidean-clinic-saas",
  "version": "0.6.0",
  "databaseMode": "postgres",
  "notificationProvider": "dry_run",
  "features": {...},
  "time": "..."
}
```

## UI
Add staff dashboard tab:

```text
System Status
```

Show the status values clearly.

---

# REQUIRED UI UPDATES
Update `public/index.html`, `public/app.js`, and `public/style.css`.

Must include:

1. Appointment availability checker:
   - select branch
   - select doctor
   - select date
   - button to load slots
   - display available/unavailable slots.

2. Billing:
   - issue invoice button.
   - payment form should show rejection if invoice is draft.
   - display invoice status/balance clearly.

3. Patient Portal admin tab:
   - display activation expiry/used state if returned.
   - resend invite button.
   - disable patient account button.

4. Notifications tab:
   - send dry-run button for queued notifications.
   - show provider/providerMessageId if available.

5. Audit Logs tab:
   - show actor type/member/patient account fields.

6. System Status tab:
   - shows `/api/system/status` output.

7. Patient login/portal still works.

Keep UI basic but functional. No polished design needed yet.

---

# DEMO/SEED REQUIREMENTS
Update Celon demo/seed so it includes:

- Existing Phase 3B data.
- Patient account with activation expiry/used fields if active.
- At least one queued notification suitable for `send-dry-run`.
- At least one sent dry-run notification if easy.
- Audit logs with actorType values:
  - at least one `system`.
  - at least one `staff` after smoke actions, or seeded if appropriate.
  - at least one `patient` after activation/password reset flow in tests/smoke.

`POST /api/demo/celon` should still return:

- staff JWT.
- snapshot arrays/counts.
- dev patient login object.

Do not expose real secrets.

---

# TEST REQUIREMENTS
Add a new test file, e.g.:

```text
tests/security-availability-readiness.test.ts
```

Add tests covering at least these cases:

1. Patient activation token expires after 72 hours / expired token rejected with `ACTIVATION_TOKEN_EXPIRED`.
2. Activation token cannot be reused: `ACTIVATION_TOKEN_USED`.
3. Resend invite creates a new activation token and expiry; old token no longer activates.
4. Disabled patient account cannot login and existing patient JWT no longer works.
5. Password reset request does not reveal missing accounts.
6. Password reset complete changes password, rejects old password, accepts new password.
7. Password reset token cannot be reused and rejects expired token.
8. Audit logs include actorType + actorMemberId for staff actions.
9. Audit logs include actorType + actorPatientAccountId for patient action if applicable.
10. Appointment creation outside doctor schedule rejects `DOCTOR_NOT_AVAILABLE`.
11. Appointment creation overlapping existing doctor appointment rejects `APPOINTMENT_CONFLICT`.
12. Same patient double booking rejects `PATIENT_APPOINTMENT_CONFLICT`.
13. `/api/availability` returns slots and marks booked slot unavailable.
14. Draft invoice payment rejects `INVOICE_NOT_ISSUED`.
15. Invoice issue endpoint works and queues notification.
16. Payment after issue works and queues notification.
17. Dry-run notification send marks queued job sent and records provider result.
18. `/api/system/status` owner/admin works and contains no secret-looking values.
19. Lower role cannot read `/api/system/status`.
20. Celon demo includes Phase 3C fields/counts and still supports patient login.

All previous 47 tests must still pass or be intentionally updated for draft invoice hardening.

---

# BUILD/QA GATES — DO NOT CLAIM DONE UNTIL THESE PASS
Run:

```bash
npm test
npm run build
npm run seed
```

Then start/confirm dev server:

```bash
npm run dev
curl -sS http://127.0.0.1:4310/health
```

Expected health version:

```json
{"ok":true,"service":"fidean-clinic-saas","version":"0.6.0"}
```

Live demo count check:

```bash
curl -sS -X POST http://127.0.0.1:4310/api/demo/celon \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Verify snapshot still includes all arrays:

- branches
- doctorSchedules
- appointments
- encounters
- prescriptions
- invoices
- patientDocuments
- patientAccounts
- notificationJobs
- auditLogs

JWT smoke must prove:

- Patient invite → activation works.
- Reusing activation token fails.
- Password reset request/complete works.
- Disabled patient cannot login/use JWT.
- Availability slots return and conflicts are rejected.
- Draft invoice payment fails; issue then payment succeeds.
- Dry-run notification send marks sent without external network.
- Audit actor fields are populated.
- `/api/system/status` works for owner/admin and no secrets are exposed.

Browser QA:

1. Open `http://127.0.0.1:4310/`.
2. Load Celon demo.
3. Confirm all existing tabs still render.
4. Confirm new/updated views render:
   - Availability checker
   - Billing issue/payment flow
   - Patient Portal resend/disable controls
   - Notifications send dry-run control
   - Audit actor fields
   - System Status tab
   - Patient Login/Patient Dashboard
5. Confirm zero JavaScript console errors.

---

# VERSIONING / README
Bump `/health` from `0.5.0` to `0.6.0`.

Update README current status:

- Phase 2B JWT auth complete.
- Phase 3A clinical workflow/calendar/billing basics complete.
- Phase 3B patient portal foundation, notification queue, billing hardening, audit logs complete.
- Phase 3C security hardening, availability guardrails, dry-run notification provider, and operational status complete.

Update README limitations:

- No real external notification sending yet.
- No payment gateway yet.
- No real file uploads yet.
- No AI assistant yet.
- Activation/password reset tokens now expire and are one-time-use.
- Draft invoices now require issuing before payment.
- Availability uses simplified UTC/server-time handling until timezone settings are added.

---

# FINAL HANDOFF FORMAT
When done, return:

1. Files changed.
2. Tables/types/fields added.
3. Endpoints added/changed.
4. Tests added and exact total count.
5. Exact command outputs:
   - `npm test`
   - `npm run build`
   - `npm run seed`
   - `/health`
   - demo count summary
6. JWT/security smoke summary.
7. Availability/conflict smoke summary.
8. Browser QA summary.
9. Known limitations.

Do not say complete unless every gate above has actually passed.
