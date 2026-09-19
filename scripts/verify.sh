#!/usr/bin/env bash
# Definition of done for this repo, in one command.
#
#   scripts/verify.sh
#
# Brings up infra, migrates, seeds, boots the services and the engine, runs the
# end-to-end scenarios, then tears the processes down. Exits non-zero if any
# property fails.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG_DIR="$ROOT/.verify"
mkdir -p "$LOG_DIR"

pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=0
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for_http() {
  local url="$1" name="$2" tries=60
  for _ in $(seq 1 "$tries"); do
    if curl -sf "$url" >/dev/null 2>&1; then
      pass "$name is up"
      return 0
    fi
    sleep 0.5
  done
  fail "$name did not come up at $url"
  return 1
}

step "1. Infrastructure"
docker compose up -d --wait >/dev/null 2>&1 && pass "postgres and redis are healthy" || fail "docker compose up failed"

step "2. Migrations"
if bun run db:migrate >"$LOG_DIR/migrate.log" 2>&1; then pass "migrations applied"; else fail "migrations failed (see .verify/migrate.log)"; fi

step "3. Seed"
if bun run scripts/seed.ts >"$LOG_DIR/seed.log" 2>&1; then pass "demo data seeded"; else fail "seed failed (see .verify/seed.log)"; fi

step "4. Services"
bun run --cwd services/rostering-service start >"$LOG_DIR/rostering.log" 2>&1 & PIDS+=($!)
bun run --cwd services/time-attendance-service start >"$LOG_DIR/attendance.log" 2>&1 & PIDS+=($!)
bun run --cwd services/studio-api start >"$LOG_DIR/studio-api.log" 2>&1 & PIDS+=($!)
bun run --cwd services/studio-api worker >"$LOG_DIR/studio-worker.log" 2>&1 & PIDS+=($!)

wait_for_http "http://127.0.0.1:4101/health" "rostering-service" || true
wait_for_http "http://127.0.0.1:4102/health" "time-attendance-service" || true
wait_for_http "http://127.0.0.1:4103/health" "studio-api" || true

step "5. End-to-end scenarios"
if bun test tests/e2e >"$LOG_DIR/e2e.log" 2>&1; then
  pass "coverage rescue, payroll exception, idempotency, role checks"
  tail -n 12 "$LOG_DIR/e2e.log" | sed 's/^/    /'
else
  fail "end-to-end scenarios failed (see .verify/e2e.log)"
  tail -n 40 "$LOG_DIR/e2e.log" | sed 's/^/    /'
fi

step "Result"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mall properties verified\033[0m\n'
  exit 0
fi
printf '  \033[31mverification failed\033[0m\n'
exit 1
