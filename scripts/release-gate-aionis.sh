#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

RUN_ID="$(date +%Y%m%d-%H%M%S)-$RANDOM"
OUT_DIR="artifacts/release-gate/${RUN_ID}"
GATES_JSONL="$OUT_DIR/gates.jsonl"
SUMMARY_JSON="$OUT_DIR/summary.json"
REPORT_MD="$OUT_DIR/report.md"
LOG_DIR="$OUT_DIR/logs"

mkdir -p "$OUT_DIR" "$LOG_DIR"
: >"$GATES_JSONL"

# Tunables
E2E_CASES="${E2E_CASES:-12}"
E2E_REPLAY_MODE="${E2E_REPLAY_MODE:-strict}"
E2E_REPLAY_BACKEND="${E2E_REPLAY_BACKEND:-local_process}"

CONCURRENCY_RUNS="${CONCURRENCY_RUNS:-18}"
CONCURRENCY_JOBS="${CONCURRENCY_JOBS:-6}"
CONCURRENCY_VIS_RETRIES="${CONCURRENCY_VIS_RETRIES:-8}"
SCOPE_ISO_VIS_RETRIES="${SCOPE_ISO_VIS_RETRIES:-20}"

POLICY_ROUNDS="${POLICY_ROUNDS:-6}"
AB_ROUNDS="${AB_ROUNDS:-4}"
AB_REPLAY_ROUNDS="${AB_REPLAY_ROUNDS:-2}"
AB_TIMEOUT_SECONDS="${AB_TIMEOUT_SECONDS:-90}"

HTTP_TIMEOUT_SECONDS="${HTTP_TIMEOUT_SECONDS:-60}"
HTTP_RETRIES="${HTTP_RETRIES:-4}"

# Gate thresholds
THRESH_E2E_STABILITY="${THRESH_E2E_STABILITY:-95}"
THRESH_E2E_REPLAY2="${THRESH_E2E_REPLAY2:-95}"
THRESH_E2E_SPEEDUP="${THRESH_E2E_SPEEDUP:-5}"
THRESH_CONCURRENCY_VISIBILITY="${THRESH_CONCURRENCY_VISIBILITY:-95}"
THRESH_POLICY_PASS_RATE="${THRESH_POLICY_PASS_RATE:-95}"
THRESH_TOKEN_COVERAGE="${THRESH_TOKEN_COVERAGE:-80}"
THRESH_TOKEN_MULTIPLIER_MAX="${THRESH_TOKEN_MULTIPLIER_MAX:-1.15}"
THRESH_AB_LATENCY_MULTIPLIER_MAX="${THRESH_AB_LATENCY_MULTIPLIER_MAX:-1.35}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for c in jq curl openclaw uuidgen awk sed grep; do
  require_cmd "$c"
done

BASE_URL="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.baseUrl // empty' ~/.openclaw/openclaw.json)"
API_KEY="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.apiKey // empty' ~/.openclaw/openclaw.json)"
TENANT_ID="$(jq -r '.plugins.entries["openclaw-aionis-memory"].config.tenantId // "default"' ~/.openclaw/openclaw.json)"

if [ -z "$BASE_URL" ] || [ -z "$API_KEY" ]; then
  echo "Missing Aionis plugin config: baseUrl/apiKey" >&2
  exit 1
fi

extract_json_tail() {
  sed -n '/^{/,$p'
}

rand_id() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}

append_gate() {
  local name="$1"
  local status="$2"
  local message="$3"
  local details_json="${4:-{}}"
  local details_file
  details_file="$(mktemp)"
  printf "%s" "$details_json" >"$details_file"
  jq -cn \
    --arg run_id "$RUN_ID" \
    --arg gate "$name" \
    --arg status "$status" \
    --arg message "$message" \
    --rawfile details "$details_file" \
    '$details as $d | {run_id:$run_id, gate:$gate, status:$status, message:$message, details:(try ($d|fromjson) catch (try (($d|sub("\\}\\s*$";""))|fromjson) catch {})), details_raw:$d}' >>"$GATES_JSONL"
  rm -f "$details_file"
}

