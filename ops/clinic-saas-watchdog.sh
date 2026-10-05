#!/bin/bash
# ============================================================================
# Fidean Clinic SaaS — health watchdog
#
# Runs every 2 minutes from cron. Silent when healthy.
# On failure: attempts auto-recovery, then reports ONCE per incident
# (no spam on repeated ticks).
#
# Checks (in order):
#   1. PM2 process is online
#   2. HTTP /health returns ok:true
#   3. Port 4310 is actually bound to 0.0.0.0 (external reachability)
#   4. PostgreSQL is accepting connections
#
# Exit: always 0 (so cron doesn't generate its own error noise).
# ============================================================================
set -uo pipefail

APP="fidean-clinic-saas"
APP_DIR="/root/fidean_workspaces/fidean-clinic-saas"
# Local liveness (is the app process serving?) vs public reachability
# (can users actually get to it?). These are NOT the same thing: an app bound
# to 127.0.0.1 answers on localhost but is invisible to the internet — which
# is exactly how the Oct 2026 outages presented. HEALTH_URL is the public
# endpoint, so the watchdog sees what users see.
LOCAL_URL="${WATCHDOG_LOCAL_URL:-http://127.0.0.1:4310/health}"
EXTERNAL_URL="${WATCHDOG_EXTERNAL_URL:-http://169.58.111.70:4310/health}"
HEALTH_URL="${WATCHDOG_HEALTH_URL:-$EXTERNAL_URL}"
STATE_FILE="/root/.fidean-clinic-watchdog.state"
LOG_FILE="/root/.fidean-clinic-watchdog.log"
PORT="${WATCHDOG_PORT:-4310}"
# Don't re-alert for the same incident more often than this (seconds)
ALERT_COOLDOWN=1800
# DRY_RUN=1 → detect + report only, never touch the running app (for testing)
DRY_RUN="${WATCHDOG_DRY_RUN:-0}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

log() { echo "$(ts) $*" >> "$LOG_FILE"; }

# --- collect failures -------------------------------------------------------
FAILURES=()

# 1. PM2 online?
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('none'); raise SystemExit
for a in d:
    if a.get('name')=='$APP':
        print(a['pm2_env']['status']); raise SystemExit
print('missing')
" 2>/dev/null)
[ "$PM2_STATUS" != "online" ] && FAILURES+=("pm2_status=$PM2_STATUS")

# 2. Public HTTP health — the endpoint users actually hit
HEALTH=$(curl -s -m 10 "$HEALTH_URL" 2>/dev/null || echo "")
echo "$HEALTH" | grep -q '"ok":true' || FAILURES+=("health_unreachable")

# 2b. Local liveness — separates "app is dead" from "app is alive but
#     unreachable from outside" (the dangerous silent case)
HEALTH_LOCAL=$(curl -s -m 10 "$LOCAL_URL" 2>/dev/null || echo "")
echo "$HEALTH_LOCAL" | grep -q '"ok":true' || FAILURES+=("app_not_serving_locally")

# 3. Reachable from outside?
#    Accept ANY non-loopback bind (0.0.0.0, *, [::]) — Node may legitimately
#    bind dual-stack, which `ss` renders as `*:PORT` or `[::]:PORT`, not
#    `0.0.0.0:PORT`. The old exact-string grep flagged those as failures and
#    restarted a perfectly healthy service. Fail only when the port is absent
#    or bound to loopback exclusively.
BOUND=$(ss -tln 2>/dev/null | awk -v p=":$PORT" 'index($4,p)>0 {print $4}' | head -5)
if [ -z "$BOUND" ]; then
  FAILURES+=("port_not_external(port_not_bound)")
elif [ "$(printf '%s\n' "$BOUND" | grep -cvE '^(127\.0\.0\.1|\[::1\]):')" = "0" ]; then
  FAILURES+=("port_not_external(loopback_only)")
fi

# 4. Postgres reachable?
pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null || FAILURES+=("postgres_down")

