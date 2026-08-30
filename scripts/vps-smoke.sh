#!/usr/bin/env bash
#
# Smoke-test a Kothai image on an x86-64 VPS.
#
# The full image ships native prebuilds (llama.cpp, onnx, rocksdb) that have
# only ever been exercised on arm64 in anger. The two ways x86 breaks are both
# silent until you look: an illegal instruction when a prebuild is compiled for
# a wider SIMD level than the CPU has (the amd64 analogue of the arm64 SVE
# SIGILL this project already works around), and an OOM kill during model load
# that an orchestrator then papers over as a restart loop.
#
# Neither shows up in `docker run` exit codes you would notice, so this script
# looks for them directly and reports a pass/fail table.
#
# Usage:
#   ./vps-smoke.sh [--image REF] [--port N] [--skip-models] [--lite] [--keep]
#
# Needs: docker, curl, jq.

set -uo pipefail

IMAGE="ghcr.io/ibrahimtareq/kothai:latest"
PORT=5173
SKIP_MODELS=0
LITE=0
KEEP=0
MODEL_TIMEOUT=1800   # first boot downloads ~1.3 GB

while [ $# -gt 0 ]; do
  case "$1" in
    --image) IMAGE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --skip-models) SKIP_MODELS=1; shift ;;
    --lite) LITE=1; SKIP_MODELS=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

NAME="kothai-smoke-$$"
AUTH_NAME="${NAME}-auth"
AUTH_PORT=$((PORT + 1))
WORKDIR="$(mktemp -d)"
BASE="http://127.0.0.1:${PORT}"
PASSWORD='smoke-test-password'

PASSED=0; FAILED=0; SKIPPED=0
RESULTS=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
amber() { printf '\033[33m%s\033[0m' "$1"; }

pass() { PASSED=$((PASSED+1)); RESULTS+=("PASS|$1|${2:-}"); printf '  %s %s\n' "$(green ok)" "$1"; }
fail() {
  # Details are frequently container logs. Newlines in them would run through
  # the stored record and break the summary's field split, so they are
  # flattened and clipped here rather than at each call site.
  local detail
  detail=$(printf '%s' "${2:-}" | tr '\n\r|' '   ' | cut -c1-160)
  FAILED=$((FAILED+1)); RESULTS+=("FAIL|$1|$detail")
  printf '  %s %s\n' "$(red FAIL)" "$1"
  [ -n "$detail" ] && printf '       %s\n' "$detail"
  return 0   # never let a missing detail line make this look like a failed command
}
skip() { SKIPPED=$((SKIPPED+1)); RESULTS+=("SKIP|$1|${2:-}"); printf '  %s %s\n' "$(amber skip)" "$1"; }
note() { printf '       %s\n' "$1"; }
phase() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Assert on a command's success. check "<label>" <cmd...>
check() { local label="$1"; shift; local out; if out=$("$@" 2>&1); then pass "$label"; else fail "$label" "${out:0:200}"; fi; }

api() { curl -fsS --max-time 30 "$@"; }
# jq over a response that may not be JSON at all. An endpoint this image does
# not have returns the SPA shell, not a 404, so "not JSON" is a normal answer
# here and must not print a parse error over the report.
jqr() { jq -r "$1" 2>/dev/null; }
api_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$@"; }