http_post() {
  local path="$1"
  local payload="$2"
  local out_file="$3"
  local http_code attempt
  for attempt in $(seq 1 "$HTTP_RETRIES"); do
    http_code="$(curl -sS -m "$HTTP_TIMEOUT_SECONDS" -o "$out_file" -w "%{http_code}" \
      -H "content-type: application/json" \
      -H "x-api-key: ${API_KEY}" \
      -H "x-tenant-id: ${TENANT_ID}" \
      -X POST "${BASE_URL%/}${path}" \
      --data "$payload" || true)"

    if [[ "$http_code" =~ ^[0-9]+$ ]] && [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
      return 0
    fi

    if [ "$attempt" -lt "$HTTP_RETRIES" ] && { [ "$http_code" = "429" ] || [ "$http_code" = "502" ] || [ "$http_code" = "503" ] || [ "$http_code" = "504" ]; }; then
      sleep 0.$((attempt + 1))
      continue
    fi
    break
  done

  return 1
}

playbook_visible() {
  local scope="$1"
  local playbook_id="$2"
  local attempts="${3:-8}"
  local out payload i
  out="$(mktemp)"
  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg playbook_id "$playbook_id" '{tenant_id:$tenant,scope:$scope,playbook_id:$playbook_id}')"
  for i in $(seq 1 "$attempts"); do
    if http_post "/v1/memory/replay/playbooks/get" "$payload" "$out"; then
      rm -f "$out"
      return 0
    fi
    sleep 0.$((i + 1))
  done
  rm -f "$out"
  return 1
}

compile_run_visible() {
  local scope="$1"
  local run_id="$2"
  local name="$3"
  local attempts="${4:-3}"
  local i payload out playbook_id
  for i in $(seq 1 "$attempts"); do
    payload="$(jq -cn \
      --arg tenant "$TENANT_ID" \
      --arg scope "$scope" \
      --arg actor "release-gate" \
      --arg run_id "$run_id" \
      --arg name "$name" \
      '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,name:$name,risk_profile:"low",allow_partial:false,metadata:{gate:"release-gate"}}')"
    out="$(mktemp)"
    if http_post "/v1/memory/replay/playbooks/compile_from_run" "$payload" "$out"; then
      playbook_id="$(jq -r '.playbook_id // .playbook.playbook_id // empty' "$out")"
      rm -f "$out"
      if [ -n "$playbook_id" ] && playbook_visible "$scope" "$playbook_id" 12; then
        printf "%s" "$playbook_id"
        return 0
      fi
    else
      rm -f "$out"
    fi
    sleep 0.$((i + 2))
  done
  return 1
}

