# Cursor Phase 3A Prompt — Clinical Workflow + Calendar + Billing Basics

## ROLE
You are Cursor implementing Phase 3A for Fidean Clinic SaaS in the shared SSH workspace:

```text
/root/fidean_workspaces/fidean-clinic-saas
```

Build the next KiviCare-parity foundation features using a clean-room implementation owned by Fidean Technologies. Do NOT copy KiviCare source, identifiers, templates, assets, licensing logic, or proprietary workflows. Implement our own SaaS-native clinical workflow for Nigerian multi-branch clinics.

## CURRENT VERIFIED BASELINE
The current app is Fastify + TypeScript + PostgreSQL + simple HTML/JS dashboard.

Verified baseline before this prompt:

- `npm test` passes: 21/21 tests.
- `npm run build` passes.
- `npm run seed` seeds Celon Dental demo into PostgreSQL.
- `/health` returns version `0.3.0`.
- JWT auth exists:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - `POST /api/tenants/:tenantId/invite`
- Auth fallback still supports `x-tenant-id` / `x-member-id` for legacy tests.
- Current domain objects: Tenant, Branch, Member, Patient, Service, Appointment.
- Current dashboard tabs: Overview, Branches, Patients, Appointments, Staff, Services.

## APPROVED SCOPE — PHASE 3A ONLY
Build minimum KiviCare-parity essentials needed for a real Celon pilot:

1. Doctor schedules + availability windows.
2. Appointment calendar/list filtering with branch/doctor/date range.
3. Clinical encounters/visits.
4. Encounter clinical notes.
5. Prescriptions attached to encounters.
6. Patient documents/reports metadata.
7. Billing/invoice basics attached to appointments/encounters.
8. Dashboard tabs/UI for the new modules.
9. PostgreSQL schema + memory repository parity.
10. Tests + smoke verification.

## EXPLICITLY OUT OF SCOPE FOR PHASE 3A
Do NOT build these yet:

- Payment gateway integration.
- Paystack/KnitPay/WooCommerce/Stripe flows.
- Telemedicine/Zoom/Google Meet.
- SMS/WhatsApp/email sending automation.
- AI clinical assistant features.
- Mobile app.
- WordPress connector/plugin.
- Production deployment.
- Real file uploads to object storage.

For documents in this phase, store metadata only: title/type/fileUrl/notes. No upload implementation yet.

## CLEAN-ROOM RULE
KiviCare may be treated only as a feature reference. Do not copy:

- KiviCare PHP/JS/React/Vue source.
- KiviCare database table names.
- KiviCare class/component names.
- KiviCare route names.
- KiviCare UI templates/assets/icons.
- KiviCare licensing/payment logic.

Use Fidean naming and Fidean-owned APIs.

---

# STEP 1 — DISCOVERY BEFORE EDITING
Before changing code, inspect these files and report any mismatches in your final handoff:

```bash
pwd
git status --short
sed -n '1,220p' src/domain/types.ts
sed -n '1,220p' src/repositories/ClinicRepository.ts
sed -n '1,340p' src/server.ts
sed -n '1,260p' src/repositories/MemoryClinicRepository.ts
sed -n '1,320p' src/repositories/PostgresClinicRepository.ts
sed -n '1,220p' docs/schema.sql
sed -n '1,260p' public/index.html
sed -n '1,320p' public/app.js
```

Do not proceed blindly if the workspace differs materially from the verified baseline.

---

# REQUIRED DATA MODEL

## 1. Doctor schedules
Add a `DoctorSchedule` domain type:

```ts
export interface DoctorSchedule {
  id: string;
  tenantId: string;
  branchId: string;
  doctorMemberId: string;
  weekday: number; // 0 Sunday ... 6 Saturday
  startsAt: string; // HH:mm
  endsAt: string;   // HH:mm
  slotMinutes: number;
  active: boolean;
  createdAt: string;
}
```

Rules:

- Doctor must be a member in the same tenant.
- Branch must belong to the same tenant.
- `startsAt < endsAt`.
- `slotMinutes` default 30, min 5.
- Branch managers can only create/update schedules for assigned branches.
- Owners/admins can manage all schedules.

## 2. Encounters / visits
Add an `Encounter` type:

```ts
export interface Encounter {
  id: string;
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  doctorMemberId?: string;
  status: 'open' | 'signed' | 'cancelled';
  reason?: string;
  diagnosis?: string;
  clinicalNotes?: string;
  vitals?: {
    bloodPressure?: string;
    temperatureC?: number;
    weightKg?: number;
    pulseBpm?: number;
  };
  startedAt: string;
  signedAt?: string;
  createdAt: string;
}
```