cleanup() {
  [ "$KEEP" = 1 ] && { echo; echo "kept: containers $NAME/$AUTH_NAME, workdir $WORKDIR"; return; }
  docker rm -f "$NAME" "$AUTH_NAME" >/dev/null 2>&1
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# The two failure modes this whole script exists for. Both surface in the
# container log rather than as a clean non-zero exit.
CRASH_PATTERNS='SIGILL|[Ii]llegal instruction|undefined symbol|CANNOT_LOAD|core dumped|out of memory|std::bad_alloc'

scan_logs() {
  local label="$1" name="$2" hits
  hits=$(docker logs "$name" 2>&1 | grep -nE "$CRASH_PATTERNS" | head -5)
  if [ -n "$hits" ]; then fail "$label" "$(echo "$hits" | tr '\n' ' ')"; else pass "$label"; fi
}

healthy_body() {
  curl -fsS --max-time 10 "$1/api/health" 2>/dev/null | jqr '.ok // empty' | grep -qx true
}

wait_for_health() {
  local url="$1" deadline=$((SECONDS + ${2:-120}))
  while [ $SECONDS -lt $deadline ]; do
    healthy_body "$url" && return 0
    docker inspect -f '{{.State.Running}}' "$3" 2>/dev/null | grep -q true || return 1
    sleep 2
  done
  return 1
}

# ─────────────────────────────── host ───────────────────────────────────────
phase "Host"

for tool in docker curl jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool (apt-get install -y curl jq)" >&2; exit 2; }
done
pass "docker, curl and jq present"

if [ "$(uname -s)" != "Linux" ]; then
  note "not running on Linux — /proc is absent, so the CPU and RAM checks below will fail regardless of the image"
fi

ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then pass "host is x86-64"
else fail "host is x86-64" "found $ARCH — this script exists to test the amd64 image"; fi

if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
  pass "CPU has AVX2"
else
  fail "CPU has AVX2" "no avx2 in /proc/cpuinfo — llama.cpp prebuilds will SIGILL"
fi
if grep -qw avx512f /proc/cpuinfo 2>/dev/null; then
  note "CPU also has AVX-512 — note that most rented shared vCPUs do NOT, so passing here proves less"
else
  note "no AVX-512 (typical for shared vCPU) — this is the configuration worth testing"
fi

RAM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0) / 1024 ))
if [ "$LITE" = 1 ]; then
  [ "$RAM_MB" -ge 1800 ] && pass "RAM ${RAM_MB}MB (lite wants ~2 GB)" || fail "RAM" "${RAM_MB}MB is under 2 GB"
elif [ "$SKIP_MODELS" = 1 ]; then
  [ "$RAM_MB" -ge 1800 ] && pass "RAM ${RAM_MB}MB (no models will load)" || fail "RAM" "${RAM_MB}MB"
else
  if [ "$RAM_MB" -ge 7600 ]; then pass "RAM ${RAM_MB}MB (full image wants 8 GB)"
  else fail "RAM ${RAM_MB}MB" "under 8 GB — the model load will OOM and look like a restart loop. Hetzner CX32, not CX22."; fi
fi

DISK_GB=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
if [ -n "$DISK_GB" ] && [ "$DISK_GB" -ge 12 ]; then pass "disk ${DISK_GB}GB free"
else fail "disk free" "${DISK_GB:-?}GB — image plus weights plus a backup snapshot needs ~12 GB"; fi

# ─────────────────────────────── image ──────────────────────────────────────
phase "Image"

# A locally built image (buildx --load) is the normal case when testing a change
# before it is published, and pulling would fail or silently replace it.
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  skip "pull $IMAGE (already present locally)"
else
  check "pull $IMAGE" docker pull -q "$IMAGE"
fi
IMG_ARCH=$(docker image inspect "$IMAGE" --format '{{.Architecture}}' 2>/dev/null)
if [ "$IMG_ARCH" = "amd64" ]; then pass "image architecture is amd64"
else fail "image architecture is amd64" "got '${IMG_ARCH:-unknown}' — pull with --platform linux/amd64"; fi

# ─────────────────────────────── boot ───────────────────────────────────────
phase "Boot"

RUN_ARGS=(-d --name "$NAME" -p "${PORT}:5173" -v "$WORKDIR/data:/app/data")
[ "$LITE" = 0 ] && RUN_ARGS+=(-v "$WORKDIR/models:/app/models")
[ "$LITE" = 1 ] && RUN_ARGS+=(-e STASH_AI_PROVIDER=remote)

if docker run "${RUN_ARGS[@]}" "$IMAGE" >/dev/null 2>&1; then
  pass "container started"
else
  fail "container started" "$(docker logs "$NAME" 2>&1 | tail -5)"
  exit 1
fi

if wait_for_health "$BASE" 120 "$NAME"; then
  pass "/api/health answers"
else
  fail "/api/health answers" "$(docker logs "$NAME" 2>&1 | tail -10)"
fi

OOM=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME" 2>/dev/null)
[ "$OOM" = "false" ] && pass "not OOM-killed during boot" || fail "not OOM-killed during boot" "raise the box's RAM"
scan_logs "no illegal-instruction or loader crash in boot logs" "$NAME"