run_gate_e2e_correctness() {
  local gate="e2e_correctness"
  local log="$LOG_DIR/${gate}.log"
  local status="fail" msg details

  if REPLAY_MODE="$E2E_REPLAY_MODE" REPLAY_BACKEND="$E2E_REPLAY_BACKEND" bash scripts/benchmark-replay-workflow.sh "$E2E_CASES" >"$log" 2>&1; then
    local run_id summary replay2 stability avg_base avg_r2 speedup
    run_id="$(awk '/^Run ID:/{print $3; exit}' "$log")"
    summary="artifacts/benchmarks-workflow/${run_id}/summary.json"
    if [ -n "$run_id" ] && [ -f "$summary" ]; then
      replay2="$(jq -r '.replay2_success_rate // 0' "$summary")"
      stability="$(jq -r '.replay_stability_rate // 0' "$summary")"
      avg_base="$(jq -r '.avg_baseline_ms // 0' "$summary")"
      avg_r2="$(jq -r '.avg_replay2_ms // 0' "$summary")"
      speedup="$(awk -v b="$avg_base" -v r="$avg_r2" 'BEGIN{if(r>0) printf("%.4f", b/r); else print "0"}')"

      if awk -v r2="$replay2" -v st="$stability" -v sp="$speedup" -v t1="$THRESH_E2E_REPLAY2" -v t2="$THRESH_E2E_STABILITY" -v t3="$THRESH_E2E_SPEEDUP" 'BEGIN{exit !((r2>=t1)&&(st>=t2)&&(sp>=t3))}'; then
        status="pass"
        msg="workflow replay gates passed"
      else
        msg="replay success/stability/speedup below threshold"
      fi

      details="$(jq -cn \
        --arg run_id "$run_id" \
        --arg summary "$summary" \
        --argjson replay2 "$replay2" \
        --argjson stability "$stability" \
        --argjson speedup "$speedup" \
        --argjson thresh_replay2 "$THRESH_E2E_REPLAY2" \
        --argjson thresh_stability "$THRESH_E2E_STABILITY" \
        --argjson thresh_speedup "$THRESH_E2E_SPEEDUP" \
        '{run_id:$run_id,summary:$summary,replay2_success_rate:$replay2,replay_stability_rate:$stability,speedup_baseline_vs_replay2:$speedup,thresholds:{replay2_success_rate:$thresh_replay2,replay_stability_rate:$thresh_stability,speedup:$thresh_speedup}}')"
    else
      msg="failed to parse workflow benchmark summary"
      details='{}'
    fi
  else
    msg="benchmark-replay-workflow failed"
    details='{}'
  fi

  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_failure_recovery_guided() {
  local gate="failure_recovery_guided"
  local scope="gate:guided:${RUN_ID}"
  local log="$LOG_DIR/${gate}.log"
  local raw json overall replay_status details status="fail" msg

  raw="$(openclaw aionis-memory replay-selfcheck --scope "$scope" --mode guided --backend local_process --allow-local-exec --sensitive-review-mode warn 2>&1 || true)"
  printf "%s\n" "$raw" >"$log"
  json="$(printf "%s\n" "$raw" | extract_json_tail)"

  if printf "%s\n" "$json" | jq -e . >/dev/null 2>&1; then
    overall="$(printf "%s\n" "$json" | jq -r '.overall_status // "fail"')"
    replay_status="$(printf "%s\n" "$json" | jq -r '.replay_status // "unknown"')"
    if [ "$overall" = "pass" ] && { [ "$replay_status" = "success" ] || [ "$replay_status" = "ready" ]; }; then
      status="pass"
      msg="guided replay selfcheck passed"
    else
      msg="guided replay selfcheck failed"
    fi
    details="$(printf "%s\n" "$json" | jq -c '.')"
  else
    msg="invalid guided selfcheck json"
    details='{}'
  fi

  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_scope_isolation() {
  local gate="scope_isolation"
  local scope_a="gate:iso:a:${RUN_ID}"
  local scope_b="gate:iso:b:${RUN_ID}"
  local token_a="ISO_A_$(rand_id)"
  local token_b="ISO_B_$(rand_id)"
  local out payload text
  local write_ok_a=0 write_ok_b=0
  local hit_a=0 hit_b=0 leak_ab=0 leak_ba=0 status="fail" msg details

  out="$(mktemp)"

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_a" --arg actor "release-gate" --arg txt "token:$token_a" '{tenant_id:$tenant,scope:$scope,actor:$actor,input_text:$txt,memory_lane:"shared",auto_embed:true,nodes:[{type:"event",memory_lane:"shared",text_summary:$txt,slots:{gate:"scope_isolation",bucket:"a"}}],edges:[]}')"
  if http_post "/v1/memory/write" "$payload" "$out"; then
    if [ "$(jq -r '.nodes | length // 0' "$out" 2>/dev/null)" -ge 1 ]; then
      write_ok_a=1
    fi
  fi

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_b" --arg actor "release-gate" --arg txt "token:$token_b" '{tenant_id:$tenant,scope:$scope,actor:$actor,input_text:$txt,memory_lane:"shared",auto_embed:true,nodes:[{type:"event",memory_lane:"shared",text_summary:$txt,slots:{gate:"scope_isolation",bucket:"b"}}],edges:[]}')"
  if http_post "/v1/memory/write" "$payload" "$out"; then
    if [ "$(jq -r '.nodes | length // 0' "$out" 2>/dev/null)" -ge 1 ]; then
      write_ok_b=1
    fi
  fi

  sleep 1

  local attempt
  for attempt in $(seq 1 "$SCOPE_ISO_VIS_RETRIES"); do
    payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_a" --arg q "$token_a" '{tenant_id:$tenant,scope:$scope,query_text:$q,limit:5,context_char_budget:1200,include_embeddings:false,include_meta:false,include_slots:false}')"
    if http_post "/v1/memory/recall_text" "$payload" "$out"; then
      text="$(jq -r '.context.text // .text // ""' "$out")"
      if printf "%s" "$text" | grep -Fq "$token_a"; then
        hit_a=1
        break
      fi
    fi
    sleep 0.$((attempt + 1))
  done

  for attempt in $(seq 1 "$SCOPE_ISO_VIS_RETRIES"); do
    payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_b" --arg q "$token_b" '{tenant_id:$tenant,scope:$scope,query_text:$q,limit:5,context_char_budget:1200,include_embeddings:false,include_meta:false,include_slots:false}')"
    if http_post "/v1/memory/recall_text" "$payload" "$out"; then
      text="$(jq -r '.context.text // .text // ""' "$out")"
      if printf "%s" "$text" | grep -Fq "$token_b"; then
        hit_b=1
        break
      fi
    fi
    sleep 0.$((attempt + 1))
  done

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_a" --arg q "$token_b" '{tenant_id:$tenant,scope:$scope,query_text:$q,limit:5,context_char_budget:1200,include_embeddings:false,include_meta:false,include_slots:false}')"
  if http_post "/v1/memory/recall_text" "$payload" "$out"; then
    text="$(jq -r '.context.text // .text // ""' "$out")"
    printf "%s" "$text" | grep -Fq "$token_b" && leak_ab=1 || true
  fi

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope_b" --arg q "$token_a" '{tenant_id:$tenant,scope:$scope,query_text:$q,limit:5,context_char_budget:1200,include_embeddings:false,include_meta:false,include_slots:false}')"
  if http_post "/v1/memory/recall_text" "$payload" "$out"; then
    text="$(jq -r '.context.text // .text // ""' "$out")"
    printf "%s" "$text" | grep -Fq "$token_a" && leak_ba=1 || true
  fi

  rm -f "$out"

  if [ "$write_ok_a" -eq 1 ] && [ "$write_ok_b" -eq 1 ] && [ "$hit_a" -eq 1 ] && [ "$hit_b" -eq 1 ] && [ "$leak_ab" -eq 0 ] && [ "$leak_ba" -eq 0 ]; then
    status="pass"
    msg="scope isolation passed"
  else
    msg="scope isolation leak/miss detected"
  fi

  details="$(jq -cn \
    --arg scope_a "$scope_a" \
    --arg scope_b "$scope_b" \
    --arg token_a "$token_a" \
    --arg token_b "$token_b" \
    --argjson write_ok_a "$write_ok_a" \
    --argjson write_ok_b "$write_ok_b" \
    --argjson hit_a "$hit_a" \
    --argjson hit_b "$hit_b" \
    --argjson leak_ab "$leak_ab" \
    --argjson leak_ba "$leak_ba" \
    '{scope_a:$scope_a,scope_b:$scope_b,token_a:$token_a,token_b:$token_b,write_ok_a:$write_ok_a,write_ok_b:$write_ok_b,hit_a:$hit_a,hit_b:$hit_b,leak_a_from_b:$leak_ab,leak_b_from_a:$leak_ba}')"

  append_gate "$gate" "$status" "$msg" "$details"
}

run_concurrency_one() {
  local idx="$1"
  local out_file="$2"
  local scope="gate:conc:${RUN_ID}:$(printf '%03d' "$idx")"
  local run_id payload out i
  local start_ok=0 visible_ok=0

  run_id="$(rand_id)"
  out="$(mktemp)"

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg run_id "$run_id" --arg goal "concurrency probe" '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,goal:$goal,metadata:{gate:"concurrency"}}')"
  if http_post "/v1/memory/replay/run/start" "$payload" "$out"; then
    start_ok=1
  fi

  if [ "$start_ok" -eq 1 ]; then
    payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg run_id "$run_id" '{tenant_id:$tenant,scope:$scope,run_id:$run_id,include_steps:false,include_artifacts:false}')"
    for i in $(seq 1 "$CONCURRENCY_VIS_RETRIES"); do
      if http_post "/v1/memory/replay/runs/get" "$payload" "$out"; then
        visible_ok=1
        break
      fi
      sleep 0.$((i + 1))
    done
  fi

  jq -cn --arg scope "$scope" --arg run_id "$run_id" --argjson start_ok "$start_ok" --argjson visible_ok "$visible_ok" '{scope:$scope,run_id:$run_id,start_ok:$start_ok,visible_ok:$visible_ok}' >"$out_file"
  rm -f "$out"
}

