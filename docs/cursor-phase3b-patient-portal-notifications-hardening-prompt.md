# Cursor Phase 3B Prompt — Patient Portal Foundation + Notifications Queue + Billing Hardening

## ROLE
You are Cursor implementing Phase 3B for Fidean Clinic SaaS in the shared SSH workspace:

```text
/root/fidean_workspaces/fidean-clinic-saas
```

Build on the verified Phase 3A clinical workflow foundation. This is a clean-room Fidean-owned SaaS implementation. Do NOT copy KiviCare source, identifiers, UI templates, database table names, assets, or licensing/payment logic.

## VERIFIED BASELINE BEFORE THIS PHASE
The current workspace has been QA-verified by Devin:

- Fastify + TypeScript + PostgreSQL.
- JWT auth + bcrypt is complete.
- `/health` returns version `0.4.0`.
- Tests pass: `33 passed`.
- Build passes: `npm run build` / `tsc --noEmit`.
- Seed passes with Celon Dental demo:
  - branches: 2
  - doctorSchedules: 2
  - appointments: 1
  - encounters: 1
  - prescriptions: 1
  - invoices: 1
  - patientDocuments: 1
- Dashboard has old tabs plus:
  - Calendar
  - Schedules
  - Encounters
  - Prescriptions
  - Billing
  - Documents
- Live API smoke verified all Phase 3A endpoints.

Known hardening issue found during QA:

- Manual invoice payment currently allows overpayment. Example: total was `1,950,000` kobo but amountPaid became `2,450,000`. Fix this in Phase 3B.

## PHASE 3B GOAL
Add the next clinic-product layer needed for a real pilot:

1. Billing hardening.
2. Patient portal account foundation.
3. Patient-side dashboard/API for appointments, prescriptions, invoices, documents.
4. Notification queue foundation for email/SMS/WhatsApp reminders, but no real external sending yet.
5. Audit log usage for sensitive actions.
6. UI tabs/pages to verify everything.
7. Tests, build, seed, API smoke, browser QA.

This phase should improve real-world readiness while avoiding risky integrations.

## EXPLICITLY OUT OF SCOPE
Do NOT build these in Phase 3B:

- Paystack, Stripe, WooCommerce, KnitPay, or any live payment gateway.
- Real SMS/WhatsApp/email API sending.
- AI clinical assistant.
- Telemedicine/Zoom/Google Meet.
- Mobile app.
- WordPress connector/plugin.
- Production deployment.
- Real file uploads/storage.

For notifications, implement a durable queue/table only. Sending providers come later.

---

# STEP 1 — DISCOVERY BEFORE EDITING
Run and inspect:

```bash
pwd
git status --short
sed -n '1,220p' src/domain/types.ts
sed -n '1,260p' src/domain/clinical.ts
sed -n '1,260p' src/repositories/ClinicRepository.ts
sed -n '1,360p' src/repositories/MemoryClinicRepository.ts
sed -n '1,420p' src/repositories/PostgresClinicRepository.ts
sed -n '1,340p' src/routes/clinical.ts
sed -n '1,340p' src/routes/auth.ts
sed -n '1,360p' src/server.ts
sed -n '1,260p' docs/schema.sql
sed -n '1,280p' public/index.html
sed -n '1,460p' public/app.js
sed -n '1,260p' public/style.css
```

Do not proceed if the workspace differs materially from the verified baseline.

---

# REQUIRED FEATURE 1 — BILLING HARDENING

## Fix overpayment
Update invoice payment logic so manual payments cannot push `amountPaidKobo` above `totalKobo`.

Preferred rule:

- If `amountKobo > outstandingBalanceKobo`, reject with:

```text
PAYMENT_EXCEEDS_BALANCE
HTTP 409
```

Alternative acceptable only if clearly documented:

- Clamp payment to outstanding balance and return `overpaymentKobo` separately.

Use the preferred reject rule unless there is a strong reason not to.