Rules:

- Appointment link is optional because walk-ins should be possible later.
- If appointmentId is provided, it must belong to same tenant + branch + patient.
- Only users with `write_encounter` can create/update/sign encounters.
- `signed` encounters should become read-only except owner/admin can reopen later (reopen can be out of scope if time is tight, but do not allow normal editing of signed encounters).

## 3. Prescriptions
Add `Prescription` and `PrescriptionItem` types:

```ts
export interface PrescriptionItem {
  medication: string;
  dosage?: string;
  frequency?: string;
  duration?: string;
  instructions?: string;
}

export interface Prescription {
  id: string;
  tenantId: string;
  encounterId: string;
  patientId: string;
  doctorMemberId?: string;
  items: PrescriptionItem[];
  notes?: string;
  status: 'draft' | 'issued' | 'cancelled';
  issuedAt?: string;
  createdAt: string;
}
```

Rules:

- Prescription must belong to an encounter in same tenant.
- `items` must contain at least one medication.
- Doctor/nurse/admin/owner can create draft prescriptions depending on RBAC; issuing should require `write_encounter`.
- Patient sees only their own prescriptions later; patient portal is out of scope now.

## 4. Billing / invoices
Add `Invoice` and `InvoiceLine` types:

```ts
export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceKobo: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string;
  encounterId?: string;
  invoiceNumber: string;
  lines: InvoiceLine[];
  subtotalKobo: number;
  discountKobo: number;
  taxKobo: number;
  totalKobo: number;
  amountPaidKobo: number;
  currency: 'NGN' | 'USD';
  status: 'draft' | 'issued' | 'part_paid' | 'paid' | 'void';
  issuedAt?: string;
  createdAt: string;
}
```

Rules:

- `totalKobo = subtotalKobo - discountKobo + taxKobo`.
- subtotal must be computed from lines: sum(quantity * unitPriceKobo).
- `amountPaidKobo` default 0.
- Status derivation:
  - draft: not issued.
  - issued: issued, amountPaid = 0.
  - part_paid: amountPaid > 0 and < total.
  - paid: amountPaid >= total.
  - void: manually voided.
- No payment gateway in this phase. Manual payment recording only is OK.
- Roles:
  - owner/admin/accountant can manage billing.
  - doctor/receptionist can view billing if permission allows; do not let them void/pay invoices unless RBAC permits.

## 5. Patient documents/reports metadata
Add `PatientDocument` type:

```ts
export interface PatientDocument {
  id: string;
  tenantId: string;
  patientId: string;
  encounterId?: string;
  title: string;
  documentType: 'report' | 'scan' | 'lab' | 'consent' | 'other';
  fileUrl?: string;
  notes?: string;
  createdAt: string;
}
```

Rules:

- Metadata only. No binary upload in this phase.
- Must belong to tenant + patient.
- If encounterId present, same tenant/patient.

## 6. TenantSnapshot expansion
Extend `TenantSnapshot` to include:

```ts
doctorSchedules: DoctorSchedule[];
encounters: Encounter[];
prescriptions: Prescription[];
invoices: Invoice[];
patientDocuments: PatientDocument[];
```

Keep existing fields unchanged for backwards compatibility.

---

# REQUIRED POSTGRESQL SCHEMA
Update `docs/schema.sql` idempotently. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.

Add tables equivalent to:

- `doctor_schedules`
- `encounters`
- `prescriptions`
- `invoices`
- `patient_documents`

Avoid KiviCare table names. Use Fidean naming above.

Required constraints:

- Foreign keys to tenants/branches/patients/appointments/members as appropriate.
- JSONB for vitals, prescription items, invoice lines.
- Indexes:
  - doctor schedules by tenant/branch/doctor.
  - encounters by tenant/patient and tenant/branch.
  - prescriptions by tenant/patient and encounter.
  - invoices by tenant/patient/status and invoice_number unique per tenant.
  - documents by tenant/patient.

Add enum types only if needed; text + CHECK constraints are fine if easier for idempotent migrations.

---

# REQUIRED REPOSITORY METHODS
Update `ClinicRepository` and implement both `MemoryClinicRepository` and `PostgresClinicRepository`.

Add methods:

```ts
listDoctorSchedules(tenantId: string, filters?: { branchId?: string; doctorMemberId?: string }): Promise<DoctorSchedule[]>;
createDoctorSchedule(input: DoctorScheduleInput): Promise<DoctorSchedule>;
updateDoctorSchedule(scheduleId: string, patch: Partial<Pick<DoctorSchedule, 'startsAt' | 'endsAt' | 'slotMinutes' | 'active'>>): Promise<DoctorSchedule>;

listEncounters(tenantId: string, filters?: { patientId?: string; branchId?: string; appointmentId?: string }): Promise<Encounter[]>;
getEncounter(encounterId: string): Promise<Encounter | undefined>;
createEncounter(input: EncounterInput): Promise<Encounter>;
updateEncounter(encounterId: string, patch: EncounterPatch): Promise<Encounter>;
signEncounter(encounterId: string): Promise<Encounter>;

listPrescriptions(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<Prescription[]>;
createPrescription(input: PrescriptionInput): Promise<Prescription>;
updatePrescription(prescriptionId: string, patch: PrescriptionPatch): Promise<Prescription>;
issuePrescription(prescriptionId: string): Promise<Prescription>;

listInvoices(tenantId: string, filters?: { patientId?: string; status?: Invoice['status'] }): Promise<Invoice[]>;
createInvoice(input: InvoiceInput): Promise<Invoice>;
updateInvoice(invoiceId: string, patch: InvoicePatch): Promise<Invoice>;
recordInvoicePayment(invoiceId: string, amountKobo: number): Promise<Invoice>;
voidInvoice(invoiceId: string): Promise<Invoice>;

listPatientDocuments(tenantId: string, filters?: { patientId?: string; encounterId?: string }): Promise<PatientDocument[]>;
createPatientDocument(input: PatientDocumentInput): Promise<PatientDocument>;
```

If you choose slightly different input type names, keep the domain shape stable and update tests.

---

# REQUIRED API ROUTES
Add routes in `src/server.ts` or split into route files if cleaner. Keep auth/RBAC consistent with current system.

## Doctor schedules

```text
GET  /api/doctor-schedules?branchId=&doctorMemberId=
POST /api/doctor-schedules
PATCH /api/doctor-schedules/:scheduleId
```

Body for create:

```json
{
  "tenantId": "...",
  "branchId": "...",
  "doctorMemberId": "...",
  "weekday": 1,
  "startsAt": "09:00",
  "endsAt": "17:00",
  "slotMinutes": 30
}
```

## Appointment calendar filters
Extend existing:

```text
GET /api/appointments?branchId=&doctorMemberId=&from=&to=&status=
```

Must still return unfiltered list when no filters are supplied.

## Encounters

```text
GET  /api/encounters?patientId=&branchId=&appointmentId=
POST /api/encounters
PATCH /api/encounters/:encounterId
POST /api/encounters/:encounterId/sign
```

Create body:

```json
{
  "tenantId": "...",
  "branchId": "...",
  "patientId": "...",
  "appointmentId": "optional",
  "doctorMemberId": "optional",
  "reason": "Tooth pain",
  "diagnosis": "Caries",
  "clinicalNotes": "...",
  "vitals": { "bloodPressure": "120/80", "temperatureC": 36.8 }
}
```

## Prescriptions

```text
GET  /api/prescriptions?patientId=&encounterId=
POST /api/prescriptions
PATCH /api/prescriptions/:prescriptionId
POST /api/prescriptions/:prescriptionId/issue
```

## Invoices

```text
GET  /api/invoices?patientId=&status=
POST /api/invoices
PATCH /api/invoices/:invoiceId
POST /api/invoices/:invoiceId/payment
POST /api/invoices/:invoiceId/void
```

Payment body:

```json
{ "amountKobo": 500000 }
```

## Patient documents

```text
GET  /api/patient-documents?patientId=&encounterId=
POST /api/patient-documents
```

---

# RBAC REQUIREMENTS
Update `src/auth/rbac.ts` if needed.

Use existing roles, do not add new roles in this phase.

Expected permissions:

- owner/admin:
  - all Phase 3A actions.
- branch_manager:
  - manage schedules/appointments/encounters only for assigned branches.
  - view billing for assigned branches; do not void unless you explicitly decide it is safe.
- doctor:
  - view patients/appointments for assigned branches.
  - create/update/sign encounters.
  - create/issue prescriptions.
  - view invoice summary but not record payment/void.
- nurse:
  - view patients.
  - create/update encounter vitals/notes if assigned branch permits.
  - cannot issue prescriptions unless you explicitly allow; safe default: cannot issue.
- receptionist:
  - create appointments.
  - view patients.
  - create basic invoice draft if needed, but cannot record payment/void; safe default: no billing mutation.
- accountant:
  - view/manage billing.
  - cannot write clinical encounters.
- viewer:
  - read-only reports only.

Existing `requireAuth` must continue to support Bearer JWT first, then old header fallback.

---

# UI REQUIREMENTS
Update `public/index.html`, `public/app.js`, and `public/style.css`.

Add dashboard tabs:

1. Calendar
2. Encounters
3. Prescriptions
4. Billing
5. Documents
6. Schedules

Keep existing tabs too. The UI can remain simple, but it must be usable and verified.

Minimum UI behaviors:

## Calendar
- Show appointments with branch, patient, service, status, startsAt.
- Filters: branch, doctor, status, from/to date.

## Schedules
- Form to create doctor schedule.
- Select branch and doctor.
- Weekday dropdown, start/end time, slot minutes.
- List existing schedules.

## Encounters
- Form to create encounter for patient/branch/appointment.
- Fields: reason, diagnosis, clinical notes, vitals basic fields.
- Button or action to sign encounter.
- List encounters with status.

## Prescriptions
- Form to create prescription linked to encounter.
- Accept at least one medication item.
- Include dosage/frequency/duration/instructions.
- Button/action to issue prescription.

## Billing
- Form to create invoice for patient/branch and optional appointment/encounter.
- At minimum one line item: description, quantity, unit price kobo.
- Show subtotal/total/status.
- Button/action to record manual payment.

## Documents
- Form to add patient document metadata.
- Fields: patient, encounter optional, title, document type, file URL optional, notes.
- List documents.

Dashboard stats should include counts for encounters, prescriptions, invoices, documents, schedules.

After login/register/demo, UI should render the expanded snapshot.

---

# DEMO/SEED REQUIREMENTS
Update `seedCelonDemo()` and `npm run seed` so Celon demo includes:

- 2 branches.
- Owner and doctor, as already present.
- At least one doctor schedule for each branch.
- 1 demo patient.
- 1 appointment.
- 1 encounter linked to the appointment.
- 1 prescription linked to the encounter.
- 1 invoice linked to the appointment/encounter.
- 1 patient document metadata record.

`POST /api/demo/celon` must still work without auth and return a JWT as currently implemented.

---

# TEST REQUIREMENTS
Add tests in a new `tests/clinical-workflow.test.ts` or extend existing tests cleanly.

Required tests:

1. Doctor schedule can be created and filtered by branch/doctor.
2. Invalid doctor schedule rejects bad time range.
3. Appointment list can filter by branch/status/date range.
4. Encounter can be created for tenant-wide patient + branch appointment.
5. Signed encounter cannot be edited normally.
6. Prescription requires at least one medication item.
7. Prescription can be issued.
8. Invoice totals are computed correctly.
9. Manual invoice payment changes status to part_paid/paid correctly.
10. Cross-tenant access to encounter/invoice/document is denied.
11. Branch manager cannot write another branch's schedule/encounter.
12. Celon demo snapshot includes all new arrays and expected counts.

All previous 21 tests must still pass.

---

# BUILD/QA GATES — DO NOT CLAIM DONE UNTIL THESE PASS
Run these exact commands:

```bash
npm test
npm run build
npm run seed
```

Then start the dev server if not already running:

```bash
npm run dev
```

Smoke with curl:

```bash
curl -sS http://127.0.0.1:4310/health
curl -sS -X POST http://127.0.0.1:4310/api/demo/celon -H 'Content-Type: application/json' -d '{}'
```

Then verify with a JWT:

```bash
# Register a QA clinic
curl -sS -X POST http://127.0.0.1:4310/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Phase 3A QA Clinic","slug":"phase-3a-qa","email":"phase3a@example.com","password":"Passw0rd123","displayName":"Phase 3A Owner"}'

# Use the returned token to create:
# - a branch
# - patient
# - appointment
# - doctor schedule
# - encounter
# - prescription
# - invoice
# - patient document
```

Browser QA:

1. Open `http://127.0.0.1:4310/`.
2. Register or load demo.
3. Confirm all old tabs still render.
4. Confirm new tabs render:
   - Calendar
   - Schedules
   - Encounters
   - Prescriptions
   - Billing
   - Documents
5. Confirm zero JavaScript console errors.
6. Confirm demo shows Celon snapshot counts for the new modules.

---

# VERSIONING
Bump `/health` version from `0.3.0` to `0.4.0`.

Update `README.md` Current Status to say:

- Phase 2B JWT auth complete.
- Phase 3A clinical workflow/calendar/billing basics complete when done.

---

# FINAL HANDOFF FORMAT
When complete, return a concise handoff with:

1. Files changed.
2. Data model/tables added.
3. Endpoints added.
4. Tests added and exact count.
5. Exact command outputs for:
   - `npm test`
   - `npm run build`
   - `npm run seed`
   - `/health`
   - demo endpoint count summary
6. Browser QA result.
7. Any known limitations/out-of-scope items.

Do not say “done” unless every gate above is actually run and passing.