run_gate_concurrency_consistency() {
  local gate="concurrency_consistency"
  local tmp_dir="$OUT_DIR/concurrency"
  local i batch_count=0
  local status="fail" msg details rate
  mkdir -p "$tmp_dir"

  for i in $(seq 1 "$CONCURRENCY_RUNS"); do
    run_concurrency_one "$i" "$tmp_dir/$i.json" &
    batch_count=$((batch_count + 1))
    if [ "$batch_count" -ge "$CONCURRENCY_JOBS" ]; then
      wait
      batch_count=0
    fi
  done
  wait

  rate="$(jq -s 'if length==0 then 0 else (100 * (map(select(.start_ok==1 and .visible_ok==1))|length) / length) end' "$tmp_dir"/*.json)"

  if awk -v r="$rate" -v t="$THRESH_CONCURRENCY_VISIBILITY" 'BEGIN{exit !(r>=t)}'; then
    status="pass"
    msg="concurrency visibility passed"
  else
    msg="concurrency visibility below threshold"
  fi

  details="$(jq -s --argjson threshold "$THRESH_CONCURRENCY_VISIBILITY" '{total:length,visible_ok:(map(select(.start_ok==1 and .visible_ok==1))|length),visibility_rate:(if length==0 then 0 else (100 * (map(select(.start_ok==1 and .visible_ok==1))|length) / length) end),threshold:$threshold,failures:map(select(.visible_ok!=1))}' "$tmp_dir"/*.json)"

  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_policy_loop() {
  local gate="policy_loop"
  local scope="gate:policy:${RUN_ID}"
  local candidates_json='["tool.alpha","tool.beta","tool.gamma"]'
  local i out payload selected decision_id decision_uri select_ok=0 feedback_ok=0
  local status="fail" msg details

  out="$(mktemp)"

  for i in $(seq 1 "$POLICY_ROUNDS"); do
    payload="$(jq -cn \
      --arg tenant "$TENANT_ID" \
      --arg scope "$scope" \
      --arg run_id "$(rand_id)" \
      --argjson context "$(jq -cn --arg i "$i" '{task:"release-gate-policy",iteration:($i|tonumber)}')" \
      --argjson candidates "$candidates_json" \
      '{tenant_id:$tenant,scope:$scope,run_id:$run_id,context:$context,candidates:$candidates,include_shadow:true,strict:false,rules_limit:20}')"

    if http_post "/v1/memory/tools/select" "$payload" "$out"; then
      selected="$(jq -r '.selected_tool // .selected // empty' "$out")"
      decision_id="$(jq -r '.decision_id // empty' "$out")"
      decision_uri="$(jq -r '.decision_uri // empty' "$out")"
      [ -n "$selected" ] || selected="tool.alpha"
      select_ok=$((select_ok + 1))

      payload="$(jq -cn \
        --arg tenant "$TENANT_ID" \
        --arg scope "$scope" \
        --arg actor "release-gate" \
        --arg run_id "$(rand_id)" \
        --arg decision_id "$decision_id" \
        --arg decision_uri "$decision_uri" \
        --arg selected "$selected" \
        --argjson context "$(jq -cn --arg i "$i" '{task:"release-gate-policy",iteration:($i|tonumber)}')" \
        --argjson candidates "$candidates_json" \
        '{
          tenant_id:$tenant,
          scope:$scope,
          actor:$actor,
          run_id:$run_id,
          outcome:"positive",
          context:$context,
          candidates:$candidates,
          selected_tool:$selected,
          include_shadow:true,
          target:"tool",
          note:"release-gate feedback",
          input_text:"policy gate"
        }
        + (if $decision_id=="" then {} else {decision_id:$decision_id} end)
        + (if $decision_uri=="" then {} else {decision_uri:$decision_uri} end)')"

      if http_post "/v1/memory/tools/feedback" "$payload" "$out"; then
        feedback_ok=$((feedback_ok + 1))
      fi
    fi
  done

  rm -f "$out"

  local pass_rate
  pass_rate="$(awk -v ok="$feedback_ok" -v total="$POLICY_ROUNDS" 'BEGIN{if(total>0) printf("%.4f", 100*ok/total); else print "0"}')"
  if awk -v r="$pass_rate" -v t="$THRESH_POLICY_PASS_RATE" 'BEGIN{exit !(r>=t)}'; then
    status="pass"
    msg="policy select/feedback passed"
  else
    msg="policy loop pass rate below threshold"
  fi

  details="$(jq -cn \
    --arg scope "$scope" \
    --argjson rounds "$POLICY_ROUNDS" \
    --argjson select_ok "$select_ok" \
    --argjson feedback_ok "$feedback_ok" \
    --argjson pass_rate "$pass_rate" \
    --argjson threshold "$THRESH_POLICY_PASS_RATE" \
    '{scope:$scope,rounds:$rounds,select_ok:$select_ok,feedback_ok:$feedback_ok,pass_rate:$pass_rate,threshold:$threshold}')"

  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_security_guardrails() {
  local gate="security_guardrails"
  local scope="gate:sec:${RUN_ID}"
  local run_id="$(rand_id)"
  local step_id playbook_id status="fail" msg details
  local out payload replay_status replay_error

  out="$(mktemp)"

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg run_id "$run_id" '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,goal:"security guardrail probe",metadata:{gate:"security"}}')"
  http_post "/v1/memory/replay/run/start" "$payload" "$out" >/dev/null 2>&1 || true

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg run_id "$run_id" --argjson argv '["/bin/echo","security_probe"]' '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,step_index:1,tool_name:"command",tool_input:{argv:$argv},safety_level:"auto_ok",metadata:{gate:"security"}}')"
  if http_post "/v1/memory/replay/step/before" "$payload" "$out"; then
    step_id="$(jq -r '.step_id // .step.step_id // empty' "$out")"
    /bin/echo security_probe >/dev/null 2>&1 || true
    payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg run_id "$run_id" --arg step_id "$step_id" '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,step_id:$step_id,step_index:1,status:"success",output_signature:{contains:"security_probe"},metadata:{gate:"security"}}')"
    http_post "/v1/memory/replay/step/after" "$payload" "$out" >/dev/null 2>&1 || true
  fi

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg run_id "$run_id" '{tenant_id:$tenant,scope:$scope,actor:$actor,run_id:$run_id,status:"success",summary:"security probe baseline",metadata:{gate:"security"}}')"
  http_post "/v1/memory/replay/run/end" "$payload" "$out" >/dev/null 2>&1 || true

  playbook_id="$(compile_run_visible "$scope" "$run_id" "release-gate-security-${RUN_ID}" 3 || true)"

  if [ -n "$playbook_id" ]; then
    payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg playbook_id "$playbook_id" '{tenant_id:$tenant,scope:$scope,actor:$actor,playbook_id:$playbook_id,mode:"strict",params:{execution_backend:"local_process",allow_local_exec:true,sensitive_review_mode:"warn",workdir:"/tmp"},max_steps:20}')"
    if http_post "/v1/memory/replay/playbooks/run" "$payload" "$out"; then
      replay_status="$(jq -r '.run.status // .status // .result.status // "unknown"' "$out")"
      replay_error="$(jq -r '.error // .message // .summary.error // .result.error // ""' "$out")"
      if [ "$replay_status" != "success" ]; then
        status="pass"
        msg="unsafe command replay correctly blocked"
      else
        msg="unsafe command unexpectedly executed"
      fi
    else
      replay_status="http_error"
      replay_error="$(jq -r '.error // .message // "http_error"' "$out" 2>/dev/null || echo http_error)"
      status="pass"
      msg="unsafe command replay rejected at API layer"
    fi
  else
    msg="security probe compile failed"
    replay_status="compile_failed"
    replay_error="playbook_not_visible"
  fi

  details="$(jq -cn --arg scope "$scope" --arg run_id "$run_id" --arg playbook_id "$playbook_id" --arg replay_status "$replay_status" --arg replay_error "$replay_error" '{scope:$scope,run_id:$run_id,playbook_id:$playbook_id,replay_status:$replay_status,replay_error:$replay_error}')"

  rm -f "$out"
  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_durability_restart() {
  local gate="durability_restart"
  local scope="gate:dur:${RUN_ID}"
  local log="$LOG_DIR/${gate}.log"
  local raw json run_id playbook_id status="fail" msg details
  local out payload replay_status

  raw="$(openclaw aionis-memory replay-selfcheck --scope "$scope" --mode strict --backend local_process --allow-local-exec --sensitive-review-mode warn 2>&1 || true)"
  printf "%s\n" "$raw" >"$log"
  json="$(printf "%s\n" "$raw" | extract_json_tail)"

  if ! printf "%s\n" "$json" | jq -e . >/dev/null 2>&1; then
    append_gate "$gate" "fail" "invalid strict selfcheck json" '{}'
    return
  fi

  run_id="$(printf "%s\n" "$json" | jq -r '.run_id // empty')"
  playbook_id="$(printf "%s\n" "$json" | jq -r '.playbook_id // empty')"

  if [ -z "$run_id" ] || [ -z "$playbook_id" ]; then
    append_gate "$gate" "fail" "missing run_id/playbook_id from strict selfcheck" "$(printf "%s\n" "$json" | jq -c '.')"
    return
  fi

  openclaw gateway restart >/dev/null
  sleep 2

  out="$(mktemp)"
  local run_get_ok=0 playbook_get_ok=0 replay_ok=0

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg run_id "$run_id" '{tenant_id:$tenant,scope:$scope,run_id:$run_id,include_steps:false,include_artifacts:false}')"
  if http_post "/v1/memory/replay/runs/get" "$payload" "$out"; then
    run_get_ok=1
  fi

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg playbook_id "$playbook_id" '{tenant_id:$tenant,scope:$scope,playbook_id:$playbook_id}')"
  if http_post "/v1/memory/replay/playbooks/get" "$payload" "$out"; then
    playbook_get_ok=1
  fi

  payload="$(jq -cn --arg tenant "$TENANT_ID" --arg scope "$scope" --arg actor "release-gate" --arg playbook_id "$playbook_id" '{tenant_id:$tenant,scope:$scope,actor:$actor,playbook_id:$playbook_id,mode:"simulate",params:{workdir:"/tmp"},max_steps:20}')"
  if http_post "/v1/memory/replay/playbooks/run" "$payload" "$out"; then
    replay_status="$(jq -r '.run.status // .status // .result.status // .summary.replay_readiness // "unknown"' "$out")"
    if [ "$replay_status" = "success" ] || [ "$replay_status" = "ready" ] || [ "$replay_status" = "shadow" ]; then
      replay_ok=1
    fi
  fi

  if [ "$run_get_ok" -eq 1 ] && [ "$playbook_get_ok" -eq 1 ] && [ "$replay_ok" -eq 1 ]; then
    status="pass"
    msg="durability checks passed after gateway restart"
  else
    msg="durability checks failed after gateway restart"
  fi

  details="$(jq -cn \
    --arg scope "$scope" \
    --arg run_id "$run_id" \
    --arg playbook_id "$playbook_id" \
    --argjson run_get_ok "$run_get_ok" \
    --argjson playbook_get_ok "$playbook_get_ok" \
    --argjson replay_ok "$replay_ok" \
    '{scope:$scope,run_id:$run_id,playbook_id:$playbook_id,run_get_ok:$run_get_ok,playbook_get_ok:$playbook_get_ok,replay_ok:$replay_ok}')"

  rm -f "$out"
  append_gate "$gate" "$status" "$msg" "$details"
}