## Add balance fields to invoice responses
Every invoice returned from API/repository should include or be easily computable in returned JSON:

```ts
balanceKobo = Math.max(totalKobo - amountPaidKobo, 0)
```

You may add `balanceKobo` to the `Invoice` interface if clean, or calculate it in route responses. Prefer adding to interface/output for UI consistency.

## Invoice status rules
Ensure status transitions are correct:

- draft: no issuedAt and no payment.
- issued: issuedAt exists and amountPaid = 0.
- part_paid: 0 < amountPaid < total.
- paid: amountPaid === total.
- void: manual void; payment should be rejected after void.

Reject:

- payment on `void` invoice: `INVOICE_VOID`, HTTP 409.
- payment on `draft` invoice if your current model treats draft as not payable. Safer default: allow payment only after issue. If this is too disruptive to current code, document behavior and add tests.
- voiding paid invoice unless owner/admin/accountant explicitly allowed. Safe default: allow owner/admin/accountant to void, but preserve amountPaid for audit.

---

# REQUIRED FEATURE 2 — PATIENT PORTAL FOUNDATION

Add patient-side account access. This is not the full public portal design yet; it is the auth/API foundation plus simple UI proof.

## Data model
Add a `PatientAccount` type:

```ts
export interface PatientAccount {
  id: string;
  tenantId: string;
  patientId: string;
  email: string;
  passwordHash: string;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  lastLoginAt?: string;
}
```

Important:

- Patient accounts are separate from staff `users` and `tenant_memberships`.
- A patient account must link to exactly one tenant + patient.
- Email should be unique per tenant, not globally, unless simpler to implement globally. Prefer unique `(tenant_id, email)`.

## Patient JWT
Add a separate patient JWT context.

- Staff JWT must not authenticate as patient.
- Patient JWT must not authenticate as staff.
- Use a claim like:

```json
{ "type": "patient", "patientAccountId": "...", "tenantId": "...", "patientId": "...", "email": "..." }
```

Staff token can keep current shape. Make the distinction explicit in code.

## Patient auth endpoints
Add:

```text
POST /api/patient-auth/invite
POST /api/patient-auth/activate
POST /api/patient-auth/login
GET  /api/patient-auth/me
```

### POST /api/patient-auth/invite
Staff-only endpoint.

Body:

```json
{
  "tenantId": "...",
  "patientId": "...",
  "email": "patient@example.com"
}
```

Rules:

- Requires staff auth.
- owner/admin/receptionist/doctor can invite if they can view the patient and branch rules permit.
- Creates `PatientAccount` with `status: invited`.
- Generates an activation token or deterministic dev activation code for now.
- Do not send email yet. Return dev-safe activation token in response only for local/dev.
- Add a notification queue record of type `patient_portal_invite`.

### POST /api/patient-auth/activate
Public endpoint.

Body:

```json
{
  "token": "...",
  "password": "Passw0rd123"
}
```

Rules:

- Validates token.
- Hashes password.
- Sets status `active`.
- Returns patient JWT.

If implementing expiring activation tokens is too much for this phase, store a hashed token/code in DB and document no expiry yet. Prefer adding expiry if straightforward.

### POST /api/patient-auth/login
Public endpoint.

Body:

```json
{
  "tenantSlug": "celon-dental-...",
  "email": "patient@example.com",
  "password": "Passw0rd123"
}
```

Returns patient JWT and patient profile.

Errors:

- `INVALID_CREDENTIALS` HTTP 401.
- `PATIENT_ACCOUNT_INACTIVE` HTTP 403.

### GET /api/patient-auth/me
Patient JWT required.

Returns:

```json
{
  "ok": true,
  "account": {...},
  "tenant": {...},
  "patient": {...}
}
```

---

# REQUIRED FEATURE 3 — PATIENT PORTAL READ APIs

Add patient-scoped routes:

