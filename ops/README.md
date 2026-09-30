# Ops scripts — Fidean Clinic SaaS

Runbook for keeping production (169.58.111.70:4310) up.

## `clinic-saas-deploy.sh` — safe deploy (USE THIS, not `pm2 restart`)

    bash ops/clinic-saas-deploy.sh                  # preflight + deploy
    CHECK_ONLY=1 bash ops/clinic-saas-deploy.sh     # check only, no restart

Refuses to restart if:
- the ecosystem config's entry file does not exist (the fault class that caused
  the 2026-09-30 outage — config pointed at `dist/server.js` which the
  `tsc --noEmit` build never produces)
- esbuild finds syntax/import errors in `src/server.ts`

Then restarts and polls `/health` for up to 40s, printing logs + a rollback
command if it fails.

## `clinic-saas-watchdog.sh` — health watchdog

Runs every 2 minutes via Hermes cron (job: "Clinic SaaS (4310) health watchdog").
Checks: PM2 online, `/health` ok, port bound to 0.0.0.0, Postgres reachable.
Silent when healthy. On failure: auto-restarts and reports once per incident
(30-min cooldown).

    bash ops/clinic-saas-watchdog.sh                     # normal run
    WATCHDOG_DRY_RUN=1 bash ops/clinic-saas-watchdog.sh  # detect only, no action

Log: `/root/.fidean-clinic-watchdog.log`

## Known failure modes this covers

| Failure | Covered by |
|---|---|
| PM2 config points at non-existent build output | deploy guard |
| TypeScript syntax error (e.g. duplicate symbol) | deploy guard |
| App crash-loop / process died | watchdog auto-restart |
| Wrong host binding (127.0.0.1 vs 0.0.0.0) | watchdog port check |
| Postgres down | watchdog systemctl restart |
| Postgres gone AND app down | both |
