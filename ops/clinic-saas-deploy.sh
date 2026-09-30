#!/bin/bash
# ============================================================================
# Fidean Clinic SaaS — safe deploy / preflight
#
# Use this INSTEAD of `pm2 restart` whenever you change code.
# It refuses to restart production if the change cannot start.
#
#   bash clinic-saas-deploy.sh            # check + deploy
#   CHECK_ONLY=1 bash clinic-saas-deploy.sh   # check without restarting
#
# Steps:
#   1. Ecosystem config loads AND its entry file actually exists
#      (the exact fault that caused the 2026-09-30 outage)
#   2. esbuild transform check on src/server.ts — catches syntax errors and
#      import/export problems (e.g. duplicate symbol) BEFORE restart
#   3. Record git HEAD for rollback reference
#   4. pm2 restart, then poll /health until it passes (or 40s timeout)
#   5. On failure: print logs + rollback command; do not leave it silently dead
# ============================================================================
set -uo pipefail

APP="fidean-clinic-saas"
APP_DIR="/root/fidean_workspaces/fidean-clinic-saas"
ECOSYSTEM="${DEPLOY_ECOSYSTEM:-$APP_DIR/ecosystem.config.cjs}"
HEALTH_URL="http://127.0.0.1:4310/health"
CHECK_ONLY="${CHECK_ONLY:-0}"

cd "$APP_DIR" || { echo "🔴 Cannot cd to $APP_DIR"; exit 1; }

step() { echo "  [..] $*"; }
ok()   { echo "  [OK] $*"; }
bad()  { echo "  [FAIL] $*"; }

echo "=== Fidean Clinic SaaS — preflight ==="

# ── 1. Ecosystem config → entry file must exist ──────────────────────────────
step "Validating ecosystem config..."
if [ ! -f "$ECOSYSTEM" ]; then
  bad "ecosystem config missing: $ECOSYSTEM"
  exit 1
fi

ENTRY=$(node -e "
const cfg = require('$ECOSYSTEM');
const a = cfg.apps && cfg.apps[0];
if (!a) { console.error('no apps[0]'); process.exit(2); }
const path = require('path');
const script = a.script;
if (!script) { console.error('apps[0].script is empty'); process.exit(3); }
console.log(path.resolve(a.cwd || process.cwd(), script));
" 2>&1) || { bad "ecosystem config did not load: $ENTRY"; exit 1; }

if [ ! -e "$ENTRY" ]; then
  bad "ecosystem points at a file that does NOT exist: $ENTRY"
  echo "         This is the fault class that took production down on 2026-09-30."
  exit 1
fi
ok "entry exists: $ENTRY"

# Also confirm the args target exists when the entry is an interpreter shim
ARGS=$(node -e "
const c=require('$ECOSYSTEM');
const a=(c.apps&&c.apps[0])||{};
const v=a.args;
if (Array.isArray(v)) console.log(v.join(' '));
else if (typeof v === 'string') console.log(v);
")
if [ -n "$ARGS" ]; then
  for a in $ARGS; do
    if [[ "$a" == *.ts || "$a" == *.js ]]; then
      if [ ! -f "$APP_DIR/$a" ]; then
        bad "ecosystem arg target missing: $APP_DIR/$a"
        exit 1
      fi
      ok "arg target exists: $a"
    fi
  done
fi

# ── 2. Syntax / import check (no side effects — does not boot the app) ───────
step "Transform-checking src/server.ts (esbuild)..."
ESB="$APP_DIR/node_modules/.bin/esbuild"
if [ ! -x "$ESB" ]; then
  bad "esbuild not found at $ESB"
  exit 1
fi

if ! "$ESB" src/server.ts --bundle --platform=node --format=esm \
      --outfile=/dev/null --log-level=warning 2>/tmp/esb.err; then
  bad "syntax/import check FAILED — production left untouched"
  echo ""
  sed 's/^/         /' /tmp/esb.err | head -25
  echo ""
  echo "  Fix the error above, then re-run this script."
  exit 1
fi
ok "syntax + imports clean"

# ── 3. Record current revision for rollback ─────────────────────────────────
REV=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
step "Current revision: $REV (uncommitted files: $DIRTY)"

if [ "$CHECK_ONLY" = "1" ]; then
  echo ""
  echo "=== Preflight PASSED (CHECK_ONLY — production not restarted) ==="
  exit 0
fi

# ── 4. Restart + verify ─────────────────────────────────────────────────────
echo ""
step "Restarting $APP..."
pm2 restart "$APP" >/dev/null 2>&1

step "Waiting for /health to pass (max 40s)..."
HEALTHY=0
for i in $(seq 1 20); do
  sleep 2
  R=$(curl -s -m 5 "$HEALTH_URL" 2>/dev/null || echo "")
  if echo "$R" | grep -q '"ok":true'; then
    HEALTHY=1
    ok "healthy after $((i*2))s: $R"
    break
  fi
done

# ── 5. Outcome ──────────────────────────────────────────────────────────────
if [ "$HEALTHY" = "1" ]; then
  echo ""
  echo "=== ✅ DEPLOY OK — $APP is healthy (rev $REV) ==="
  exit 0
fi

echo ""
bad "app did NOT become healthy within 40s"
echo ""
echo "--- last 20 pm2 logs ---"
pm2 logs "$APP" --lines 20 --nostream 2>&1 | tail -25
echo ""
echo "--- rollback ---"
echo "  cd $APP_DIR && git log --oneline -5"
echo "  git checkout $REV -- . && pm2 restart $APP"
echo ""
echo "=== 🔴 DEPLOY FAILED — manual attention needed ==="
exit 1