# --interval=30s, so the first probe result is not instant.
HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)
if [ "$HEALTH" != "healthy" ]; then
  sleep 35
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)
fi
if [ "$HEALTH" = "healthy" ]; then pass "docker healthcheck reports healthy"
else fail "docker healthcheck" "status=$HEALTH"; fi

# ─────────────────────────────── core API ───────────────────────────────────
phase "Core API (no inference)"

check "/api/status responds" api "$BASE/api/status"

NOTE_ID=$(api -X POST "$BASE/api/save" -H 'Content-Type: application/json' \
  -d '{"text":"kothai vps smoke test note"}' | jqr '.note.id // .id // empty')
[ -n "$NOTE_ID" ] && pass "saved a note ($NOTE_ID)" || fail "saved a note" "no id in response"

COUNT=$(api "$BASE/api/notes?limit=5" | jqr '.total // 0')
[ "${COUNT:-0}" -ge 1 ] && pass "note is listed back (total=$COUNT)" || fail "note is listed back"

# Exercises the SSRF guard's DNS path from inside a container, where the
# resolver differs from the host's. A guard that cannot resolve anything would
# reject every real link and look exactly like "link previews are broken".
LINK_ID=$(api -X POST "$BASE/api/save" -H 'Content-Type: application/json' \
  -d '{"text":"https://example.com/"}' | jqr '.note.id // .id // empty')
if [ -n "$LINK_ID" ]; then
  TITLE=""
  for _ in $(seq 1 15); do
    TITLE=$(api "$BASE/api/notes/$LINK_ID" | jqr '.note.siteTitle // empty')
    [ -n "$TITLE" ] && break
    sleep 2
  done
  [ -n "$TITLE" ] && pass "link preview fetched through the SSRF guard (\"$TITLE\")" \
    || fail "link preview" "no siteTitle after 30s — check DNS inside the container"
else
  fail "link preview" "could not save the link note"
fi

# ─────────────────────────────── backup ─────────────────────────────────────
phase "Backup"

if curl -fsS --max-time 300 -o "$WORKDIR/backup.db" "$BASE/api/backup" \
   && [ "$(head -c 15 "$WORKDIR/backup.db")" = "SQLite format 3" ]; then
  # Checked together on purpose: a build without this route answers 200 with
  # the SPA shell, so "the request succeeded" is not evidence of a backup.
  pass "GET /api/backup returned a database ($(du -h "$WORKDIR/backup.db" | cut -f1))"
  # Integrity-checked with the node inside the image, so the host needs no sqlite3.
  INTEG=$(docker run --rm --entrypoint node -v "$WORKDIR:/w" "$IMAGE" \
    -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('/w/backup.db',{readOnly:true}).prepare('PRAGMA integrity_check').get().integrity_check)" 2>/dev/null | tr -d '\r')
  [ "$INTEG" = "ok" ] && pass "backup passes PRAGMA integrity_check" || fail "backup integrity_check" "got '${INTEG:-<none>}'"
  if ls "$WORKDIR/data" 2>/dev/null | grep -q '^backup-'; then
    fail "temp snapshot cleaned up" "a backup-*.db was left in data/"
  else
    pass "temp snapshot cleaned up"
  fi
else
  fail "GET /api/backup returned a database" "no SQLite header — is this build older than the backup route?"
fi

# ─────────────────────────────── auth ───────────────────────────────────────
phase "Password gate"

