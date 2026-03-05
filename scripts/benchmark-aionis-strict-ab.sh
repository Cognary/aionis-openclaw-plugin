#!/usr/bin/env bash
set -euo pipefail

ROUNDS="${1:-20}"
REPLAY_ROUNDS="${REPLAY_ROUNDS:-5}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-60}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || [ "$ROUNDS" -le 0 ]; then
  echo "ROUNDS must be a positive integer" >&2
  exit 1
fi
if ! [[ "$REPLAY_ROUNDS" =~ ^[0-9]+$ ]] || [ "$REPLAY_ROUNDS" -le 0 ]; then
  echo "REPLAY_ROUNDS must be a positive integer" >&2
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd openclaw
require_cmd jq

RUN_ID="$(date +%Y%m%d-%H%M%S)-$RANDOM"
SCOPE="ab-strict-${RUN_ID}"
OUT_DIR="artifacts/benchmarks/${RUN_ID}"
mkdir -p "$OUT_DIR"

RESULTS_JSONL="${OUT_DIR}/ab-results.jsonl"
REPLAY_JSONL="${OUT_DIR}/replay-results.jsonl"
SUMMARY_JSON="${OUT_DIR}/summary.json"
REPORT_MD="${OUT_DIR}/report.md"

echo "Run ID: ${RUN_ID}"
echo "Scope:  ${SCOPE}"
echo "Output: ${OUT_DIR}"

get_cfg_or_missing() {
  local path="$1"
  local value
  if value="$(openclaw config get "$path" 2>/dev/null)"; then
    printf "%s" "$value"
  else
    printf "__MISSING__"
  fi
}

restore_cfg() {
  local path="$1"
  local value="$2"
  if [ "$value" = "__MISSING__" ]; then
    openclaw config unset "$path" >/dev/null 2>&1 || true
  else
    openclaw config set "$path" "$value" >/dev/null
  fi
}

ORIG_TOOLS_PROFILE="$(get_cfg_or_missing tools.profile)"
ORIG_SLOT_MEMORY="$(get_cfg_or_missing plugins.slots.memory)"
ORIG_AIONIS_ENABLED="$(get_cfg_or_missing plugins.entries.openclaw-aionis-memory.enabled)"
ORIG_SCOPE_MODE="$(get_cfg_or_missing plugins.entries.openclaw-aionis-memory.config.scopeMode)"
ORIG_SCOPE_VALUE="$(get_cfg_or_missing plugins.entries.openclaw-aionis-memory.config.scope)"

cleanup() {
  set +e
  echo
  echo "Restoring original OpenClaw config..."
  restore_cfg "tools.profile" "$ORIG_TOOLS_PROFILE"
  restore_cfg "plugins.entries.openclaw-aionis-memory.enabled" "$ORIG_AIONIS_ENABLED"
  restore_cfg "plugins.slots.memory" "$ORIG_SLOT_MEMORY"
  restore_cfg "plugins.entries.openclaw-aionis-memory.config.scopeMode" "$ORIG_SCOPE_MODE"
  restore_cfg "plugins.entries.openclaw-aionis-memory.config.scope" "$ORIG_SCOPE_VALUE"
  openclaw gateway restart >/dev/null 2>&1 || true
}
trap cleanup EXIT

set_profile_and_scope() {
  openclaw config set tools.profile coding >/dev/null
  openclaw config set plugins.entries.openclaw-aionis-memory.config.scopeMode fixed >/dev/null
  openclaw config set plugins.entries.openclaw-aionis-memory.config.scope "$SCOPE" >/dev/null
}

set_phase_off() {
  openclaw config set plugins.entries.openclaw-aionis-memory.enabled false >/dev/null
  openclaw config set plugins.slots.memory none >/dev/null
  openclaw gateway restart >/dev/null
}

set_phase_on() {
  openclaw config set plugins.entries.openclaw-aionis-memory.enabled true >/dev/null
  openclaw config set plugins.slots.memory openclaw-aionis-memory >/dev/null
  openclaw gateway restart >/dev/null
}

extract_json_tail() {
  sed -n '/^{/,$p'
}

agent_call_json() {
  local session_id="$1"
  local message="$2"
  local out_file="$3"
  local raw
  if ! raw="$(openclaw agent --session-id "$session_id" --message "$message" --timeout "$TIMEOUT_SECONDS" --json 2>&1)"; then
    printf '{"status":"error","error":"agent command failed"}\n' >"$out_file"
    return 1
  fi
  printf "%s\n" "$raw" | extract_json_tail >"$out_file"
  if ! jq -e . "$out_file" >/dev/null 2>&1; then
    printf '{"status":"error","error":"invalid json tail"}\n' >"$out_file"
    return 1
  fi
  return 0
}

