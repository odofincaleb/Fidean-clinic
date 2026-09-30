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
HEALTH_URL="${WATCHDOG_HEALTH_URL:-http://127.0.0.1:4310/health}"
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

# 2. HTTP health?
HEALTH=$(curl -s -m 10 "$HEALTH_URL" 2>/dev/null || echo "")
echo "$HEALTH" | grep -q '"ok":true' || FAILURES+=("health_unreachable")

# 3. Bound to 0.0.0.0 (not 127.0.0.1)?
ss -tlnp 2>/dev/null | grep -q "0.0.0.0:$PORT" || FAILURES+=("port_not_external")

# 4. Postgres reachable?
pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null || FAILURES+=("postgres_down")

# --- healthy: stay silent ---------------------------------------------------
if [ ${#FAILURES[@]} -eq 0 ]; then
  # Clear incident state on recovery
  if [ -f "$STATE_FILE" ]; then
    rm -f "$STATE_FILE"
    echo "✅ Clinic SaaS (4310) recovered — all checks passing again ($(ts))"
  fi
  exit 0
fi

FAIL_STR=$(IFS=', '; echo "${FAILURES[*]}")
log "UNHEALTHY: $FAIL_STR"

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

  # Restart the app (fixes crash-loops, port binding, health failures)
  if [ "$PM2_STATUS" != "online" ] || [[ " ${FAILURES[*]} " == *"health_unreachable"* ]] \
     || [[ " ${FAILURES[*]} " == *"port_not_external"* ]]; then
    log "attempting: pm2 restart $APP"
    cd "$APP_DIR" 2>/dev/null && pm2 restart "$APP" >/dev/null 2>&1
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
echo "$HEALTH2" | grep -q '"ok":true' || RECHECK+=("health")
ss -tlnp 2>/dev/null | grep -q "0.0.0.0:$PORT" || RECHECK+=("port")
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
  echo "⚠️ Clinic SaaS (4310) went DOWN and was AUTO-RECOVERED at $(ts)"
  echo ""
  echo "Detected: $FAIL_STR"
  echo "Action: restarted — now healthy."
  echo "Health: $HEALTH2"
  echo ""
  echo "Log: $LOG_FILE"
  log "AUTO-RECOVERED"
else
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