# A second container, because STASH_PASSWORD is read at boot. No models needed:
# the gate is provider-independent.
if docker run -d --name "$AUTH_NAME" -p "${AUTH_PORT}:5173" \
     -e STASH_PASSWORD="$PASSWORD" -e STASH_AI_PROVIDER=remote \
     "$IMAGE" >/dev/null 2>&1; then
  AUTH_BASE="http://127.0.0.1:${AUTH_PORT}"
  if wait_for_health "$AUTH_BASE" 90 "$AUTH_NAME"; then
    pass "/api/health is reachable with a password set"
    # THE trap: the container healthcheck has no credentials. If it were still
    # pointed at a gated endpoint, every orchestrator would restart-loop this.
    sleep 35
    AH=$(docker inspect -f '{{.State.Health.Status}}' "$AUTH_NAME" 2>/dev/null)
    [ "$AH" = "healthy" ] && pass "docker healthcheck stays healthy behind the gate" \
      || fail "docker healthcheck behind the gate" "status=$AH — this is the restart-loop failure mode"

    if [ "$(api_code "$AUTH_BASE/api/notes")" = "401" ]; then
      pass "API refuses without a session"
      curl -s -c "$WORKDIR/cookies" -o /dev/null -X POST "$AUTH_BASE/api/login" \
        -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}"
      if [ "$(curl -s -b "$WORKDIR/cookies" -o /dev/null -w '%{http_code}' "$AUTH_BASE/api/notes")" = "200" ]; then
        pass "logging in unlocks the API"
      else
        fail "logging in unlocks the API"
      fi
    else
      fail "API refuses without a session" "got $(api_code "$AUTH_BASE/api/notes") — no gate in this build"
      # Without a gate, a 200 after logging in proves nothing.
      skip "logging in unlocks the API (no gate to unlock)"
    fi
  else
    fail "authed container became healthy" "$(docker logs "$AUTH_NAME" 2>&1 | tail -5)"
  fi
else
  fail "authed container started"
fi

# ─────────────────────────────── models ─────────────────────────────────────
phase "Local inference"

if [ "$SKIP_MODELS" = 1 ]; then
  skip "model download and inference (--skip-models/--lite)"
  note "this is the part that actually exercises the native prebuilds — run without --skip-models before trusting an x86 build"
else
  # A fresh install downloads nothing until models are chosen, so the first-run
  # picker has to be driven here or the wait below never ends.
  if api -X POST "$BASE/api/setup" -H 'Content-Type: application/json' \
      -d '{"llm":"QWEN3_1_7B_INST_Q4","embed":"EMBEDDINGGEMMA_300M_Q8_0","vision":"QWEN3_5_2B_MULTIMODAL_Q4_K_M"}' >/dev/null; then
    pass "first-run model selection accepted"
  else
    fail "first-run model selection"
  fi

  printf '       downloading weights (~1.3 GB), up to %s min' $((MODEL_TIMEOUT / 60))
  DEADLINE=$((SECONDS + MODEL_TIMEOUT)); LLM_STATE=""
  while [ $SECONDS -lt $DEADLINE ]; do
    LLM_STATE=$(api "$BASE/api/status" | jqr '.roles.llm.state // "?"')
    [ "$LLM_STATE" = "ready" ] && break
    [ "$LLM_STATE" = "error" ] && break
    docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true || { LLM_STATE="container died"; break; }
    printf '.'; sleep 10
  done
  echo

  [ "$LLM_STATE" = "ready" ] && pass "LLM reached ready" \
    || fail "LLM reached ready" "state=$LLM_STATE after $((MODEL_TIMEOUT/60))min — $(docker logs "$NAME" 2>&1 | tail -3)"

  OOM=$(docker inspect -f '{{.State.OOMKilled}}' "$NAME" 2>/dev/null)
  [ "$OOM" = "false" ] && pass "not OOM-killed during model load" || fail "not OOM-killed during model load"
  scan_logs "no illegal-instruction crash during model load" "$NAME"

  if [ "$LLM_STATE" = "ready" ]; then
    ANSWER=$(api -X POST "$BASE/api/ask" -H 'Content-Type: application/json' \
      -d '{"question":"what did I save about a smoke test?"}' | jqr '.answer // empty')
    [ -n "$ANSWER" ] && pass "inference answered (${#ANSWER} chars)" || fail "inference answered" "empty answer"

    EMB=$(api "$BASE/api/enrich/backlog" | jqr '.count // "?"')
    note "enrichment backlog after boot: $EMB"
  fi
fi

# ─────────────────────────────── summary ────────────────────────────────────
phase "Summary"
printf '  %s passed, %s failed, %s skipped\n' "$(green $PASSED)" "$([ $FAILED -gt 0 ] && red $FAILED || echo 0)" "$SKIPPED"
if [ $FAILED -gt 0 ]; then
  echo
  echo "  failures:"
  for r in "${RESULTS[@]}"; do
    case "$r" in FAIL\|*) printf '   - %s\n' "$(echo "$r" | cut -d'|' -f2)";; esac
  done
  exit 1
fi
echo "  amd64 image looks good on this box."
