#!/usr/bin/env bash
set -euo pipefail

CASES="${1:-6}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"
HTTP_RETRIES="${HTTP_RETRIES:-5}"
REPLAY_RETRIES="${REPLAY_RETRIES:-5}"
RUN_VISIBILITY_RETRIES="${RUN_VISIBILITY_RETRIES:-8}"
PLAYBOOK_VISIBILITY_RETRIES="${PLAYBOOK_VISIBILITY_RETRIES:-12}"
CONSISTENCY_BACKOFF_MS="${CONSISTENCY_BACKOFF_MS:-120}"
STEP_BEFORE_RETRIES="${STEP_BEFORE_RETRIES:-5}"
COMPILE_RETRIES="${COMPILE_RETRIES:-3}"
REPLAY_MODE="${REPLAY_MODE:-strict}"
REPLAY_BACKEND="${REPLAY_BACKEND:-local_process}"

if ! [[ "$CASES" =~ ^[0-9]+$ ]] || [ "$CASES" -le 0 ]; then
  echo "CASES must be a positive integer" >&2
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd jq
require_cmd curl
require_cmd openclaw
require_cmd shasum
require_cmd tar

now_ms() {
  perl -MTime::HiRes=time -e 'printf("%.0f\n",time()*1000)'
}

RUN_ID="$(date +%Y%m%d-%H%M%S)-$RANDOM"
SCOPE="workflow-replay-${RUN_ID}"
BENCH_ROOT="/tmp/aionis-workflow-bench-${RUN_ID}"
OUT_DIR="artifacts/benchmarks-workflow/${RUN_ID}"
RESULTS_JSONL="${OUT_DIR}/cases.jsonl"
SUMMARY_JSON="${OUT_DIR}/summary.json"
REPORT_MD="${OUT_DIR}/report.md"

mkdir -p "$OUT_DIR" "$BENCH_ROOT"

BASE_URL="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.baseUrl // empty' ~/.openclaw/openclaw.json)"
API_KEY="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.apiKey // empty' ~/.openclaw/openclaw.json)"
TENANT_ID="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.tenantId // "default"' ~/.openclaw/openclaw.json)"

if [ -z "$BASE_URL" ] || [ -z "$API_KEY" ]; then
  echo "Aionis plugin config missing baseUrl/apiKey in ~/.openclaw/openclaw.json" >&2
  exit 1
fi

echo "Run ID: ${RUN_ID}"
echo "Scope: ${SCOPE}"
echo "Cases: ${CASES}"
echo "Output: ${OUT_DIR}"
echo "Replay mode/backend: ${REPLAY_MODE}/${REPLAY_BACKEND}"

HTTP_LAST_CODE=""

sleep_ms() {
  perl -e "select(undef, undef, undef, ($1)/1000)"
}

ensure_mode() {
  case "$1" in
    simulate|strict|guided) return 0 ;;
    *) return 1 ;;
  esac
}

if ! ensure_mode "$REPLAY_MODE"; then
  echo "REPLAY_MODE must be one of: simulate|strict|guided" >&2
  exit 1
fi

http_post() {
  local path="$1"
  local payload="$2"
  local out_file="$3"
  local attempt http_code sleep_for_ms
  for attempt in $(seq 1 "$HTTP_RETRIES"); do
    http_code="$(curl -sS -m "$TIMEOUT_SECONDS" -o "$out_file" -w "%{http_code}" \
      -H "content-type: application/json" \
      -H "x-api-key: ${API_KEY}" \
      -H "x-tenant-id: ${TENANT_ID}" \
      -X POST "${BASE_URL%/}${path}" \
      --data "$payload" || true)"
    HTTP_LAST_CODE="$http_code"

    if [[ "$http_code" =~ ^[0-9]+$ ]] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      return 0
    fi

    # Handle write rate limits with bounded backoff.
    if [ "$http_code" = "429" ] && [ "$attempt" -lt "$HTTP_RETRIES" ]; then
      sleep_for_ms="$(jq -r '.details.retry_after_ms // 200' "$out_file" 2>/dev/null || echo 200)"
      if ! [[ "$sleep_for_ms" =~ ^[0-9]+$ ]]; then
        sleep_for_ms=200
      fi
      sleep_ms "$((sleep_for_ms + (attempt * 80)))"
      continue
    fi

    # Retry on transient gateway/service errors.
    if { [ "$http_code" = "502" ] || [ "$http_code" = "503" ] || [ "$http_code" = "504" ]; } \
      && [ "$attempt" -lt "$HTTP_RETRIES" ]; then
      sleep_ms "$((attempt * 120))"
      continue
    fi

    break
  done

  echo "HTTP error ${HTTP_LAST_CODE} on ${path}" >&2
  cat "$out_file" >&2 2>/dev/null || true
  return 1
}