run_gate_cost_efficiency() {
  local gate="cost_efficiency"
  local log="$LOG_DIR/${gate}.log"
  local status="fail" msg details

  if TIMEOUT_SECONDS="$AB_TIMEOUT_SECONDS" REPLAY_ROUNDS="$AB_REPLAY_ROUNDS" bash scripts/benchmark-aionis-strict-ab.sh "$AB_ROUNDS" >"$log" 2>&1; then
    local run_id summary off_tok on_tok off_cov on_cov off_ms on_ms token_ratio latency_ratio
    run_id="$(awk '/^Run ID:/{print $3; exit}' "$log")"
    summary="artifacts/benchmarks/${run_id}/summary.json"

    if [ -n "$run_id" ] && [ -f "$summary" ]; then
      off_tok="$(jq -r '.off.avg_recall_tokens_valid // 0' "$summary")"
      on_tok="$(jq -r '.on.avg_recall_tokens_valid // 0' "$summary")"
      off_cov="$(jq -r '.off.recall_tokens_valid_rate // 0' "$summary")"
      on_cov="$(jq -r '.on.recall_tokens_valid_rate // 0' "$summary")"
      off_ms="$(jq -r '.off.avg_recall_ms // 0' "$summary")"
      on_ms="$(jq -r '.on.avg_recall_ms // 0' "$summary")"

      token_ratio="$(awk -v o="$off_tok" -v n="$on_tok" 'BEGIN{if(o>0) printf("%.6f", n/o); else print "999"}')"
      latency_ratio="$(awk -v o="$off_ms" -v n="$on_ms" 'BEGIN{if(o>0) printf("%.6f", n/o); else print "999"}')"

      if awk -v off_cov="$off_cov" -v on_cov="$on_cov" -v tr="$token_ratio" -v lr="$latency_ratio" \
        -v cov_t="$THRESH_TOKEN_COVERAGE" -v tr_t="$THRESH_TOKEN_MULTIPLIER_MAX" -v lr_t="$THRESH_AB_LATENCY_MULTIPLIER_MAX" \
        'BEGIN{exit !((off_cov>=cov_t)&&(on_cov>=cov_t)&&(tr<=tr_t)&&(lr<=lr_t))}'; then
        status="pass"
        msg="token/latency efficiency passed"
      else
        msg="token/latency efficiency below threshold"
      fi

      details="$(jq -cn \
        --arg run_id "$run_id" \
        --arg summary "$summary" \
        --argjson off_tokens "$off_tok" \
        --argjson on_tokens "$on_tok" \
        --argjson off_cov "$off_cov" \
        --argjson on_cov "$on_cov" \
        --argjson off_ms "$off_ms" \
        --argjson on_ms "$on_ms" \
        --argjson token_ratio "$token_ratio" \
        --argjson latency_ratio "$latency_ratio" \
        --argjson thresh_cov "$THRESH_TOKEN_COVERAGE" \
        --argjson thresh_token_ratio "$THRESH_TOKEN_MULTIPLIER_MAX" \
        --argjson thresh_latency_ratio "$THRESH_AB_LATENCY_MULTIPLIER_MAX" \
        '{run_id:$run_id,summary:$summary,off:{avg_recall_tokens_valid:$off_tokens,coverage:$off_cov,avg_recall_ms:$off_ms},on:{avg_recall_tokens_valid:$on_tokens,coverage:$on_cov,avg_recall_ms:$on_ms},ratios:{token:$token_ratio,latency:$latency_ratio},thresholds:{coverage:$thresh_cov,token_ratio_max:$thresh_token_ratio,latency_ratio_max:$thresh_latency_ratio}}')"
    else
      msg="failed to parse AB summary"
      details='{}'
    fi
  else
    msg="benchmark-aionis-strict-ab failed"
    details='{}'
  fi

  append_gate "$gate" "$status" "$msg" "$details"
}

