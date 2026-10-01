# Ops — Fidean Clinic SaaS

Runbook for keeping production (`169.58.111.70:4310`) up and recoverable.

## Protection layers

| # | Layer | Where it runs | Frequency | What it does |
|---|---|---|---|---|
| 0 | Config correctness | host | — | PM2 runs `tsx src/server.ts`; `HOST=0.0.0.0` |
| 1 | **Safe-deploy guard** | host (manual) | per deploy | Refuses to deploy anything that cannot start |
| 2 | **On-host watchdog** | host (cron) | every 2 min | 4 checks; auto-restarts; alerts once per incident |
| 3 | **Daily backups** | host (cron) | 02:30 daily | pg_dump + verify + off-host copy |
| 4 | **External uptime check** | GitHub Actions | every 15 min | Covers total host failure (alert only) |
| 5 | Reboot survival | host | on boot | `pm2 save` + systemd `pm2-root` |

Why two uptime layers: the on-host watchdog (2) is fast and **self-healing**, but
dies with the host. The external check (4) cannot heal anything but **still
alerts when the whole box is gone**.

---

## `clinic-saas-deploy.sh` — safe deploy (USE THIS, not `pm2 restart`)

```bash
bash ops/clinic-saas-deploy.sh                  # preflight + deploy
CHECK_ONLY=1 bash ops/clinic-saas-deploy.sh     # check only, no restart
```

Refuses to restart when:
- the ecosystem config's entry file does not exist (the fault class that caused
  the 2026-09-30 outage — config pointed at `dist/server.js`, which
  `tsc --noEmit` never produces)
- esbuild finds syntax/import errors in `src/server.ts`

Then restarts and polls `/health` for up to 40s, printing logs + a rollback
command if it fails.

## `clinic-saas-watchdog.sh` — on-host health watchdog

Runs every 2 minutes via Hermes cron (job: *Clinic SaaS (4310) health watchdog*).
Checks: PM2 online · `/health` ok · port bound to `0.0.0.0` (not just localhost)
· Postgres reachable. Silent when healthy; auto-recovers, then reports **once
per incident** (30-min cooldown).

```bash
bash ops/clinic-saas-watchdog.sh                      # normal
WATCHDOG_DRY_RUN=1 bash ops/clinic-saas-watchdog.sh   # detect only, no action
```

Log: `/root/.fidean-clinic-watchdog.log`

## Backups — `/usr/local/bin/clinic-saas-backup.sh`

Cron: `/etc/cron.d/clinic-saas-backup` (daily 02:30). Log:
`/var/log/clinic-saas/backup.log`.

Each run:
1. `pg_dump -Fc` of the `clinic` database
2. **Verifies the archive** with `pg_restore --list` (a file that exists is not
   a backup; a readable archive is)
3. Writes a row-count snapshot for audit
4. Keeps **7 daily + 4 weekly** copies in `/var/backups/clinic-saas/`
5. Copies off-host to `finpa-business:/home/finpa-user/clinic-saas-backups/`

### Restore procedure

```bash
# 1. Pick a dump
ls -t /var/backups/clinic-saas/daily/clinic-*.dump | head -1

# 2. Restore into a scratch DB FIRST — never straight over production
sudo -u postgres psql -c "CREATE DATABASE clinic_restore OWNER clinic;"
sudo -u postgres pg_restore -d clinic_restore --no-owner --no-privileges <DUMP>

# 3. Compare row counts before trusting it
sudo -u postgres psql -d clinic_restore -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
diff <(psql "$DATABASE_URL" -At -c "SELECT relname||'='||n_live_tup FROM pg_stat_user_tables ORDER BY relname;") \
     <(sudo -u postgres psql -d clinic_restore -At -c "SELECT relname||'='||n_live_tup FROM pg_stat_user_tables ORDER BY relname;")

# 4. To promote: stop app, restore over 'clinic', restart
pm2 stop fidean-clinic-saas
sudo -u postgres dropdb clinic && sudo -u postgres createdb clinic -O clinic
sudo -u postgres pg_restore -d clinic --no-owner --no-privileges <DUMP>
sudo -u postgres psql -d clinic -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO clinic;"
pm2 startOrReload ecosystem.config.cjs --only fidean-clinic-saas && curl -s http://169.58.111.70:4310/health
```

**Note:** a dump restored with `--no-owner` leaves tables owned by `postgres`.
Either restore as the app role, or re-grant as shown above — otherwise the app
hits `permission denied for table ...`.

## `.github/workflows/uptime-check.yml` — external uptime check

Runs on GitHub infrastructure every 15 minutes. On failure it opens/updates a
GitHub **Issue** labelled `incident` and fails the run (GitHub emails the repo
owner). The issue auto-closes on recovery. Needs **no stored secrets**.

---

## Known failure modes and what covers them

| Failure | Covered by |
|---|---|
| PM2 config points at non-existent build output | 1 safe-deploy guard |
| TypeScript syntax error (e.g. duplicate symbol) | 1 safe-deploy guard |
| App crash-loop / process died | 2 watchdog (≤2 min) |
| Wrong host binding (127.0.0.1 vs 0.0.0.0) | 2 watchdog |
| Postgres service down | 2 watchdog (`systemctl restart`) |
| Whole server / network down | 4 external check |
| Data loss / bad migration | 3 backups |
| Server reboot | 5 pm2 save + systemd |

## Still not covered

- **Restore drills are manual.** Nothing currently *proves* a backup restores on
  a schedule — the 2026-09-30 restore was verified by hand. Consider a monthly
  automated restore-into-scratch check.
- **Backups are not encrypted.** The dump contains patient data. It sits in
  `/var/backups` (root-only) and on the Contabo VPS as a normal file — encrypt
  with `age`/`gpg` if the off-host copy needs stronger protection.
- **No Telegram-native alerting.** Alerts arrive as GitHub email/issue. For
  Telegram alerts, add UptimeRobot (free) pointing at the same health URL with a
  Telegram alert contact — that keeps the bot token in UptimeRobot's vault rather
  than on our hosts.
