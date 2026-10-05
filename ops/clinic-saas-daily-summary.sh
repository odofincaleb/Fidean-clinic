#!/bin/bash
# ============================================================================
# Fidean Clinic SaaS — end-of-day health digest
#
# Summarises the last 24h of watchdog activity from the watchdog log so routine
# recoveries stay OUT of chat and arrive as a single daily digest instead.
#
# Runs from cron with no_agent=True, so stdout is delivered verbatim.
# Always prints (a daily digest should arrive even on a quiet day).
# ============================================================================
set -uo pipefail

LOG_FILE="/root/.fidean-clinic-watchdog.log"
APP="fidean-clinic-saas"
APP_DIR="/root/fidean_workspaces/fidean-clinic-saas"
PORT=4310
PUBLIC_IP="169.58.111.70"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
TODAY=$(date '+%A %d %B %Y')

# --- live status ------------------------------------------------------------
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('none'); raise SystemExit
for a in d:
    if a.get('name')=='$APP': print(a['pm2_env']['status']); raise SystemExit
print('missing')
" 2>/dev/null)
RESTARTS=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('?'); raise SystemExit
for a in d:
    if a.get('name')=='$APP': print(a['pm2_env']['restart_time']); raise SystemExit
print('?')
" 2>/dev/null)
VERSION=$(curl -s -m 8 http://127.0.0.1:$PORT/health 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
BOUND=$(ss -tln 2>/dev/null | awk -v p=":$PORT" 'index($4,p)>0 {print $4}' | tr '\n' ' ')
PUBLIC_OK=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://$PUBLIC_IP:$PORT/health 2>/dev/null)
PG_OK=$(pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null && echo up || echo DOWN)

# --- last 24h from the watchdog log ----------------------------------------
CUTOFF=$(date -d '24 hours ago' '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -v-24H '+%Y-%m-%d %H:%M:%S')
if [ -f "$LOG_FILE" ]; then
  WINDOW=$(awk -v c="$CUTOFF" '$1" "$2 >= c' "$LOG_FILE" 2>/dev/null)
else
  WINDOW=""
fi

# NOTE: `grep -c` prints 0 AND exits 1 when there are no matches, so `|| echo 0`
# would append a second 0. Use `|| true` and normalise instead.
count() { printf '%s\n' "$WINDOW" | grep -c "$1" 2>/dev/null || true; }
incidents=$(count 'UNHEALTHY:')
recovered=$(count 'AUTO-RECOVERED')
failed=$(count 'AUTO-RECOVERY FAILED')
incidents=${incidents:-0}; recovered=${recovered:-0}; failed=${failed:-0}
causes=$(printf '%s\n' "$WINDOW" | sed -n 's/.*UNHEALTHY: //p' | sort | uniq -c | sort -rn | sed 's/^ */    • /')

# --- health verdict ---------------------------------------------------------
if [ "$PM2_STATUS" = "online" ] && [ "$PUBLIC_OK" = "200" ]; then
  VERDICT="✅ UP"
else
  VERDICT="🔴 ATTENTION NEEDED"
fi

cat <<EOF
📋 Fidean Clinic SaaS — daily health digest
$TODAY

Status: $VERDICT
  • process: $PM2_STATUS  (version ${VERSION:-unknown})
  • bound:   ${BOUND:-nothing}   public /health: HTTP $PUBLIC_OK
  • postgres: $PG_OK
  • restarts since last reload: $RESTARTS

Last 24 hours:
  • incidents detected: $incidents
  • auto-recovered:     $recovered
  • still down:         $failed
EOF

if [ "${incidents:-0}" -gt 0 ] && [ -n "${causes:-}" ]; then
  echo "  • causes:"
  printf '%s\n' "$causes"
fi

if [ "${incidents:-0}" -eq 0 ]; then
  echo "  • a clean day — no interventions needed."
fi

echo ""
echo "Log: $LOG_FILE"
