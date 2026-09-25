# Cursor Phase 3D Prompt — Offline-First Data Capture + Sync Queue

## ROLE
You are Cursor implementing Phase 3D for Fidean Clinic SaaS in the shared SSH workspace:

```text
/root/fidean_workspaces/fidean-clinic-saas
```

This is a clean-room, Fidean-owned standalone clinic SaaS. Do not copy KiviCare code, UI templates, assets, route names, licensing logic, or database implementation. This phase adds an offline-first capability so clinic staff can keep capturing operational data when internet is unavailable, then sync safely when internet returns.

## WHY THIS PHASE EXISTS
Caleb added a product requirement:

> Users should be able to upload/input clinic data without internet, then sync once internet is available.

This must be treated as a first-class product feature, not a hack. Clinics in Nigeria may have unreliable internet. The app should still allow safe data capture and show clear sync status.

## VERIFIED BASELINE BEFORE THIS PHASE
Phase 3B has been independently QA-verified:

- Fastify + TypeScript + PostgreSQL.
- `/health` returns `0.5.0`.
- Tests: `47 passed`.
- Patient portal, notifications queue, audit logs, billing hardening are complete.

Phase 3C prompt exists and should be implemented first if not already done:

```text
docs/cursor-phase3c-security-availability-production-readiness-prompt.md
```

Phase 3C target is `/health` `0.6.0` and includes:

- token expiry/password reset hardening
- audit actor model
- availability/conflict guardrails
- invoice issue-before-payment
- dry-run notification provider
- system status endpoint

If Phase 3C is not implemented yet, do Phase 3C first. Then implement this Phase 3D on top of it.

## PHASE 3D GOAL
Implement a safe offline-first browser/PWA layer for staff clinic workflows:

1. Staff can capture selected clinic data while offline.
2. Offline records are saved locally in the browser using IndexedDB.
3. A durable sync queue stores pending create/update operations.
4. When internet/API returns, queued operations sync to the server.
5. Sync success/failure/conflict status is visible in the UI.
6. Server sync endpoint accepts idempotent client operations.
7. Conflict handling is explicit and safe.
8. No real binary file uploads yet; document metadata can be queued offline, but actual file storage is still out of scope unless already implemented separately.

## EXPLICITLY OUT OF SCOPE
Do NOT implement these in Phase 3D:

- Native mobile app.
- Real binary file uploads/storage.
- Background OS-level sync outside the browser.
- Service-worker push notifications.
- Real SMS/WhatsApp/email provider sending.
- Paystack or payment gateway.
- AI assistant.
- Full offline multi-user merge engine.
- Offline staff login without a previously cached session.

## OFFLINE-FIRST PRODUCT RULES

### Supported offline actions for Phase 3D
Support offline create operations for:

- Patients
- Appointments
- Encounters / visit notes
- Prescriptions as draft only
- Invoices as draft only
- Patient document metadata only

Optional if simple:

- Branch creation
- Service creation

Do NOT allow offline destructive operations in this phase:

- Delete patient
- Void invoice
- Sign encounter
- Issue prescription
- Record payment
- Disable patient account
- Staff/member changes
- Audit/notification state mutations

Reason: destructive or legal/clinical finalization actions should require server confirmation.

### Online-only actions
These must remain online-only:

- Staff login/register/invite
- Patient account activation/password reset
- Encounter sign
- Prescription issue
- Invoice issue
- Invoice payment
- Notification send/mark-sent/mark-failed/cancel
- Audit log management
- System status

## TECHNICAL APPROACH
Use a browser-first PWA-style implementation:

- Service worker for shell/static asset caching.
- IndexedDB for local offline data and sync queue.
- `navigator.onLine` + failed fetch detection.
- A Sync Status dashboard/indicator.
- Manual `Sync now` button.
- Automatic sync attempt when connection returns.

Do not rely solely on the browser Background Sync API because support varies. Use it if available, but always include the manual/foreground fallback.

## LOCAL STORAGE / INDEXEDDB DESIGN
Create a small local offline module, e.g.:

```text
public/offline-db.js
public/offline-sync.js
public/sw.js
```

Or keep it in `public/app.js` if simpler, but separate files are preferred.

### IndexedDB stores
Use an IndexedDB database like:

```text
fidean-clinic-offline-v1
```

Stores:

```text
offlineRecords
syncQueue
syncMeta
```

Suggested shapes:

```ts
type OfflineEntityType =
  | 'patient'
  | 'appointment'
  | 'encounter'
  | 'prescription'
  | 'invoice'
  | 'patientDocument';

interface OfflineRecord {
  localId: string;
  entityType: OfflineEntityType;
  tenantId: string;
  payload: Record<string, unknown>;
  status: 'draft' | 'queued' | 'syncing' | 'synced' | 'failed' | 'conflict';
  serverId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface SyncQueueItem {
  clientOperationId: string;
  tenantId: string;
  entityType: OfflineEntityType;
  operation: 'create' | 'update';
  localId: string;
  endpoint: string;
  method: 'POST' | 'PATCH';
  payload: Record<string, unknown>;
  status: 'queued' | 'syncing' | 'synced' | 'failed' | 'conflict';
  attempts: number;
  lastAttemptAt?: string;
  serverId?: string;
  error?: string;
  createdAt: string;
}
```

## SERVER SYNC SUPPORT
Add idempotent server support.

### Option A — preferred: generic sync endpoint
Add staff-auth endpoint:

```text
POST /api/sync/operations
```

Body:

```json
{
  "operations": [
    {
      "clientOperationId": "uuid",
      "entityType": "patient",
      "operation": "create",
      "payload": {...},
      "createdAt": "..."
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "results": [
    {
      "clientOperationId": "uuid",
      "status": "synced",
      "serverId": "uuid",
      "entityType": "patient"
    }
  ]
}
```

Failure/conflict example:

```json
{
  "clientOperationId": "uuid",
  "status": "conflict",
  "error": "PATIENT_DUPLICATE_PHONE",
  "message": "A patient with this phone already exists"
}
```

### Option B — acceptable: idempotency headers on existing endpoints
If generic sync endpoint is too large, add support to existing create endpoints using:

```text
Idempotency-Key: <clientOperationId>
```

Still expose enough results for UI to mark queued operations synced/failed/conflict.

## IDEMPOTENCY REQUIREMENT
The same offline operation submitted twice must not create duplicates.

Add a server table:

```sql
CREATE TABLE IF NOT EXISTS sync_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_operation_id text NOT NULL,
  entity_type text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('synced','failed','conflict')),
  server_object_type text,
  server_object_id uuid,
  error text,
  payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, client_operation_id)
);
```

Add repository methods for sync operation tracking.

## CONFLICT RULES
Keep conflict handling simple but explicit:

### Patient create conflicts
Conflict if:

- same tenant + phone already exists, or
- same tenant + patientCode already exists.

Return conflict result; do not overwrite existing patient.

### Appointment create conflicts
Reuse Phase 3C availability/conflict rules:

- doctor unavailable
- doctor appointment conflict
- patient appointment conflict

Return conflict status instead of creating duplicate appointment.

### Encounter/prescription/invoice/document conflicts
For Phase 3D create-only records, conflicts are mostly validation errors or missing dependencies.

If a queued record references a local-only patient/appointment/encounter that has not synced yet:

- sync dependency records first, or
- mark as `failed` with `DEPENDENCY_NOT_SYNCED`.

Preferred: dependency-aware ordering in client sync:

1. patients
2. appointments
3. encounters
4. prescriptions
5. invoices
6. patientDocuments

## SECURITY REQUIREMENTS
Offline data may contain protected patient information. Implement these safeguards:

1. Do not store staff passwords or raw JWT in IndexedDB.
2. Continue existing auth storage pattern only if already used; do not add new secret persistence.
3. Clear offline DB on staff logout only after warning if unsynced data exists.
4. Show visible warning: `This device has unsynced clinic data` when pending items exist.
5. Add `Clear offline data` button with confirmation.
6. Do not cache API JSON responses containing patient data in the service worker.
7. Service worker should cache only app shell/static files.
8. Never cache `/api/*` responses.

## UI REQUIREMENTS
Add a new staff dashboard tab:

```text
Offline Sync
```

It must show:

- Online/offline status.
- Pending sync count.
- Failed/conflict count.
- Last sync time.
- List of queued operations:
  - type
  - created time
  - status
  - error/conflict reason
- Buttons:
  - Sync now
  - Retry failed
  - Clear synced
  - Clear offline data, with confirmation