append_result() {
  local phase="$1"
  local round="$2"
  local token="$3"
  local remember_text="$4"
  local recall_text="$5"
  local remember_ms="$6"
  local recall_ms="$7"
  local remember_tokens="$8"
  local recall_tokens="$9"
  local match="${10}"

  jq -cn \
    --arg run_id "$RUN_ID" \
    --arg scope "$SCOPE" \
    --arg phase "$phase" \
    --argjson round "$round" \
    --arg token "$token" \
    --arg remember_text "$remember_text" \
    --arg recall_text "$recall_text" \
    --argjson remember_duration_ms "$remember_ms" \
    --argjson recall_duration_ms "$recall_ms" \
    --argjson remember_total_tokens "$remember_tokens" \
    --argjson recall_total_tokens "$recall_tokens" \
    --argjson match "$match" \
    '{
      run_id: $run_id,
      scope: $scope,
      phase: $phase,
      round: $round,
      token: $token,
      remember_text: $remember_text,
      recall_text: $recall_text,
      remember_duration_ms: $remember_duration_ms,
      recall_duration_ms: $recall_duration_ms,
      remember_total_tokens: $remember_total_tokens,
      recall_total_tokens: $recall_total_tokens,
      match: $match
    }' >>"$RESULTS_JSONL"
}

run_phase() {
  local phase="$1"
  local token_prefix="$2"
  local session_prefix="$3"
  local i token rand sid1 sid2
  local c1_json c2_json
  local remember_text recall_text remember_ms recall_ms remember_tok recall_tok match

  echo
  echo "=== Phase: ${phase} ==="
  for i in $(seq 1 "$ROUNDS"); do
    rand="$(uuidgen | tr -d '-' | cut -c1-10)"
    token="${token_prefix}_${i}_${rand}_Z9Q"
    sid1="${session_prefix}-${i}-s1"
    sid2="${session_prefix}-${i}-s2"
    c1_json="$(mktemp)"
    c2_json="$(mktemp)"

    agent_call_json "$sid1" "请严格记住口令：${token}。只回复ok，不要解释。" "$c1_json" || true
    agent_call_json "$sid2" "请只回复你在另一个会话里记录的口令，必须完全一致（前缀 ${token_prefix}_，后缀 _Z9Q）。不要解释。" "$c2_json" || true

    remember_text="$(jq -r '.result.payloads[0].text // .error // ""' "$c1_json" | tr '\n' ' ')"
    recall_text="$(jq -r '.result.payloads[0].text // .error // ""' "$c2_json" | tr '\n' ' ')"
    remember_ms="$(jq -r '.result.meta.durationMs // -1' "$c1_json")"
    recall_ms="$(jq -r '.result.meta.durationMs // -1' "$c2_json")"
    remember_tok="$(jq -r '.result.meta.agentMeta.lastCallUsage.total // .result.meta.agentMeta.usage.total // -1' "$c1_json")"
    recall_tok="$(jq -r '.result.meta.agentMeta.lastCallUsage.total // .result.meta.agentMeta.usage.total // -1' "$c2_json")"

    if [ "$recall_text" = "$token" ]; then
      match=1
    else
      match=0
    fi

    append_result "$phase" "$i" "$token" "$remember_text" "$recall_text" \
      "$remember_ms" "$recall_ms" "$remember_tok" "$recall_tok" "$match"

    printf '[%s] round %02d/%02d | match=%d | recall_ms=%s | recall_tokens=%s\n' \
      "$phase" "$i" "$ROUNDS" "$match" "$recall_ms" "$recall_tok"

    rm -f "$c1_json" "$c2_json"
  done
}

run_replay_checks() {
  local i start_s elapsed_s raw json_tail status replay_status
  echo
  echo "=== Replay Selfcheck (${REPLAY_ROUNDS} rounds) ==="
  for i in $(seq 1 "$REPLAY_ROUNDS"); do
    start_s="$SECONDS"
    raw="$(openclaw aionis-memory replay-selfcheck --scope "$SCOPE" --mode simulate 2>&1 || true)"
    elapsed_s=$((SECONDS - start_s))
    json_tail="$(printf "%s\n" "$raw" | extract_json_tail)"
    if printf "%s\n" "$json_tail" | jq -e . >/dev/null 2>&1; then
      status="$(printf "%s\n" "$json_tail" | jq -r '.overall_status // "error"')"
      replay_status="$(printf "%s\n" "$json_tail" | jq -r '.replay_status // "unknown"')"
    else
      status="error"
      replay_status="invalid-json"
    fi

    jq -cn \
      --arg run_id "$RUN_ID" \
      --arg scope "$SCOPE" \
      --argjson round "$i" \
      --arg status "$status" \
      --arg replay_status "$replay_status" \
      --argjson elapsed_s "$elapsed_s" \
      '{
        run_id: $run_id,
        scope: $scope,
        round: $round,
        status: $status,
        replay_status: $replay_status,
        elapsed_s: $elapsed_s
      }' >>"$REPLAY_JSONL"

    printf '[replay] round %02d/%02d | status=%s | replay_status=%s | elapsed_s=%s\n' \
      "$i" "$REPLAY_ROUNDS" "$status" "$replay_status" "$elapsed_s"
  done
}

