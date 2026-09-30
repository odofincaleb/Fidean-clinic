#!/usr/bin/env bash
# ============================================================================
# Fidean Clinic SaaS — Postgres backup
#
# Dumps the `clinic` database in custom format, VERIFIES the dump is readable,
# enforces daily/weekly retention, and copies it OFF-HOST to the Contabo VPS
# so a host-level failure cannot lose both the app and its backups.
#
# Cron: daily 02:30 (see /etc/cron.d/clinic-saas-backup)
# Log:  /var/log/clinic-saas/backup.log
#
# Manual run:  clinic-saas-backup.sh
# Restore:     see ops/README.md
# ============================================================================
set -euo pipefail

ENV_FILE="${ENV_FILE:-/root/fidean_workspaces/fidean-clinic-saas/.env}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/clinic-saas}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DOW="$(date -u +%u)"                       # 1..7 ; 7 = Sunday
DAILY_DEST="${BACKUP_ROOT}/daily"
WEEKLY_DEST="${BACKUP_ROOT}/weekly"
LOG_DIR="/var/log/clinic-saas"
OFFSITE_HOST="${OFFSITE_HOST:-finpa-business}"
OFFSITE_DIR="${OFFSITE_DIR:-/home/finpa-user/clinic-saas-backups}"
LOCK="/run/clinic-saas-backup.lock"

mkdir -p "$DAILY_DEST" "$WEEKLY_DEST" "$LOG_DIR"

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $*"; }

# ── single-instance lock (never overlap runs) ───────────────────────────────
exec 9>"$LOCK"
if ! flock -n 9; then
  log "another backup is already running — exiting"
  exit 0
fi

# ── load DATABASE_URL ───────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "FATAL: env file not found: $ENV_FILE"
  exit 1
fi
# shellcheck disable=SC1090
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [ -z "${DATABASE_URL:-}" ]; then
  log "FATAL: DATABASE_URL not found in $ENV_FILE"
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

OUT="${TMP}/clinic-${STAMP}.dump"

# ── 1. dump ─────────────────────────────────────────────────────────────────
log "==> pg_dump (custom format)"
if ! pg_dump "$DATABASE_URL" -Fc -f "$OUT"; then
  log "FATAL: pg_dump failed"
  exit 1
fi

SIZE="$(stat -c%s "$OUT")"
log "    dump size: $SIZE bytes"
if [ "$SIZE" -lt 10240 ]; then
  log "FATAL: dump suspiciously small ($SIZE bytes) — refusing to record it"
  exit 1
fi

# ── 2. VERIFY the dump is actually readable (not just present) ──────────────
log "==> verifying dump with pg_restore --list"
if ! pg_restore --list "$OUT" > "${TMP}/manifest.txt" 2>"${TMP}/verify.err"; then
  log "FATAL: dump verification failed — corrupt/incomplete archive"
  sed 's/^/    /' "${TMP}/verify.err" || true
  exit 1
fi
TBL_COUNT="$(grep -c 'TABLE DATA' "${TMP}/manifest.txt" || true)"
log "    verified OK — $TBL_COUNT table data sections"
if [ "$TBL_COUNT" -lt 5 ]; then
  log "FATAL: only $TBL_COUNT table sections found — archive looks wrong"
  exit 1
fi

# ── 3. record a row-count snapshot alongside the dump ───────────────────────
log "==> capturing row-count snapshot"
{
  echo "# clinic DB row counts at $STAMP"
  psql "$DATABASE_URL" -At -c \
    "SELECT relname || '=' || n_live_tup FROM pg_stat_user_tables ORDER BY relname;"
} > "${TMP}/rowcounts.txt" 2>/dev/null || log "    (row-count snapshot skipped)"

# ── 4. place it (daily + weekly on Sundays) ─────────────────────────────────
DEST_NAME="clinic-${STAMP}.dump"
mv "$OUT" "${DAILY_DEST}/${DEST_NAME}"
cp "${TMP}/rowcounts.txt" "${DAILY_DEST}/rowcounts-${STAMP}.txt"
[ -f "${TMP}/manifest.txt" ] && cp "${TMP}/manifest.txt" "${DAILY_DEST}/manifest-${STAMP}.txt"

if [ "$DOW" = "7" ]; then
  cp "${DAILY_DEST}/${DEST_NAME}" "${WEEKLY_DEST}/${DEST_NAME}"
  cp "${TMP}/rowcounts.txt" "${WEEKLY_DEST}/rowcounts-${STAMP}.txt"
  log "    copied to weekly tier"
fi
log "    stored: ${DAILY_DEST}/${DEST_NAME}"

# ── 5. OFF-HOST copy (protects against losing the whole box) ────────────────
OFFSITE_OK=0
if command -v ssh >/dev/null 2>&1; then
  log "==> off-host copy to ${OFFSITE_HOST}"
  if timeout 120 ssh -o BatchMode=yes -o ConnectTimeout=15 "$OFFSITE_HOST" \
       "mkdir -p '$OFFSITE_DIR'" 2>/dev/null \
     && timeout 300 scp -q -o BatchMode=yes -o ConnectTimeout=15 \
       "${DAILY_DEST}/${DEST_NAME}" "${OFFSITE_HOST}:${OFFSITE_DIR}/" 2>/dev/null; then
    OFFSITE_OK=1
    log "    off-host copy OK"
  else
    log "    WARNING: off-host copy FAILED (local backup is still safe)"
  fi
else
  log "    WARNING: ssh unavailable — skipping off-host copy"
fi

# ── 6. retention ────────────────────────────────────────────────────────────
log "==> retention (daily=$KEEP_DAILY weekly=$KEEP_WEEKLY)"
find "$DAILY_DEST"  -name 'clinic-*.dump'      -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n "+$((KEEP_DAILY + 1))" | cut -d' ' -f2- | xargs -r rm -f
find "$DAILY_DEST"  -name 'rowcounts-*.txt' -o -name 'manifest-*.txt' 2>/dev/null \
  | xargs -r ls -t 2>/dev/null | tail -n "+$((KEEP_DAILY + 1))" | xargs -r rm -f
find "$WEEKLY_DEST" -name 'clinic-*.dump'      -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n "+$((KEEP_WEEKLY + 1))" | cut -d' ' -f2- | xargs -r rm -f

# ── 7. summary ──────────────────────────────────────────────────────────────
LOCAL_COUNT="$(find "$DAILY_DEST" -name 'clinic-*.dump' | wc -l | tr -d ' ')"
log "DONE  stamp=$STAMP  size=$SIZE  tables=$TBL_COUNT  offhost=$OFFSITE_OK  local_copies=$LOCAL_COUNT"