Update existing forms for supported offline actions:

- When online: submit normally, as today.
- When offline or server unavailable: save to IndexedDB and queue operation.
- Show success message like:

```text
Saved offline. It will sync when internet returns.
```

At minimum, wire offline create behavior for:

- patient form
- appointment form
- encounter form
- prescription draft form
- invoice draft form
- patient document metadata form

## SERVICE WORKER REQUIREMENTS
Add service worker registration.

Service worker should cache only:

- `/`
- `/index.html`
- `/app.js`
- `/style.css`
- offline helper JS files

Do NOT cache:

- `/api/*`
- auth responses
- patient data JSON

Add a simple offline fallback message if app shell is available but API is unreachable.

## TEST REQUIREMENTS
Add tests in e.g.:

```text
tests/offline-sync.test.ts
```

Server-side tests must cover:

1. `POST /api/sync/operations` requires staff auth.
2. Patient JWT cannot use sync endpoint.
3. Sync patient create succeeds and records idempotency.
4. Replaying the same `clientOperationId` returns same server object, no duplicate.
5. Sync patient duplicate phone returns conflict.
6. Sync appointment create succeeds when available.
7. Sync appointment outside schedule returns conflict/`DOCTOR_NOT_AVAILABLE`.
8. Sync appointment overlapping doctor appointment returns conflict/`APPOINTMENT_CONFLICT`.
9. Sync patient double booking returns conflict/`PATIENT_APPOINTMENT_CONFLICT`.
10. Sync dependency missing returns `DEPENDENCY_NOT_SYNCED` or validation failure.
11. Sync endpoint handles partial success: one operation synced, one conflict.
12. Sync operations are tenant-scoped and cross-tenant replay/lookup is forbidden.
13. Service worker file exists and does not cache `/api/*`.
14. Offline helper module includes IndexedDB stores and queue statuses.
15. Demo snapshot includes sync/offline capability flag if added.

All previous tests must still pass.

## BUILD/QA GATES — DO NOT CLAIM DONE UNTIL THESE PASS
Run:

```bash
npm test
npm run build
npm run seed
```

Start/confirm dev server:

```bash
npm run dev
curl -sS http://127.0.0.1:4310/health
```

Expected version after this phase:

```json
{"ok":true,"service":"fidean-clinic-saas","version":"0.7.0"}
```

Live API smoke:

- Register/login staff or load Celon demo.
- Sync create patient via `/api/sync/operations`.
- Replay same operation and prove no duplicate.
- Sync conflicting patient and prove conflict result.
- Sync appointment with schedule available and prove success.
- Sync appointment conflict and prove conflict result.
- Verify patient JWT rejected.

Browser QA:

1. Open `http://127.0.0.1:4310/`.
2. Load Celon demo.
3. Confirm all existing tabs still render.
4. Confirm new `Offline Sync` tab renders.
5. Confirm browser registers service worker with no console errors.
6. Simulate offline/API failure if practical:
   - use DevTools/network offline if available, or
   - temporarily point fetch helper to fail in a controlled way, or
   - use browser JS to monkey-patch `fetch` for one form submission.
7. Submit a patient offline and verify it appears in sync queue.
8. Restore online/fetch and click `Sync now`.
9. Verify queued item becomes synced and server patient appears after refresh.
10. Confirm `/api/*` responses are not cached by service worker.
11. Confirm zero JS console errors.

## VERSIONING / README
Bump `/health` to:

```text
0.7.0
```

Update README current status:

- Phase 3D offline-first data capture and sync queue complete.

Update README limitations:

- Offline support is browser/PWA local IndexedDB, not native mobile yet.
- Offline finalization/destructive actions remain online-only.
- Offline document support is metadata-only until real file uploads/storage are added.
- Service worker caches app shell only, not API patient data.
- Conflict resolution is manual/simple: conflicts are surfaced for staff to resolve.

## FINAL HANDOFF FORMAT
When done, return:

1. Files changed.
2. Tables/types/fields added.
3. Offline architecture summary.
4. Endpoints added/changed.
5. Tests added and exact total count.
6. Exact command outputs:
   - `npm test`
   - `npm run build`
   - `npm run seed`
   - `/health`
7. Live API sync smoke summary.
8. Browser/offline QA summary.
9. Known limitations.

Do not claim complete unless all gates passed.