extract_status() {
  jq -r '.run.status // .status // .run_status // .result.status // .summary.replay_readiness // "unknown"'
}

extract_run_id() {
  jq -r '.run.run_id // .run_id // .replay_run_id // .result.run_id // ""'
}

extract_total_tokens() {
  jq -r '
    [
      .usage.total_tokens,
      .usage.total,
      .compile_summary.usage_estimate.total_tokens,
      .compile_summary.usage_estimate.total,
      .result.usage.total_tokens,
      .result.usage.total,
      .summary.usage.total_tokens,
      .summary.usage.total,
      .run.usage.total_tokens,
      .run.usage.total,
      .run.metrics.total_tokens,
      .run.metrics.tokens_total,
      .metrics.total_tokens,
      .metrics.tokens_total,
      .meta.usage.total_tokens,
      .meta.usage.total,
      .agentMeta.lastCallUsage.total,
      .agentMeta.usage.total
    ]
    | map(select(type=="number"))
    | if length > 0 then .[0] else -1 end
  '
}

safe_text() {
  tr '\n' ' ' | sed 's/[[:space:]]\+/ /g' | cut -c1-220
}

run_step() {
  local case_scope="$1"
  local run_id="$2"
  local step_index="$3"
  local argv_json="$4"
  shift 4

  local before_payload before_json step_id attempt
  before_payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg actor "openclaw-benchmark" \
    --arg run_id "$run_id" \
    --argjson step_index "$step_index" \
    --arg tool "command" \
    --argjson argv "$argv_json" \
    '{
      tenant_id:$tenant,
      scope:$scope,
      actor:$actor,
      run_id:$run_id,
      step_index:$step_index,
      tool_name:$tool,
      tool_input:{argv:$argv},
      safety_level:"auto_ok",
      metadata:{source:"workflow-benchmark"}
    }')"
  before_json="$(mktemp)"
  for attempt in $(seq 1 "$STEP_BEFORE_RETRIES"); do
    if http_post "/v1/memory/replay/step/before" "$before_payload" "$before_json"; then
      break
    fi
    if [ "$attempt" -lt "$STEP_BEFORE_RETRIES" ] \
      && [ "$HTTP_LAST_CODE" = "404" ] \
      && jq -e '.error=="replay_run_not_found"' "$before_json" >/dev/null 2>&1; then
      sleep_ms "$((CONSISTENCY_BACKOFF_MS * attempt))"
      continue
    fi
    rm -f "$before_json"
    return 1
  done
  step_id="$(jq -r '.step_id // .step.step_id // ""' "$before_json")"
  rm -f "$before_json"

  local cmd_out cmd_rc
  cmd_out="$(mktemp)"
  if "$@" >"$cmd_out" 2>&1; then
    cmd_rc=0
  else
    cmd_rc=$?
  fi

  local output_sig status after_payload after_json
  output_sig="$(jq -cn \
    --argjson exit_code "$cmd_rc" \
    --arg stdout_preview "$(cat "$cmd_out" | safe_text)" \
    '{exit_code:$exit_code, stdout_preview:$stdout_preview}')"
  if [ "$cmd_rc" -eq 0 ]; then
    status="success"
  else
    status="failed"
  fi

  after_payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg actor "openclaw-benchmark" \
    --arg run_id "$run_id" \
    --arg step_id "$step_id" \
    --arg status "$status" \
    --argjson step_index "$step_index" \
    --argjson output_signature "$output_sig" \
    --arg error "$(cat "$cmd_out" | safe_text)" \
    '{
      tenant_id:$tenant,
      scope:$scope,
      actor:$actor,
      run_id:$run_id,
      step_index:$step_index,
      status:$status,
      output_signature:$output_signature,
      metadata:{source:"workflow-benchmark"}
    }
    + (if $step_id=="" then {} else {step_id:$step_id} end)
    + (if $status=="failed" then {error:$error} else {} end)
    ')"
  after_json="$(mktemp)"
  http_post "/v1/memory/replay/step/after" "$after_payload" "$after_json" >/dev/null 2>&1 || true
  rm -f "$after_json" "$cmd_out"

  return "$cmd_rc"
}