# --- healthy: stay silent ---------------------------------------------------
if [ ${#FAILURES[@]} -eq 0 ]; then
  # Clear incident state on recovery. Log-only: routine recoveries must NOT
  # post to chat — they surface in the end-of-day summary instead.
  if [ -f "$STATE_FILE" ]; then
    rm -f "$STATE_FILE"
    log "RECOVERED — all checks passing again"
  fi
  exit 0
fi

FAIL_STR=$(IFS=', '; echo "${FAILURES[*]}")
log "UNHEALTHY: $FAIL_STR"

# Forensic snapshot so the NEXT occurrence tells us exactly what the socket and
# environment looked like (the 2026-10-01 churn was undiagnosable without this).
{
  echo "  diag bound=[$(ss -tln 2>/dev/null | awk -v p=":$PORT" 'index($4,p)>0 {print $4}' | tr '\n' ' ')]"
  echo "  diag proc_env_HOST=[$(pgrep -f 'tsx src/server.ts' 2>/dev/null | head -1 | xargs -r -I{} sh -c 'tr "\0" "\n" < /proc/{}/environ 2>/dev/null | grep -m1 "^HOST="' 2>/dev/null)]"
  echo "  diag last_boot=[$(grep -a '\[BOOT\]' /root/.pm2/logs/fidean-clinic-saas-out.log 2>/dev/null | tail -1)]"
} >> "$LOG_FILE"

# --- attempt recovery -------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: would attempt recovery for: $FAIL_STR"
else
  # Postgres is handled by systemd, not PM2
  if [[ " ${FAILURES[*]} " == *"postgres_down"* ]]; then
    log "attempting: systemctl restart postgresql"
    systemctl restart postgresql >/dev/null 2>&1
    sleep 6
  fi

  # Restart the app (fixes crash-loops, port binding, health failures).
  # Use startOrReload with the ecosystem file rather than plain `pm2 restart`:
  # restart reuses whatever env the process already has, so a process that is
  # somehow missing HOST comes back up bound to localhost only. startOrReload
  # always reapplies HOST/PORT/NODE_ENV from ecosystem.config.cjs.
  if [ "$PM2_STATUS" != "online" ] || [[ " ${FAILURES[*]} " == *"health_unreachable"* ]] \
     || [[ " ${FAILURES[*]} " == *"port_not_external"* ]] \
     || [[ " ${FAILURES[*]} " == *"app_not_serving_locally"* ]]; then
    log "attempting: pm2 startOrReload ecosystem.config.cjs --only $APP"
    cd "$APP_DIR" 2>/dev/null && pm2 startOrReload ecosystem.config.cjs --only "$APP" >/dev/null 2>&1
    sleep 10
  fi
fi

# --- re-check ---------------------------------------------------------------
RECHECK=()
PM2_STATUS2=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('none'); raise SystemExit
for a in d:
    if a.get('name')=='$APP': print(a['pm2_env']['status']); raise SystemExit
print('missing')
" 2>/dev/null)
[ "$PM2_STATUS2" != "online" ] && RECHECK+=("pm2=$PM2_STATUS2")
HEALTH2=$(curl -s -m 10 "$HEALTH_URL" 2>/dev/null || echo "")
echo "$HEALTH2" | grep -q '"ok":true' || RECHECK+=("health_external")
HEALTH2_LOCAL=$(curl -s -m 10 "$LOCAL_URL" 2>/dev/null || echo "")
echo "$HEALTH2_LOCAL" | grep -q '"ok":true' || RECHECK+=("health_local")
BOUND2=$(ss -tln 2>/dev/null | awk -v p=":$PORT" 'index($4,p)>0 {print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]):' | head -1)
[ -z "$BOUND2" ] && RECHECK+=("port")
pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null || RECHECK+=("postgres")

# --- alert (once per incident, cooldown-limited) ----------------------------
NOW=$(date +%s)
if [ -f "$STATE_FILE" ]; then
  LAST=$(cut -d: -f1 "$STATE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt $ALERT_COOLDOWN ]; then
    log "suppressing repeat alert (cooldown)"
    exit 0
  fi
fi
echo "$NOW:${#RECHECK[@]}" > "$STATE_FILE"

if [ ${#RECHECK[@]} -eq 0 ]; then
  # Auto-recovery succeeded — LOG ONLY, no chat noise. Counted in the
  # end-of-day summary (see clinic-saas-daily-summary.sh).
  log "AUTO-RECOVERED"
else
  # Recovery FAILED — this is worth interrupting for: the service is still down.
  RECHECK_STR=$(IFS=', '; echo "${RECHECK[*]}")
  echo "🔴 Clinic SaaS (4310) is DOWN — AUTO-RECOVERY FAILED"
  echo ""
  echo "Detected: $FAIL_STR"
  echo "Still failing: $RECHECK_STR"
  echo "Last health response: ${HEALTH2:-<empty>}"
  echo ""
  echo "--- pm2 recent logs ---"
  pm2 logs "$APP" --lines 12 --nostream 2>&1 | tail -18
  echo ""
  echo "Manual fix: cd $APP_DIR && pm2 restart $APP"
  log "AUTO-RECOVERY FAILED: $RECHECK_STR"
fi

exit 0