build_summary() {
  jq -s --slurpfile replay "$REPLAY_JSONL" '
    def nums(a): a | map(select(type=="number"));
    def nums_nonneg(a): nums(a) | map(select(. >= 0));
    def avg(a): (nums(a)) as $n | if ($n|length)==0 then 0 else (($n|add) / ($n|length)) end;
    def avg_nonneg(a): (nums_nonneg(a)) as $n | if ($n|length)==0 then 0 else (($n|add) / ($n|length)) end;
    def valid_rate(a): (nums(a)) as $n | if ($n|length)==0 then 0 else (100 * (($n|map(select(. >= 0))|length) / ($n|length))) end;
    def phase_stats(p):
      (map(select(.phase==p))) as $r
      | {
          rounds: ($r|length),
          matches: ($r|map(.match)|add // 0),
          match_rate: (if ($r|length)==0 then 0 else (100 * (($r|map(.match)|add // 0) / ($r|length))) end),
          avg_recall_ms: avg($r|map(.recall_duration_ms)),
          avg_recall_tokens: avg($r|map(.recall_total_tokens)),
          avg_recall_tokens_valid: avg_nonneg($r|map(.recall_total_tokens)),
          recall_tokens_valid_rate: valid_rate($r|map(.recall_total_tokens)),
          avg_remember_tokens: avg($r|map(.remember_total_tokens)),
          avg_remember_tokens_valid: avg_nonneg($r|map(.remember_total_tokens)),
          remember_tokens_valid_rate: valid_rate($r|map(.remember_total_tokens))
        };
    def replay_stats(items):
      (items | map(select(type=="object"))) as $x
      | {
          rounds: ($x|length),
          pass_count: ($x|map(select(.status=="pass"))|length),
          pass_rate: (if ($x|length)==0 then 0 else (100 * (($x|map(select(.status=="pass"))|length) / ($x|length))) end),
          avg_elapsed_s: avg($x|map(.elapsed_s))
        };

    (phase_stats("off")) as $off
    | (phase_stats("on")) as $on
    | ($replay // []) as $rp
    | {
        run_id: (.[0].run_id // ""),
        scope: (.[0].scope // ""),
        rounds_per_phase: ($off.rounds),
        off: $off,
        on: $on,
        delta_match_rate_pp: ($on.match_rate - $off.match_rate),
        delta_avg_recall_ms: ($on.avg_recall_ms - $off.avg_recall_ms),
        replay: replay_stats($rp)
      }
  ' "$RESULTS_JSONL" >"$SUMMARY_JSON"
}

build_report() {
  local off_match on_match delta replay_pass
  local off_recall_tok_valid on_recall_tok_valid
  local off_recall_tok_cov on_recall_tok_cov
  off_match="$(jq -r '.off.match_rate' "$SUMMARY_JSON")"
  on_match="$(jq -r '.on.match_rate' "$SUMMARY_JSON")"
  delta="$(jq -r '.delta_match_rate_pp' "$SUMMARY_JSON")"
  replay_pass="$(jq -r '.replay.pass_rate' "$SUMMARY_JSON")"
  off_recall_tok_valid="$(jq -r '.off.avg_recall_tokens_valid' "$SUMMARY_JSON")"
  on_recall_tok_valid="$(jq -r '.on.avg_recall_tokens_valid' "$SUMMARY_JSON")"
  off_recall_tok_cov="$(jq -r '.off.recall_tokens_valid_rate' "$SUMMARY_JSON")"
  on_recall_tok_cov="$(jq -r '.on.recall_tokens_valid_rate' "$SUMMARY_JSON")"

  cat >"$REPORT_MD" <<EOF
# Aionis Strict AB Benchmark

- run_id: ${RUN_ID}
- scope: ${SCOPE}
- rounds_per_phase: ${ROUNDS}
- replay_rounds: ${REPLAY_ROUNDS}

## Result

- OFF (Aionis disabled) match_rate: ${off_match}%
- ON  (Aionis enabled)  match_rate: ${on_match}%
- Delta match_rate: ${delta} pp
- OFF avg_recall_tokens_valid: ${off_recall_tok_valid} (coverage ${off_recall_tok_cov}%)
- ON  avg_recall_tokens_valid: ${on_recall_tok_valid} (coverage ${on_recall_tok_cov}%)
- Replay selfcheck pass_rate: ${replay_pass}%

## Files

- raw rounds: \`${RESULTS_JSONL}\`
- replay rounds: \`${REPLAY_JSONL}\`
- summary: \`${SUMMARY_JSON}\`
EOF
}

echo
echo "Preparing strict test config..."
set_profile_and_scope

set_phase_off
run_phase "off" "ABOFF_${RUN_ID}" "aboff-${RUN_ID}"

set_phase_on
openclaw aionis-memory health >/dev/null
run_phase "on" "ABON_${RUN_ID}" "abon-${RUN_ID}"
run_replay_checks

build_summary
build_report

echo
echo "Benchmark complete."
echo "Summary:"
cat "$SUMMARY_JSON"
echo
echo "Report: ${REPORT_MD}"