verify_case_state() {
  local case_dir="$1"
  local case_index="$2"
  local expected_sha="$3"
  local summary_file="${case_dir}/state/summary.txt"
  local sha_file="${case_dir}/state/summary.sha1"
  local pkg_file="${case_dir}/state-package.tgz"
  [ -f "$summary_file" ] || return 1
  [ -f "$sha_file" ] || return 1
  [ -f "$pkg_file" ] || return 1
  local got_sha
  got_sha="$(shasum "$summary_file" | awk '{print $1}')"
  local file_sha
  file_sha="$(tr -d ' \n\r' <"$sha_file")"
  [ "$got_sha" = "$expected_sha" ] || return 1
  [ "$file_sha" = "$expected_sha" ] || return 1
  grep -q "^case=${case_index}$" "$summary_file"
}

run_replay() {
  local case_scope="$1"
  local playbook_id="$2"
  local out_json="$3"
  local payload attempt
  payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg actor "openclaw-benchmark" \
    --arg playbook_id "$playbook_id" \
    --arg mode "$REPLAY_MODE" \
    --arg backend "$REPLAY_BACKEND" \
    '{
      tenant_id:$tenant,
      scope:$scope,
      actor:$actor,
      playbook_id:$playbook_id,
      mode:$mode,
      params:{
        execution_backend:$backend,
        sensitive_review_mode:"warn",
        allow_local_exec:true,
        allow_sensitive_exec:false,
        benchmark:true,
        workdir:"/tmp"
      },
      max_steps:50
    }')"
  for attempt in $(seq 1 "$REPLAY_RETRIES"); do
    if http_post "/v1/memory/replay/playbooks/run" "$payload" "$out_json"; then
      return 0
    fi
    if [ "$attempt" -lt "$REPLAY_RETRIES" ] \
      && [ "$HTTP_LAST_CODE" = "404" ] \
      && jq -e '.error=="replay_playbook_not_found" or .error=="replay_run_not_found"' "$out_json" >/dev/null 2>&1; then
      sleep_ms "$((attempt * 120))"
      continue
    fi
    return 1
  done
  return 1
}

wait_run_visible() {
  local case_scope="$1"
  local run_id="$2"
  local out_json="$3"
  local payload attempt
  payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg run_id "$run_id" \
    '{
      tenant_id:$tenant,
      scope:$scope,
      run_id:$run_id,
      include_steps:false,
      include_artifacts:false
    }')"
  for attempt in $(seq 1 "$RUN_VISIBILITY_RETRIES"); do
    if http_post "/v1/memory/replay/runs/get" "$payload" "$out_json"; then
      return 0
    fi
    if [ "$attempt" -lt "$RUN_VISIBILITY_RETRIES" ] \
      && [ "$HTTP_LAST_CODE" = "404" ] \
      && jq -e '.error=="replay_run_not_found"' "$out_json" >/dev/null 2>&1; then
      sleep_ms "$((CONSISTENCY_BACKOFF_MS * attempt))"
      continue
    fi
    return 1
  done
  return 1
}

wait_playbook_visible() {
  local case_scope="$1"
  local playbook_id="$2"
  local out_json="$3"
  local payload attempt
  payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg playbook_id "$playbook_id" \
    '{
      tenant_id:$tenant,
      scope:$scope,
      playbook_id:$playbook_id
    }')"
  for attempt in $(seq 1 "$PLAYBOOK_VISIBILITY_RETRIES"); do
    if http_post "/v1/memory/replay/playbooks/get" "$payload" "$out_json"; then
      return 0
    fi
    if [ "$attempt" -lt "$PLAYBOOK_VISIBILITY_RETRIES" ] \
      && [ "$HTTP_LAST_CODE" = "404" ] \
      && jq -e '.error=="replay_playbook_not_found"' "$out_json" >/dev/null 2>&1; then
      sleep_ms "$((CONSISTENCY_BACKOFF_MS * attempt))"
      continue
    fi
    return 1
  done
  return 1
}

