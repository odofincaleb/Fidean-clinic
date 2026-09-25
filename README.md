# Fidean Clinic SaaS

Standalone multi-tenant clinic SaaS foundation for Fidean Technologies.

## Current status

- **Phase 2B JWT auth complete.** Register/login/`/me`/invite, bcrypt passwords, Bearer tokens, with header fallback for tests.
- **Phase 3A clinical workflow/calendar/billing basics complete.** Doctor schedules, appointment filters, encounters, prescriptions, invoices, patient document metadata.
- **Phase 3B patient portal foundation, notification queue, billing hardening, audit logs complete.** Separate patient JWT, portal read APIs, queued notifications (no external sending), overpayment rejected with `PAYMENT_EXCEEDS_BALANCE`, audit log read API.
- **Phase 3C security hardening, availability guardrails, dry-run notification provider, and operational status complete.**
- **Phase 3D offline-first data capture and sync queue complete.**

## Limitations

- No real external notification sending yet (dry-run provider only).
- No payment gateway yet.
- No real file uploads yet.
- No AI assistant yet.
- Activation/password reset tokens now expire and are one-time-use.
- Draft invoices now require issuing before payment.
- Availability uses simplified UTC/server-time handling until timezone settings are added.
- Patient accounts remain unique per `(tenantId, email)` and `(tenantId, patientId)`.
- Offline support is browser/PWA local IndexedDB, not native mobile yet.
- Offline finalization/destructive actions remain online-only.
- Offline document support is metadata-only until real file uploads/storage are added.
- Service worker caches app shell only, not API patient data.
- Conflict resolution is manual/simple: conflicts are surfaced for staff to resolve.

## Run locally

```bash
npm install
npm test
npm run build
npm run seed
npm run dev
```

Open `http://127.0.0.1:4310/`.

## Clean-room rule

KiviCare was used only for market/workflow research. Do not copy KiviCare Pro/add-on source code, templates, assets, identifiers or licensing logic.
