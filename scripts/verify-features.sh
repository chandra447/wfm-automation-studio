#!/usr/bin/env bash
# Feature-level definition of done, on top of scripts/verify.sh.
#
#   scripts/verify-features.sh
#
# Starts the fake OpenAI-compatible provider, then asserts each feature against
# the running stack. Assumes scripts/verify.sh has already brought the stack up,
# or that the services are running. Exits non-zero if any property fails.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOG_DIR="$ROOT/.verify"
mkdir -p "$LOG_DIR"

FAKE_LLM_PORT="${FAKE_LLM_PORT:-4599}"
export FAKE_LLM_BASE_URL="http://127.0.0.1:${FAKE_LLM_PORT}"
export FAKE_LLM_LOG="$LOG_DIR/fake-llm.jsonl"

FAKE_PID=""
cleanup() {
  if [ -n "$FAKE_PID" ]; then kill "$FAKE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

if ! curl -sf "http://127.0.0.1:4103/health" >/dev/null 2>&1; then
  printf '\033[31mstudio-api is not reachable on 4103; run scripts/verify.sh or bun run dev first\033[0m\n'
  exit 1
fi

bun run packages/testkit/src/fake-llm.ts --port "$FAKE_LLM_PORT" --log "$FAKE_LLM_LOG" >"$LOG_DIR/fake-llm-server.log" 2>&1 &
FAKE_PID=$!

for _ in $(seq 1 40); do
  if curl -sf "${FAKE_LLM_BASE_URL}/_probe/requests" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl -sf "${FAKE_LLM_BASE_URL}/_probe/requests" >/dev/null 2>&1; then
  printf '\033[31mfake provider did not start; see .verify/fake-llm-server.log\033[0m\n'
  exit 1
fi

bun run scripts/verify-features.ts
STATUS=$?

exit $STATUS