for i in $(seq 1 "$CASES"); do
  case_dir="${BENCH_ROOT}/case-$(printf '%02d' "$i")"
  rm -rf "$case_dir"

  # Baseline deterministic expectation
  expected_sha="$(printf 'service=aionis-bench\ncase=%s\nenv_lines=3\n' "$i" | shasum | awk '{print $1}')"

  run_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  case_scope="${SCOPE}-case-$(printf '%02d' "$i")"

  run_start_payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg actor "openclaw-benchmark" \
    --arg run_id "$run_id" \
    --arg goal "Configure local service files and package artifacts (case ${i})" \
    --arg case_dir "$case_dir" \
    '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,goal:$goal,metadata:{benchmark:"workflow-replay",case_dir:$case_dir}}')"
  run_start_json="$(mktemp)"
  run_start_ok=1
  if ! http_post "/v1/memory/replay/run/start" "$run_start_payload" "$run_start_json"; then
    run_start_ok=0
  fi
  started_run_id="$(jq -r '.run_id // .run.run_id // empty' "$run_start_json" 2>/dev/null || true)"
  rm -f "$run_start_json"
  if [ -z "$started_run_id" ]; then
    started_run_id="$run_id"
  fi
  if [ "$run_start_ok" -eq 1 ]; then
    run_get_json="$(mktemp)"
    if ! wait_run_visible "$case_scope" "$started_run_id" "$run_get_json"; then
      run_start_ok=0
    fi
    rm -f "$run_get_json"
  fi

  t0="$(now_ms)"
  baseline_ok="$run_start_ok"

  argv1="$(jq -cn --arg a "${case_dir}/config" --arg b "${case_dir}/state" '["mkdir","-p",$a,$b]')"
  run_step "$case_scope" "$started_run_id" 1 "$argv1" mkdir -p "${case_dir}/config" "${case_dir}/state" || baseline_ok=0

  cmd2="printf '%s\n' 'APP_NAME=aionis-bench' 'APP_PORT=808${i}' 'LOG_LEVEL=info' > '${case_dir}/config/.env'"
  argv2="$(jq -cn --arg c "$cmd2" '["sh","-lc",$c]')"
  [ "$baseline_ok" -eq 1 ] && run_step "$case_scope" "$started_run_id" 2 "$argv2" sh -lc "$cmd2" || baseline_ok=0

  cmd3="printf '%s\n' '{\"service\":\"aionis-bench\",\"retries\":3,\"case\":${i}}' > '${case_dir}/config/settings.json'"
  argv3="$(jq -cn --arg c "$cmd3" '["sh","-lc",$c]')"
  [ "$baseline_ok" -eq 1 ] && run_step "$case_scope" "$started_run_id" 3 "$argv3" sh -lc "$cmd3" || baseline_ok=0

  cmd4="env_lines=\$(wc -l < '${case_dir}/config/.env' | tr -d ' '); printf 'service=aionis-bench\ncase=${i}\nenv_lines=%s\n' \"\$env_lines\" > '${case_dir}/state/summary.txt'"
  argv4="$(jq -cn --arg c "$cmd4" '["sh","-lc",$c]')"
  [ "$baseline_ok" -eq 1 ] && run_step "$case_scope" "$started_run_id" 4 "$argv4" sh -lc "$cmd4" || baseline_ok=0

  cmd5="shasum '${case_dir}/state/summary.txt' | awk '{print \$1}' > '${case_dir}/state/summary.sha1'"
  argv5="$(jq -cn --arg c "$cmd5" '["sh","-lc",$c]')"
  [ "$baseline_ok" -eq 1 ] && run_step "$case_scope" "$started_run_id" 5 "$argv5" sh -lc "$cmd5" || baseline_ok=0

  cmd6="cd '${case_dir}' && tar -czf state-package.tgz config state"
  argv6="$(jq -cn --arg c "$cmd6" '["sh","-lc",$c]')"
  [ "$baseline_ok" -eq 1 ] && run_step "$case_scope" "$started_run_id" 6 "$argv6" sh -lc "$cmd6" || baseline_ok=0

  t1="$(now_ms)"
  baseline_ms=$((t1 - t0))

  end_status="success"
  if [ "$baseline_ok" -ne 1 ]; then
    end_status="failed"
  fi

  run_end_payload="$(jq -cn \
    --arg tenant "$TENANT_ID" \
    --arg scope "$case_scope" \
    --arg actor "openclaw-benchmark" \
    --arg run_id "$started_run_id" \
    --arg status "$end_status" \
    --arg summary "workflow baseline execution" \
    --argjson baseline_ms "$baseline_ms" \
    '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,status:$status,summary:$summary,metrics:{baseline_ms:$baseline_ms,steps:6},metadata:{benchmark:"workflow-replay"}}')"
  run_end_json="$(mktemp)"
  http_post "/v1/memory/replay/run/end" "$run_end_payload" "$run_end_json" >/dev/null 2>&1 || true
  rm -f "$run_end_json"

  compile_ok=0
  playbook_id=""
  compile_tokens=-1
  if [ "$baseline_ok" -eq 1 ]; then
    compile_attempt=1
    while [ "$compile_attempt" -le "$COMPILE_RETRIES" ] && [ "$compile_ok" -ne 1 ]; do
      compile_payload="$(jq -cn \
        --arg tenant "$TENANT_ID" \
        --arg scope "$case_scope" \
        --arg actor "openclaw-benchmark" \
        --arg run_id "$started_run_id" \
        --arg name "workflow-replay-case-${i}-${RUN_ID}" \
        '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,name:$name,risk_profile:"low",allow_partial:false,metadata:{benchmark:"workflow-replay"}}')"
      compile_json="$(mktemp)"
      if http_post "/v1/memory/replay/playbooks/compile_from_run" "$compile_payload" "$compile_json"; then
        compile_tokens="$(extract_total_tokens <"$compile_json")"
        playbook_id="$(jq -r '.playbook_id // .playbook.playbook_id // empty' "$compile_json")"
        if [ -n "$playbook_id" ]; then
          playbook_get_json="$(mktemp)"
          if wait_playbook_visible "$case_scope" "$playbook_id" "$playbook_get_json"; then
            compile_ok=1
          fi
          rm -f "$playbook_get_json"
        fi
      fi
      rm -f "$compile_json"
      if [ "$compile_ok" -ne 1 ] && [ "$compile_attempt" -lt "$COMPILE_RETRIES" ]; then
        sleep_ms "$((CONSISTENCY_BACKOFF_MS * compile_attempt * 2))"
      fi
      compile_attempt=$((compile_attempt + 1))
    done
  fi

  baseline_tokens=0
  replay1_status="skipped"
  replay1_reason=""
  replay1_ms=-1
  replay1_verify=0
  replay1_tokens=-1
  replay2_status="skipped"
  replay2_reason=""
  replay2_ms=-1
  replay2_verify=0
  replay2_tokens=-1

  if [ "$compile_ok" -eq 1 ]; then
    r1_json="$(mktemp)"
    r1_start="$(now_ms)"
    if run_replay "$case_scope" "$playbook_id" "$r1_json"; then
      r1_end="$(now_ms)"
      replay1_ms=$((r1_end - r1_start))
      replay1_status="$(extract_status <"$r1_json")"
      replay1_reason="$(jq -r '.message // .error // .summary.error // .result.error // ""' "$r1_json" | safe_text)"
      replay1_tokens="$(extract_total_tokens <"$r1_json")"
      if verify_case_state "$case_dir" "$i" "$expected_sha"; then
        replay1_verify=1
      fi
    else
      replay1_status="error"
    fi
    rm -f "$r1_json"

    r2_json="$(mktemp)"
    r2_start="$(now_ms)"
    if run_replay "$case_scope" "$playbook_id" "$r2_json"; then
      r2_end="$(now_ms)"
      replay2_ms=$((r2_end - r2_start))
      replay2_status="$(extract_status <"$r2_json")"
      replay2_reason="$(jq -r '.message // .error // .summary.error // .result.error // ""' "$r2_json" | safe_text)"
      replay2_tokens="$(extract_total_tokens <"$r2_json")"
      if verify_case_state "$case_dir" "$i" "$expected_sha"; then
        replay2_verify=1
      fi
    else
      replay2_status="error"
    fi
    rm -f "$r2_json"
  fi

  jq -cn \
    --arg run_id "$RUN_ID" \
    --arg scope "$case_scope" \
    --arg case_dir "$case_dir" \
    --argjson case_index "$i" \
    --argjson baseline_ok "$baseline_ok" \
    --argjson baseline_ms "$baseline_ms" \
    --argjson baseline_tokens "$baseline_tokens" \
    --argjson compile_ok "$compile_ok" \
    --argjson compile_tokens "$compile_tokens" \
    --arg playbook_id "$playbook_id" \
    --arg replay1_status "$replay1_status" \
    --arg replay1_reason "$replay1_reason" \
    --argjson replay1_ms "$replay1_ms" \
    --argjson replay1_verify "$replay1_verify" \
    --argjson replay1_tokens "$replay1_tokens" \
    --arg replay2_status "$replay2_status" \
    --arg replay2_reason "$replay2_reason" \
    --argjson replay2_ms "$replay2_ms" \
    --argjson replay2_verify "$replay2_verify" \
    --argjson replay2_tokens "$replay2_tokens" \
    '{
      run_id:$run_id,
      case_index:$case_index,
      scope:$scope,
      case_dir:$case_dir,
      baseline_ok:$baseline_ok,
      baseline_ms:$baseline_ms,
      baseline_tokens:$baseline_tokens,
      compile_ok:$compile_ok,
      compile_tokens:$compile_tokens,
      playbook_id:$playbook_id,
      replay1_status:$replay1_status,
      replay1_reason:$replay1_reason,
      replay1_ms:$replay1_ms,
      replay1_verify:$replay1_verify,
      replay1_tokens:$replay1_tokens,
      replay2_status:$replay2_status,
      replay2_reason:$replay2_reason,
      replay2_ms:$replay2_ms,
      replay2_verify:$replay2_verify,
      replay2_tokens:$replay2_tokens
    }' >>"$RESULTS_JSONL"

  printf '[case %02d/%02d] baseline_ok=%d compile_ok=%d r1=%s(%sms,v=%d) r2=%s(%sms,v=%d)\n' \
    "$i" "$CASES" "$baseline_ok" "$compile_ok" \
    "$replay1_status" "$replay1_ms" "$replay1_verify" \
    "$replay2_status" "$replay2_ms" "$replay2_verify"