```text
GET /api/patient-portal/summary
GET /api/patient-portal/appointments
GET /api/patient-portal/prescriptions
GET /api/patient-portal/invoices
GET /api/patient-portal/documents
```

All require patient JWT and must only return records for that patient.

## Summary response
Return counts and recent items:

```json
{
  "ok": true,
  "tenant": {...},
  "patient": {...},
  "counts": {
    "appointments": 1,
    "prescriptions": 1,
    "invoices": 1,
    "documents": 1
  },
  "upcomingAppointments": [...],
  "recentPrescriptions": [...],
  "openInvoices": [...],
  "documents": [...]
}
```

Security requirement:

- A patient must never see another patient’s data, even if they guess IDs.
- Do not accept `patientId` query params for patient portal routes. Use token context.

---

# REQUIRED FEATURE 4 — NOTIFICATION QUEUE FOUNDATION

Add notification queue data model:

```ts
export interface NotificationJob {
  id: string;
  tenantId: string;
  patientId?: string;
  memberId?: string;
  channel: 'email' | 'sms' | 'whatsapp';
  type:
    | 'patient_portal_invite'
    | 'appointment_created'
    | 'appointment_reminder'
    | 'prescription_issued'
    | 'invoice_issued'
    | 'invoice_payment_received';
  recipient: string;
  subject?: string;
  body: string;
  status: 'queued' | 'sent' | 'failed' | 'cancelled';
  scheduledFor?: string;
  sentAt?: string;
  error?: string;
  createdAt: string;
}
```

Add table `notification_jobs`.

Add repository methods:

```ts
listNotificationJobs(tenantId: string, filters?: { status?: NotificationJob['status']; type?: NotificationJob['type'] }): Promise<NotificationJob[]>;
queueNotification(input: NotificationJobInput): Promise<NotificationJob>;
markNotificationSent(jobId: string): Promise<NotificationJob>;
markNotificationFailed(jobId: string, error: string): Promise<NotificationJob>;
cancelNotification(jobId: string): Promise<NotificationJob>;
```

Add staff-only routes:

```text
GET  /api/notifications?status=&type=
POST /api/notifications
POST /api/notifications/:jobId/mark-sent
POST /api/notifications/:jobId/mark-failed
POST /api/notifications/:jobId/cancel
```

Rules:

- owner/admin can manage all notifications.
- receptionist can queue appointment/patient invite notifications.
- accountant can queue invoice notifications.
- No actual external sending in this phase.

Automatically queue notification jobs when:

- Patient portal invite created.
- Appointment created.
- Prescription issued.
- Invoice issued/payment recorded.

If too much, at minimum auto-queue patient invite + prescription issued + invoice payment received, and document the rest.

---

# REQUIRED FEATURE 5 — AUDIT LOG USAGE

The schema already has `audit_logs`; make it actually useful.

Add repository method:

```ts
recordAuditLog(input: {
  tenantId: string;
  actorUserId?: string;
  action: string;
  objectType?: string;
  objectId?: string;
  details?: unknown;
}): Promise<void>;
```

Add route:

```text
GET /api/audit-logs?objectType=&objectId=&action=
```

Rules:

- owner/admin only.
- Record audit logs for:
  - patient account invite.
  - patient account activation.
  - encounter sign.
  - prescription issue.
  - invoice create.
  - invoice payment.
  - invoice void.
  - notification state changes.

No need for a complex audit UI; add basic dashboard display if time allows.

---

# REQUIRED UI

Update `public/index.html`, `public/app.js`, and `public/style.css`.

## Staff dashboard additions
Add tabs or sections:

1. Patient Portal
2. Notifications
3. Audit Logs

### Patient Portal tab
- Select a patient.
- Enter email.
- Button: invite patient.
- Show activation token/code returned in dev mode.
- Show existing patient accounts.