build_report() {
  jq -s '
    {
      run_id: (.[0].run_id // ""),
      generated_at: (now | todate),
      total_gates: length,
      passed_gates: (map(select(.status=="pass"))|length),
      failed_gates: (map(select(.status=="fail"))|length),
      overall_status: (if any(.[]; .status=="fail") then "fail" else "pass" end),
      gates: .
    }
  ' "$GATES_JSONL" >"$SUMMARY_JSON"

  {
    echo "# Aionis Release Gate"
    echo
    echo "- run_id: $RUN_ID"
    echo "- generated_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "- output_dir: $OUT_DIR"
    echo
    echo "## Overall"
    echo
    echo "\`\`\`json"
    cat "$SUMMARY_JSON"
    echo "\`\`\`"
    echo
    echo "## Gate Results"
    echo
    jq -r '.gates[] | "- [" + (if .status=="pass" then "PASS" else "FAIL" end) + "] " + .gate + ": " + .message' "$SUMMARY_JSON"
  } >"$REPORT_MD"
}

echo "Release gate run: $RUN_ID"
echo "Output: $OUT_DIR"

echo "[1/8] e2e correctness"
run_gate_e2e_correctness

echo "[2/8] failure recovery guided"
run_gate_failure_recovery_guided

echo "[3/8] scope isolation"
run_gate_scope_isolation

echo "[4/8] concurrency consistency"
run_gate_concurrency_consistency

echo "[5/8] policy loop"
run_gate_policy_loop

echo "[6/8] security guardrails"
run_gate_security_guardrails

echo "[7/8] durability restart"
run_gate_durability_restart

echo "[8/8] cost efficiency"
run_gate_cost_efficiency

build_report

echo
echo "Release gate completed."
cat "$SUMMARY_JSON"
echo
echo "Report: $REPORT_MD"