done

jq -s '
  def avg(a): if (a|length)==0 then 0 else ((a|add)/(a|length)) end;
  def avg_nonneg(a): avg(a|map(select(type=="number" and .>=0)));
  def r1_ok: map(select(.replay1_status=="success" and .replay1_verify==1));
  def r2_ok: map(select(.replay2_status=="success" and .replay2_verify==1));
  def c_ok: map(select(.compile_ok==1));
  def c_tok_ok: map(select(.compile_ok==1 and (.compile_tokens|type)=="number" and .compile_tokens>=0));
  def r1_tok_ok: map(select(.replay1_status=="success" and .replay1_verify==1 and (.replay1_tokens|type)=="number" and .replay1_tokens>=0));
  def r2_tok_ok: map(select(.replay2_status=="success" and .replay2_verify==1 and (.replay2_tokens|type)=="number" and .replay2_tokens>=0));
  {
    run_id: (.[0].run_id // ""),
    cases: length,
    baseline_success_rate: (100 * (map(select(.baseline_ok==1))|length) / length),
    compile_success_rate: (100 * (map(select(.compile_ok==1))|length) / length),
    replay1_success_rate: (100 * (r1_ok|length) / length),
    replay2_success_rate: (100 * (r2_ok|length) / length),
    replay_stability_rate: (
      100 * (map(select(.replay1_status=="success" and .replay2_status=="success" and .replay1_verify==1 and .replay2_verify==1))|length) / length
    ),
    avg_baseline_ms: avg(map(.baseline_ms)),
    avg_replay1_ms: avg(r1_ok|map(.replay1_ms)),
    avg_replay2_ms: avg(r2_ok|map(.replay2_ms)),
    replay2_vs_replay1_ms_delta: (avg(r2_ok|map(.replay2_ms)) - avg(r1_ok|map(.replay1_ms))),
    avg_baseline_tokens: avg_nonneg(map(.baseline_tokens)),
    avg_compile_tokens: avg_nonneg(c_tok_ok|map(.compile_tokens)),
    avg_replay1_tokens: avg_nonneg(r1_tok_ok|map(.replay1_tokens)),
    avg_replay2_tokens: avg_nonneg(r2_tok_ok|map(.replay2_tokens)),
    compile_token_coverage_rate: (100 * (c_tok_ok|length) / length),
    replay1_token_coverage_rate: (100 * (r1_tok_ok|length) / length),
    replay2_token_coverage_rate: (100 * (r2_tok_ok|length) / length),
    replay2_vs_replay1_token_delta: (avg_nonneg(r2_tok_ok|map(.replay2_tokens)) - avg_nonneg(r1_tok_ok|map(.replay1_tokens)))
  }
' "$RESULTS_JSONL" >"$SUMMARY_JSON"

cat >"$REPORT_MD" <<EOF
# Workflow Replay Benchmark

- run_id: ${RUN_ID}
- scope_prefix: ${SCOPE}
- cases: ${CASES}

## Summary

\`\`\`json
$(cat "$SUMMARY_JSON")
\`\`\`

## Files

- cases: ${RESULTS_JSONL}
- summary: ${SUMMARY_JSON}
EOF

echo
echo "Benchmark done."
echo "Summary:"
cat "$SUMMARY_JSON"
echo
echo "Report: $REPORT_MD"