### Notifications tab
- List queued/sent/failed/cancelled notification jobs.
- Filter by status/type if simple.
- Form to queue a manual notification.
- Buttons to mark sent/failed/cancelled if simple.

### Audit Logs tab
- Show recent audit logs.
- Filter by object type/action if simple.

## Patient portal UI proof
Keep it simple in the same app shell:

- Add a separate patient login panel or toggle.
- Fields: tenant slug, email, password.
- On patient login, show Patient Portal view:
  - profile summary
  - appointments
  - prescriptions
  - invoices with balances/status
  - documents

This can be basic HTML/JS, not a polished production portal.

---

# DEMO/SEED REQUIREMENTS
Update Celon seed/demo so it includes:

- Existing Phase 3A demo records.
- A patient account for the demo patient, either active or invited.
- At least 3 notification jobs:
  - patient_portal_invite
  - prescription_issued
  - invoice_issued or invoice_payment_received
- At least 3 audit log rows.

`POST /api/demo/celon` must still return staff JWT and snapshot. If you include patient activation/login demo data, return it under a clearly dev-only key like:

```json
{
  "devPatientLogin": {
    "tenantSlug": "...",
    "email": "demo.patient@example.com",
    "password": "Passw0rd123"
  }
}
```

Do not expose real secrets.

---

# TEST REQUIREMENTS
Add tests in `tests/patient-portal-notifications.test.ts` or equivalent.

Required tests:

1. Invoice payment exceeding balance is rejected with `PAYMENT_EXCEEDS_BALANCE`.
2. Payment on void invoice is rejected.
3. Patient account invite creates account + notification job + audit log.
4. Patient activation hashes password and returns patient JWT.
5. Patient login works after activation.
6. Patient `/me` rejects staff JWT.
7. Staff endpoints reject patient JWT.
8. Patient portal summary returns only that patient’s records.
9. Patient cannot access another patient’s records by query/id guessing.
10. Prescription issue queues notification job.
11. Invoice payment queues notification job.
12. Notification job lifecycle mark-sent/mark-failed/cancel works with RBAC.
13. Audit logs route is owner/admin only.
14. Celon demo includes patient account + notification jobs + audit logs.

All previous 33 tests must still pass.

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
{"ok":true,"service":"fidean-clinic-saas","version":"0.5.0"}
```

Smoke with curl:

```bash
curl -sS -X POST http://127.0.0.1:4310/api/demo/celon \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Verify counts include:

- patientAccounts >= 1
- notificationJobs >= 3
- auditLogs >= 3

JWT smoke must prove:

- Staff can invite patient.
- Patient can activate/login.
- Patient portal summary returns patient-only data.
- Overpayment is rejected.
- Notification queue lifecycle works.
- Audit logs are readable by owner/admin and forbidden to lower roles.

Browser QA:

1. Open `http://127.0.0.1:4310/`.
2. Load Celon demo or register/login.
3. Confirm all old tabs still render.
4. Confirm Phase 3A tabs still render.
5. Confirm new Phase 3B tabs/views render:
   - Patient Portal
   - Notifications
   - Audit Logs
   - Patient Login/Patient Dashboard
6. Confirm zero JavaScript console errors.
7. Confirm invoice balance/status displays correctly.

---

# VERSIONING / README
Bump `/health` from `0.4.0` to `0.5.0`.

Update README current status:

- Phase 2B JWT auth complete.
- Phase 3A clinical workflow/calendar/billing basics complete.
- Phase 3B patient portal foundation, notification queue, billing hardening, audit logs complete.

---

# FINAL HANDOFF FORMAT
When done, return:

1. Files changed.
2. Tables/types added.
3. Endpoints added.
4. Tests added and exact total count.
5. Exact command outputs:
   - `npm test`
   - `npm run build`
   - `npm run seed`
   - `/health`
   - demo count summary
6. JWT smoke summary.
7. Browser QA summary.
8. Known limitations.

Do not say complete unless every gate above has actually passed.
