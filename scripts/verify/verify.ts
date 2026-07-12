import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "../deploy/preflight.js";
import {
  copyFileToRemote,
  prepareRemoteTransport,
  runRemoteScript,
  workspaceRoot,
} from "../deploy/remote.js";

type VerificationSuite = "all" | "isolation" | "lifecycle" | "recovery";
type JsonRecord = Record<string, unknown>;

const localReportPath = resolve(
  workspaceRoot,
  "artifacts/reports/phase-6-verification-summary.json",
);
const phase3ReportPath = resolve(workspaceRoot, "artifacts/reports/phase-3-remote-e2e.json");

const remoteVerificationScript = String.raw`set -Eeuo pipefail
workdir=$1
suite=$2
verify_stage=initialization
trap 'printf "VERIFY_REMOTE_FAILED_STAGE=%s\n" "$verify_stage"' ERR
case "$workdir" in /*) ;; *) exit 20 ;; esac
test "$(cat "$workdir/.agentnest-project")" = agentnest-demo
source_dir="$workdir/source"
env_file="$workdir/config/agentnest.env"
reports="$workdir/reports"
install -d -m 0755 "$reports"
test -f "$env_file"
if docker info >/dev/null 2>&1; then docker_cmd=docker; else docker_cmd='sudo -n docker'; fi
compose() { $docker_cmd compose --project-name agentnest-demo --env-file "$env_file" -f "$source_dir/compose.yaml" "$@"; }
set -a
. "$env_file"
set +a

isolation_selected=false
lifecycle_selected=false
recovery_selected=false
control_chain_selected=false
case "$suite" in
  all) isolation_selected=true; lifecycle_selected=true; recovery_selected=true; control_chain_selected=true ;;
  isolation) isolation_selected=true ;;
  lifecycle) lifecycle_selected=true ;;
  recovery) recovery_selected=true ;;
  *) exit 21 ;;
esac

isolation_pass=true
lifecycle_suite_pass=true
lifecycle_api_pass=true
recovery_pass=true
control_legal_pass=true
control_robot_pass=true
control_tenant_b_legal_pass=true
control_provider_blocked=false
control_legal_provider_blocked=false
control_tenant_b_legal_provider_blocked=false
control_robot_provider_blocked=false
last_control_provider_blocked=false
postgres_adapter_pass=true
memory_isolation_pass=true
deny_no_side_effect_pass=true

postgres_value() {
  sql=$1
  shift
  printf '%s\n' "$sql" | compose exec -T postgres psql -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@" 2>/dev/null | tr -d '\r'
}

postgres_execute() {
  sql=$1
  shift
  printf '%s\n' "$sql" | compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@" >/dev/null 2>&1
}

if [ "$isolation_selected" = true ]; then
  verify_stage=isolation_suite
  if ! compose run -T --rm --no-deps --user node -e HOME=/tmp control-plane pnpm test:isolation </dev/null > "$reports/isolation-suite.log" 2>&1; then
    isolation_pass=false
  fi
fi

if [ "$suite" = all ]; then
  verify_stage=postgres_adapter_suite
  if ! compose run -T --rm --no-deps --user node -e HOME=/tmp control-plane sh -c \
    'AGENTNEST_TEST_DATABASE_URL="$DATABASE_URL" pnpm exec vitest run --config vitest.integration.config.ts tests/integration/postgres-phase6-real.integration.test.ts' \
    </dev/null \
    > "$reports/postgres-adapter-suite.log" 2>&1; then
    postgres_adapter_pass=false
  fi
fi

run_control_task() {
  last_control_provider_blocked=false
  tenant=$1
  biz=$2
  task_type=$3
  resource_type=$4
  resource_id=$5
  expected_tool=$6
  request_name=$7
  response_file="$reports/control-$request_name-response.json"
  task_file="$reports/control-$request_name-task.json"
  request_id="phase6-$request_name-$(date +%s)-$$"
  body=$(jq -nc \
    --arg request_id "$request_id" \
    --arg tenant "$tenant" \
    --arg biz "$biz" \
    --arg task_type "$task_type" \
    --arg resource_type "$resource_type" \
    --arg resource_id "$resource_id" \
    '{request_id:$request_id,idempotency_key:$request_id,tenant_id:$tenant,biz_domain:$biz,task_type:$task_type,resource:{resource_type:$resource_type,resource_id:$resource_id},input:{instruction:"Use the authorized read and write Demo tools, then complete the task."}}')
  http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'X-Request-Id: phase6-control-chain' \
    -d "$body" "http://127.0.0.1:$CONTROL_PLANE_PORT/api/tasks" || printf 000)
  if jq -e '.code == "MODEL_PROVIDER_BLOCKED" or .error.reason == "MODEL_PROVIDER_BLOCKED"' "$response_file" >/dev/null 2>&1; then
    last_control_provider_blocked=true
  fi
  if [ "$http_code" != 200 ] && [ "$http_code" != 201 ] && [ "$http_code" != 202 ]; then return 1; fi
  task_id=$(jq -r '.data.task_id // empty' "$response_file")
  if ! printf '%s' "$task_id" | grep -Eq '^task_[a-f0-9]{24}$'; then return 1; fi
  status=$(jq -r '.data.status // empty' "$response_file")
  attempt=0
  while [ "$status" != COMPLETED ] && [ "$status" != FAILED ] && [ "$attempt" -lt 60 ]; do
    sleep 2
    if ! curl -fsS -H 'X-Request-Id: phase6-task-poll' \
      "http://127.0.0.1:$CONTROL_PLANE_PORT/api/tasks/$task_id?request_id=phase6-task-poll&tenant_id=$tenant&biz_domain=$biz" \
      -o "$task_file"; then return 1; fi
    status=$(jq -r '.data.status // empty' "$task_file")
    attempt=$((attempt + 1))
  done
  if [ "$status" != COMPLETED ]; then return 1; fi
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    operation_count=$(postgres_value "SELECT count(*) FROM demo_gateway_operation WHERE task_id = :'task_id' AND tool_name = :'expected_tool' AND action = 'write'" -v task_id="$task_id" -v expected_tool="$expected_tool" || printf 0)
    trace_count=$(postgres_value "SELECT count(*) FROM gateway_trace_event WHERE task_id = :'task_id' AND tool_name = :'expected_tool' AND action = 'write' AND decision = 'ALLOW'" -v task_id="$task_id" -v expected_tool="$expected_tool" || printf 0)
    if [ "$operation_count" -ge 1 ] 2>/dev/null && [ "$trace_count" -ge 1 ] 2>/dev/null; then return 0; fi
    attempt=$((attempt + 1))
    sleep 2
  done
  return 1
}

if [ "$control_chain_selected" = true ]; then
  verify_stage=control_plane_real_chains
  if ! run_control_task tenant_A LEGAL LEGAL_EVIDENCE_CHECK CASE case_001 legal_analysis_write legal-tenant-a; then
    control_legal_pass=false
    control_legal_provider_blocked=$last_control_provider_blocked
  fi
  if ! run_control_task tenant_B LEGAL LEGAL_EVIDENCE_CHECK CASE case_001 legal_analysis_write legal-tenant-b; then
    control_tenant_b_legal_pass=false
    control_tenant_b_legal_provider_blocked=$last_control_provider_blocked
  fi
  if ! run_control_task tenant_A ROBOT_DOG ROBOT_DOG_HEALTH_CHECK DEVICE device_001 robot_health_write robot; then
    control_robot_pass=false
    control_robot_provider_blocked=$last_control_provider_blocked
  fi
  if { [ "$control_legal_pass" = true ] || [ "$control_legal_provider_blocked" = true ]; } && \
     { [ "$control_tenant_b_legal_pass" = true ] || [ "$control_tenant_b_legal_provider_blocked" = true ]; } && \
     { [ "$control_robot_pass" = true ] || [ "$control_robot_provider_blocked" = true ]; } && \
     { [ "$control_legal_provider_blocked" = true ] || [ "$control_tenant_b_legal_provider_blocked" = true ] || [ "$control_robot_provider_blocked" = true ]; }; then
    control_provider_blocked=true
  fi
fi

write_memory_canary() {
  tenant=$1
  biz=$2
  label=$3
  own=$4
  forbidden_one=$5
  forbidden_two=$6
  row=$(postgres_value "SELECT logical_agent_id, runtime_instance_id, session_id, task_id FROM agent_task WHERE tenant_id = :'tenant' AND biz_domain = :'biz' ORDER BY created_at DESC LIMIT 1" \
    -F '|' -v tenant="$tenant" -v biz="$biz")
  if [ -z "$row" ]; then return 1; fi
  old_ifs=$IFS
  IFS='|'
  set -- $row
  IFS=$old_ifs
  logical_agent_id=$1
  runtime_instance_id=$2
  session_id=$3
  task_id=$4
  if [ -z "$logical_agent_id" ] || [ -z "$runtime_instance_id" ] || [ -z "$session_id" ] || [ -z "$task_id" ]; then return 1; fi
  if ! postgres_execute "DELETE FROM agent_memory WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND dedupe_key = 'phase6-memory-canary'; INSERT INTO agent_memory (tenant_id, biz_domain, memory_id, logical_agent_id, runtime_instance_id, session_id, task_id, dedupe_key, memory_type, resource_type, resource_id, content, created_at, updated_at) VALUES (:'tenant', :'biz', ('00000000-0000-4000-8000-' || substr(md5(:'tenant' || ':' || :'biz' || ':phase6-memory-canary'), 1, 12))::uuid, :'logical_agent_id', :'runtime_instance_id', :'session_id', :'task_id', 'phase6-memory-canary', 'DEMO_CANARY', NULL, NULL, :'canary', now(), now())" \
    -v tenant="$tenant" -v biz="$biz" -v logical_agent_id="$logical_agent_id" \
    -v runtime_instance_id="$runtime_instance_id" -v session_id="$session_id" \
    -v task_id="$task_id" -v canary="$own" \
    ; then return 1; fi
  response_file="$reports/memory-$label-response.json"
  if ! curl -fsS -H 'X-Request-Id: phase6-memory-canary' \
    "http://127.0.0.1:$CONTROL_PLANE_PORT/api/agents/$logical_agent_id/memories?request_id=phase6-memory-$label&tenant_id=$tenant&biz_domain=$biz" \
    -o "$response_file"; then return 1; fi
  jq -e --arg own "$own" --arg forbidden_one "$forbidden_one" --arg forbidden_two "$forbidden_two" \
    '[.data[]?.content] as $contents | (($contents | index($own)) != null) and (($contents | index($forbidden_one)) == null) and (($contents | index($forbidden_two)) == null)' \
    "$response_file" >/dev/null
}

verify_memory_isolation() {
  canary_a_legal=PHASE6_CANARY_TENANT_A_LEGAL
  canary_a_robot=PHASE6_CANARY_TENANT_A_ROBOT_DOG
  canary_b_legal=PHASE6_CANARY_TENANT_B_LEGAL
  write_memory_canary tenant_A LEGAL tenant-a-legal "$canary_a_legal" "$canary_a_robot" "$canary_b_legal" &&
  write_memory_canary tenant_A ROBOT_DOG tenant-a-robot "$canary_a_robot" "$canary_a_legal" "$canary_b_legal" &&
  write_memory_canary tenant_B LEGAL tenant-b-legal "$canary_b_legal" "$canary_a_legal" "$canary_a_robot"
}

verify_deny_no_side_effect() {
  context_id=$(postgres_value "SELECT execution_context_id FROM execution_context WHERE tenant_id = :'tenant' AND biz_domain = :'biz' ORDER BY created_at DESC LIMIT 1" \
    -v tenant=tenant_A -v biz=LEGAL)
  if ! printf '%s' "$context_id" | grep -Eqi '^[0-9a-f-]{36}$'; then return 1; fi
  deny_trace="phase6-deny-$(date +%s)-$$"
  before_count=$(postgres_value "SELECT count(*) FROM demo_gateway_operation WHERE trace_id = :'trace_id'" -v trace_id="$deny_trace")
  body=$(jq -nc --arg context_id "$context_id" --arg trace_id "$deny_trace" \
    '{request_id:$trace_id,trace_id:$trace_id,execution_context_id:$context_id,tool_name:"legal_analysis_write",action:"write",resource:{resource_type:"CASE",resource_id:"case_B_only"},params:{analysis:"this write must be denied"}}')
  response_file="$reports/deny-no-side-effect-response.json"
  http_code=$(curl -sS -o "$response_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'X-Request-Id: phase6-deny' \
    -d "$body" "http://127.0.0.1:$DATA_GATEWAY_MOCK_PORT/v1/tools/execute" || printf 000)
  after_count=$(postgres_value "SELECT count(*) FROM demo_gateway_operation WHERE trace_id = :'trace_id'" -v trace_id="$deny_trace")
  deny_trace_count=$(postgres_value "SELECT count(*) FROM gateway_trace_event WHERE trace_id = :'trace_id' AND decision = 'DENY' AND reason = 'RESOURCE_SCOPE_DENIED'" -v trace_id="$deny_trace")
  jq -n --arg http_code "$http_code" --arg before "$before_count" --arg after "$after_count" \
    --arg deny_trace_count "$deny_trace_count" \
    '{schema_version:"1.0",http_status:($http_code|tonumber),operation_count_before:($before|tonumber),operation_count_after:($after|tonumber),deny_trace_count:($deny_trace_count|tonumber),expected_reason:"RESOURCE_SCOPE_DENIED"}' \
    > "$reports/deny-no-side-effect.json"
  [ "$http_code" = 403 ] && [ "$before_count" = "$after_count" ] && [ "$after_count" = 0 ] &&
    [ "$deny_trace_count" -ge 1 ] 2>/dev/null &&
    jq -e '.success == false and .error.reason == "RESOURCE_SCOPE_DENIED"' "$response_file" >/dev/null
}

if [ "$suite" = all ]; then
  verify_stage=memory_and_deny_isolation
  if ! verify_memory_isolation; then memory_isolation_pass=false; fi
  if ! verify_deny_no_side_effect; then deny_no_side_effect_pass=false; fi
fi

post_json() {
  path=$1
  body=$2
  curl -fsS \
    -H 'Content-Type: application/json' \
    -H 'X-Request-Id: phase6-verifier' \
    -d "$body" \
    "http://127.0.0.1:$CONTROL_PLANE_PORT$path"
}

if [ "$lifecycle_selected" = true ]; then
  verify_stage=lifecycle_verification
  lifecycle_memory_pass=true
  verify_stage=lifecycle_suite
  if ! compose run -T --rm --no-deps --user node -e HOME=/tmp control-plane pnpm test:lifecycle </dev/null > "$reports/lifecycle-suite.log" 2>&1; then
    lifecycle_suite_pass=false
  fi
  verify_stage=lifecycle_eligible_query
  eligible_l2=$(postgres_value "SELECT count(*) FROM agent_task WHERE unloaded_at IS NULL AND status IN ('COMPLETED', 'FAILED', 'CHECKPOINTED')")
  if [ "$eligible_l2" -lt 1 ] 2>/dev/null; then
    lifecycle_seed_id="phase6-lifecycle-seed-$(date +%s)-$$"
    lifecycle_seed_body=$(jq -nc --arg request_id "$lifecycle_seed_id" \
      '{request_id:$request_id,idempotency_key:$request_id,tenant_id:"tenant_A",biz_domain:"LEGAL",task_type:"LEGAL_EVIDENCE_CHECK",resource:{resource_type:"CASE",resource_id:"case_001"},input:{instruction:"Create terminal lifecycle state for the deployed reaper verification."}}')
    lifecycle_seed_code=$(curl -sS -o "$reports/lifecycle-seed-response.json" -w '%{http_code}' \
      -H 'Content-Type: application/json' -H 'X-Request-Id: phase6-lifecycle-seed' \
      -d "$lifecycle_seed_body" "http://127.0.0.1:$CONTROL_PLANE_PORT/api/tasks" || printf 000)
    case "$lifecycle_seed_code" in 200|201|202|502|503) ;; *) lifecycle_api_pass=false ;; esac
  fi

  verify_stage=lifecycle_before_row
  before_row=$(postgres_value "SELECT agent.logical_agent_id, agent.current_runtime_instance_id, (SELECT task.task_id FROM agent_task AS task WHERE task.tenant_id = agent.tenant_id AND task.biz_domain = agent.biz_domain AND task.logical_agent_id = agent.logical_agent_id ORDER BY task.created_at DESC LIMIT 1) FROM tenant_biz_agent AS agent WHERE agent.tenant_id = :'tenant' AND agent.biz_domain = :'biz'" \
    -F '|' -v tenant=tenant_A -v biz=LEGAL)
  old_ifs=$IFS
  IFS='|'
  set -- $before_row
  IFS=$old_ifs
  lifecycle_logical_id=
  lifecycle_before_runtime=
  lifecycle_before_task_id=
  if [ "$#" -ge 3 ]; then lifecycle_logical_id=$1; lifecycle_before_runtime=$2; lifecycle_before_task_id=$3; fi
  if [ -z "$lifecycle_logical_id" ] || [ -z "$lifecycle_before_runtime" ] || [ -z "$lifecycle_before_task_id" ]; then lifecycle_api_pass=false; fi
  verify_stage=lifecycle_memory_seed
  if ! write_memory_canary tenant_A LEGAL lifecycle-tenant-a-legal PHASE6_CANARY_TENANT_A_LEGAL PHASE6_CANARY_TENANT_A_ROBOT_DOG PHASE6_CANARY_TENANT_B_LEGAL; then lifecycle_api_pass=false; lifecycle_memory_pass=false; fi
  verify_stage=lifecycle_original_operation_query
  original_operation_count=$(postgres_value "SELECT count(*) FROM demo_gateway_operation WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND task_id = :'task_id' AND action = 'write'" \
    -v tenant=tenant_A -v biz=LEGAL -v task_id="$lifecycle_before_task_id")

  l2_clock_file="$reports/lifecycle-l2-clock.json"
  l2_reaper_file="$reports/lifecycle-l2-reaper.json"
  l1_clock_file="$reports/lifecycle-l1-clock.json"
  l1_reaper_file="$reports/lifecycle-l1-reaper.json"
  verify_stage=lifecycle_l2_reaper
  if ! post_json /api/admin/clock/advance '{"request_id":"verify-l2-clock","idempotency_key":"verify-l2-clock","seconds":3600}' > "$l2_clock_file"; then lifecycle_api_pass=false; fi
  if ! post_json /api/admin/reaper/run '{"request_id":"verify-l2-reaper","idempotency_key":"verify-l2-reaper"}' > "$l2_reaper_file"; then lifecycle_api_pass=false; fi
  if ! jq -e '.success == true and .data.failed == 0 and .data.l2_unloaded >= 1' "$l2_reaper_file" >/dev/null 2>&1; then lifecycle_api_pass=false; fi
  verify_stage=lifecycle_l1_reaper
  if ! post_json /api/admin/clock/advance '{"request_id":"verify-l1-clock","idempotency_key":"verify-l1-clock","seconds":82800}' > "$l1_clock_file"; then lifecycle_api_pass=false; fi
  if ! post_json /api/admin/reaper/run '{"request_id":"verify-l1-reaper","idempotency_key":"verify-l1-reaper"}' > "$l1_reaper_file"; then lifecycle_api_pass=false; fi
  if ! jq -e '.success == true and .data.failed == 0 and .data.l1_unloaded >= 1' "$l1_reaper_file" >/dev/null 2>&1; then lifecycle_api_pass=false; fi

  verify_stage=lifecycle_restore_request
  lifecycle_restore_id="phase6-lifecycle-restore-$(date +%s)-$$"
  lifecycle_restore_body=$(jq -nc --arg request_id "$lifecycle_restore_id" \
    '{request_id:$request_id,idempotency_key:$request_id,tenant_id:"tenant_A",biz_domain:"LEGAL",task_type:"LEGAL_EVIDENCE_CHECK",resource:{resource_type:"CASE",resource_id:"case_001"},input:{instruction:"Restore the unloaded Demo runtime and preserve its scoped summary."}}')
  lifecycle_restore_file="$reports/lifecycle-restore-response.json"
  lifecycle_restore_code=$(curl -sS -o "$lifecycle_restore_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'X-Request-Id: phase6-lifecycle-restore' \
    -d "$lifecycle_restore_body" "http://127.0.0.1:$CONTROL_PLANE_PORT/api/tasks" || printf 000)
  case "$lifecycle_restore_code" in 200|201|202|502|503) ;; *) lifecycle_api_pass=false ;; esac
  lifecycle_restore_task_id=$(jq -r '.data.task_id // .error.task_id // empty' "$lifecycle_restore_file" 2>/dev/null || true)
  if ! printf '%s' "$lifecycle_restore_task_id" | grep -Eq '^task_[a-f0-9]{24}$'; then lifecycle_api_pass=false; fi

  verify_stage=lifecycle_after_row
  after_row=$(postgres_value "SELECT agent.logical_agent_id, agent.current_runtime_instance_id, runtime.restored_from_runtime_instance_id FROM tenant_biz_agent AS agent JOIN agent_runtime_instance AS runtime ON runtime.logical_agent_id = agent.logical_agent_id AND runtime.runtime_instance_id = agent.current_runtime_instance_id WHERE agent.tenant_id = :'tenant' AND agent.biz_domain = :'biz'" \
    -F '|' -v tenant=tenant_A -v biz=LEGAL)
  old_ifs=$IFS
  IFS='|'
  set -- $after_row
  IFS=$old_ifs
  lifecycle_after_logical_id=
  lifecycle_after_runtime=
  lifecycle_restored_from=
  if [ "$#" -ge 3 ]; then lifecycle_after_logical_id=$1; lifecycle_after_runtime=$2; lifecycle_restored_from=$3; fi
  if [ "$lifecycle_after_logical_id" != "$lifecycle_logical_id" ] || \
     [ -z "$lifecycle_after_runtime" ] || \
     [ "$lifecycle_after_runtime" = "$lifecycle_before_runtime" ] || \
     [ "$lifecycle_restored_from" != "$lifecycle_before_runtime" ]; then
    lifecycle_api_pass=false
  fi
  verify_stage=lifecycle_restore_evidence
  lifecycle_restore_trace_count=$(postgres_value "SELECT count(*) FROM agent_trace WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND task_id = :'task_id' AND event_json ->> 'restored_from_runtime_instance_id' = :'restored_from'" \
    -v tenant=tenant_A -v biz=LEGAL -v task_id="$lifecycle_restore_task_id" -v restored_from="$lifecycle_before_runtime")
  if [ "$lifecycle_restore_trace_count" -lt 1 ] 2>/dev/null; then lifecycle_api_pass=false; fi
  lifecycle_memory_file="$reports/lifecycle-restored-memory.json"
  if ! curl -fsS -H 'X-Request-Id: phase6-lifecycle-memory' \
    "http://127.0.0.1:$CONTROL_PLANE_PORT/api/agents/$lifecycle_logical_id/memories?request_id=phase6-lifecycle-memory&tenant_id=tenant_A&biz_domain=LEGAL" \
    -o "$lifecycle_memory_file"; then lifecycle_api_pass=false; lifecycle_memory_pass=false; fi
  if ! jq -e '[.data[]?.content] | index("PHASE6_CANARY_TENANT_A_LEGAL") != null' "$lifecycle_memory_file" >/dev/null 2>&1; then lifecycle_api_pass=false; lifecycle_memory_pass=false; fi
  restored_original_operation_count=$(postgres_value "SELECT count(*) FROM demo_gateway_operation WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND task_id = :'task_id' AND action = 'write'" \
    -v tenant=tenant_A -v biz=LEGAL -v task_id="$lifecycle_before_task_id")
  restored_summary_count=$(postgres_value "SELECT count(*) FROM agent_session_summary WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND task_id = :'task_id'" \
    -v tenant=tenant_A -v biz=LEGAL -v task_id="$lifecycle_before_task_id")
  restored_checkpoint_count=$(postgres_value "SELECT count(*) FROM agent_checkpoint_artifact WHERE tenant_id = :'tenant' AND biz_domain = :'biz' AND runtime_instance_id = :'runtime_id' AND checkpoint_level = 'L1'" \
    -v tenant=tenant_A -v biz=LEGAL -v runtime_id="$lifecycle_before_runtime")
  if [ "$restored_original_operation_count" != "$original_operation_count" ] || \
     [ "$restored_summary_count" -lt 1 ] 2>/dev/null || \
     [ "$restored_checkpoint_count" -lt 1 ] 2>/dev/null; then
    lifecycle_api_pass=false
  fi
  l2_unloaded=$(jq -r '.data.l2_unloaded // 0' "$l2_reaper_file" 2>/dev/null || printf 0)
  l1_unloaded=$(jq -r '.data.l1_unloaded // 0' "$l1_reaper_file" 2>/dev/null || printf 0)
  l2_reaper_failed=$(jq -r '.data.failed // -1' "$l2_reaper_file" 2>/dev/null || printf -- -1)
  l1_reaper_failed=$(jq -r '.data.failed // -1' "$l1_reaper_file" 2>/dev/null || printf -- -1)
  verify_stage=lifecycle_report
  jq -n \
    --argjson passed "$lifecycle_api_pass" \
    --arg logical_agent_id "$lifecycle_logical_id" \
    --arg before_runtime_instance_id "$lifecycle_before_runtime" \
    --arg after_runtime_instance_id "$lifecycle_after_runtime" \
    --arg restored_from_runtime_instance_id "$lifecycle_restored_from" \
    --argjson l2_unloaded "$l2_unloaded" \
    --argjson l1_unloaded "$l1_unloaded" \
    --arg restore_trace_count "$lifecycle_restore_trace_count" \
    --arg l2_reaper_failed "$l2_reaper_failed" \
    --arg l1_reaper_failed "$l1_reaper_failed" \
    --argjson lifecycle_memory_pass "$lifecycle_memory_pass" \
    --arg original_operation_count "$original_operation_count" \
    --arg restored_original_operation_count "$restored_original_operation_count" \
    --arg restored_summary_count "$restored_summary_count" \
    --arg restored_checkpoint_count "$restored_checkpoint_count" \
    '{schema_version:"1.0",passed:$passed,logical_agent_id:$logical_agent_id,before_runtime_instance_id:$before_runtime_instance_id,after_runtime_instance_id:$after_runtime_instance_id,restored_from_runtime_instance_id:$restored_from_runtime_instance_id,l2_unloaded:$l2_unloaded,l1_unloaded:$l1_unloaded,restore_trace_count:($restore_trace_count|tonumber? // 0),scoped_memory_canary_restored:$lifecycle_memory_pass,original_tool_write_count_before:($original_operation_count|tonumber? // -1),original_tool_write_count_after:($restored_original_operation_count|tonumber? // -1),restored_summary_count:($restored_summary_count|tonumber? // -1),restored_checkpoint_count:($restored_checkpoint_count|tonumber? // -1),reaper_failed:(($l2_reaper_failed|tonumber? // -1) + ($l1_reaper_failed|tonumber? // -1))}' \
    > "$reports/lifecycle-admin-api.json"
fi

if [ "$recovery_selected" = true ]; then
  verify_stage=recovery_verification
  recovery_log="$reports/recovery-suite.log"
  : > "$recovery_log"
  control_restart_pass=true
  openclaw_restart_pass=true
  before_count=$(postgres_value 'SELECT count(*) FROM tenant_biz_agent' 2>> "$recovery_log" || printf unavailable)
  if ! compose restart control-plane >> "$recovery_log" 2>&1; then recovery_pass=false; control_restart_pass=false; fi
  attempt=0
  until curl -fsS -H 'X-Request-Id: recovery-health' "http://127.0.0.1:$CONTROL_PLANE_PORT/health" >> "$recovery_log" 2>&1; do
    attempt=$((attempt + 1)); if [ "$attempt" -ge 45 ]; then recovery_pass=false; control_restart_pass=false; break; fi; sleep 2
  done
  after_count=$(postgres_value 'SELECT count(*) FROM tenant_biz_agent' 2>> "$recovery_log" || printf unavailable)
  if [ "$before_count" = unavailable ] || [ "$before_count" != "$after_count" ]; then recovery_pass=false; fi
  if ! curl -fsS -H 'X-Request-Id: recovery-agents' "http://127.0.0.1:$CONTROL_PLANE_PORT/api/agents?request_id=recovery-agents&tenant_id=tenant_A&biz_domain=LEGAL" >> "$recovery_log" 2>&1; then recovery_pass=false; fi

  export OPENCLAW_STATE_DIR="$workdir/openclaw-state"
  export OPENCLAW_CONFIG_PATH="$workdir/openclaw-state/openclaw.json"
  if [ -f "$workdir/openclaw-state/.env" ]; then set -a; . "$workdir/openclaw-state/.env"; set +a; fi
  if ! openclaw gateway restart --json >> "$recovery_log" 2>&1; then recovery_pass=false; openclaw_restart_pass=false; fi
  attempt=0
  until openclaw gateway status --require-rpc --json >> "$recovery_log" 2>&1; do
    attempt=$((attempt + 1)); if [ "$attempt" -ge 30 ]; then recovery_pass=false; openclaw_restart_pass=false; break; fi; sleep 2
  done
  recovery_request_id="phase6-recovery-task-$(date +%s)-$$"
  recovery_body=$(jq -nc --arg request_id "$recovery_request_id" \
    '{request_id:$request_id,idempotency_key:$request_id,tenant_id:"tenant_B",biz_domain:"LEGAL",task_type:"LEGAL_EVIDENCE_CHECK",resource:{resource_type:"CASE",resource_id:"case_001"},input:{instruction:"Verify that the restarted Control Plane and OpenClaw Gateway accept a new scoped task."}}')
  recovery_response="$reports/recovery-new-task-response.json"
  recovery_http_code=$(curl -sS -o "$recovery_response" -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'X-Request-Id: phase6-recovery-task' \
    -d "$recovery_body" "http://127.0.0.1:$CONTROL_PLANE_PORT/api/tasks" || printf 000)
  case "$recovery_http_code" in 200|201|202|503) ;; *) recovery_pass=false ;; esac
  recovery_task_id=$(jq -r '.data.task_id // .error.task_id // empty' "$recovery_response" 2>/dev/null || true)
  if ! printf '%s' "$recovery_task_id" | grep -Eq '^task_[a-f0-9]{24}$'; then recovery_pass=false; fi
  recovery_task_runtime_count=$(postgres_value "SELECT count(*) FROM agent_task AS task JOIN agent_runtime_instance AS runtime ON runtime.logical_agent_id = task.logical_agent_id AND runtime.runtime_instance_id = task.runtime_instance_id WHERE task.tenant_id = :'tenant' AND task.biz_domain = :'biz' AND task.task_id = :'task_id'" \
    -v task_id="$recovery_task_id" -v tenant=tenant_B -v biz=LEGAL)
  if [ "$recovery_task_runtime_count" != 1 ]; then recovery_pass=false; fi
  recovery_reaper_file="$reports/recovery-reaper.json"
  if ! post_json /api/admin/reaper/run '{"request_id":"verify-recovery-reaper","idempotency_key":"verify-recovery-reaper"}' > "$recovery_reaper_file"; then recovery_pass=false; fi
  if ! jq -e '.success == true and .data.failed == 0' "$recovery_reaper_file" >/dev/null 2>&1; then recovery_pass=false; fi
  recovery_reaper_failed=$(jq -r '.data.failed // -1' "$recovery_reaper_file" 2>/dev/null || printf -- -1)
  jq -n --argjson passed "$recovery_pass" --arg http_code "$recovery_http_code" \
    --arg task_id "$recovery_task_id" --arg task_runtime_count "$recovery_task_runtime_count" \
    --arg before_agent_count "$before_count" --arg after_agent_count "$after_count" \
    --argjson control_restart_pass "$control_restart_pass" \
    --argjson openclaw_restart_pass "$openclaw_restart_pass" \
    --arg reaper_failed "$recovery_reaper_failed" \
    '{schema_version:"1.0",passed:$passed,new_task_http_status:($http_code|tonumber? // 0),new_task_id:$task_id,new_task_runtime_rows:($task_runtime_count|tonumber? // -1),agent_count_before_restart:($before_agent_count|tonumber? // -1),agent_count_after_restart:($after_agent_count|tonumber? // -1),control_plane_ready_after_restart:$control_restart_pass,openclaw_gateway_rpc_ready_after_restart:$openclaw_restart_pass,reaper_failed:($reaper_failed|tonumber? // -1)}' \
    > "$reports/recovery-suite.json"
fi

verify_stage=verification_report
overall=true
platform_passed=true
if [ "$isolation_selected" = true ] && [ "$isolation_pass" != true ]; then overall=false; platform_passed=false; fi
if [ "$lifecycle_selected" = true ] && { [ "$lifecycle_suite_pass" != true ] || [ "$lifecycle_api_pass" != true ]; }; then overall=false; platform_passed=false; fi
if [ "$recovery_selected" = true ] && [ "$recovery_pass" != true ]; then overall=false; platform_passed=false; fi
if [ "$suite" = all ] && { [ "$postgres_adapter_pass" != true ] || [ "$memory_isolation_pass" != true ] || [ "$deny_no_side_effect_pass" != true ]; }; then overall=false; platform_passed=false; fi
if [ "$control_chain_selected" = true ] && { [ "$control_legal_pass" != true ] || [ "$control_tenant_b_legal_pass" != true ] || [ "$control_robot_pass" != true ]; }; then overall=false; fi

jq -n \
  --arg suite "$suite" \
  --argjson overall "$overall" \
  --argjson platform_passed "$platform_passed" \
  --argjson isolation_selected "$isolation_selected" \
  --argjson isolation_pass "$isolation_pass" \
  --argjson lifecycle_selected "$lifecycle_selected" \
  --argjson lifecycle_suite_pass "$lifecycle_suite_pass" \
  --argjson lifecycle_api_pass "$lifecycle_api_pass" \
  --argjson recovery_selected "$recovery_selected" \
  --argjson recovery_pass "$recovery_pass" \
  --argjson control_chain_selected "$control_chain_selected" \
  --argjson control_legal_pass "$control_legal_pass" \
  --argjson control_tenant_b_legal_pass "$control_tenant_b_legal_pass" \
  --argjson control_robot_pass "$control_robot_pass" \
  --argjson control_provider_blocked "$control_provider_blocked" \
  --argjson control_legal_provider_blocked "$control_legal_provider_blocked" \
  --argjson control_tenant_b_legal_provider_blocked "$control_tenant_b_legal_provider_blocked" \
  --argjson control_robot_provider_blocked "$control_robot_provider_blocked" \
  --argjson postgres_adapter_pass "$postgres_adapter_pass" \
  --argjson memory_isolation_pass "$memory_isolation_pass" \
  --argjson deny_no_side_effect_pass "$deny_no_side_effect_pass" \
  '{schema_version:"1.0",suite:$suite,overall_passed:$overall,platform_passed:$platform_passed,
    provider_blocked:$control_provider_blocked,
    real_openclaw_tests:(if $control_chain_selected then [
      {name:"control_plane_tenant_a_legal_l0_l1_l2_mock_tool",status:(if $control_legal_pass then "PASS" elif $control_legal_provider_blocked then "BLOCKED_EXTERNAL" else "FAIL" end),evidence:"reports/control-legal-tenant-a-response.json"},
      {name:"control_plane_tenant_b_legal_l0_l1_l2_mock_tool",status:(if $control_tenant_b_legal_pass then "PASS" elif $control_tenant_b_legal_provider_blocked then "BLOCKED_EXTERNAL" else "FAIL" end),evidence:"reports/control-legal-tenant-b-response.json"},
      {name:"control_plane_robot_l0_l1_l2_mock_tool",status:(if $control_robot_pass then "PASS" elif $control_robot_provider_blocked then "BLOCKED_EXTERNAL" else "FAIL" end),evidence:"reports/control-robot-response.json"}
    ] else [] end),
    postgres_tests:(if $suite == "all" then [{name:"real_postgres_16_node_adapter",status:(if $postgres_adapter_pass then "PASS" else "FAIL" end),evidence:"reports/postgres-adapter-suite.log"}] else [] end),
    isolation_tests:(if $suite == "all" then [
      {name:"three_scope_postgres_memory_canary_reads",status:(if $memory_isolation_pass then "PASS" else "FAIL" end),evidence:"reports/memory-*-response.json"},
      {name:"gateway_deny_trace_and_no_side_effect",status:(if $deny_no_side_effect_pass then "PASS" else "FAIL" end),evidence:"reports/deny-no-side-effect.json"}
    ] else [] end),
    mock_tool_tests:(if $isolation_selected then
      ([{name:"gateway_mock_isolation_suite",status:(if $isolation_pass then "PASS" else "FAIL" end),evidence:"reports/isolation-suite.log"}]
       + (if $suite == "all" then [{name:"gateway_deny_trace_and_no_side_effect",status:(if $deny_no_side_effect_pass then "PASS" else "FAIL" end),evidence:"reports/deny-no-side-effect.json"}] else [] end))
    else [] end),
    lifecycle_tests:(if $lifecycle_selected then [
      {name:"fake_clock_lifecycle_suite",status:(if $lifecycle_suite_pass then "PASS" else "FAIL" end),evidence:"reports/lifecycle-suite.log"},
      {name:"deployed_ttl_unload_and_runtime_restore",status:(if $lifecycle_api_pass then "PASS" else "FAIL" end),evidence:"reports/lifecycle-admin-api.json"}
    ] else [] end),
    recovery_tests:(if $recovery_selected then [{name:"postgres_control_plane_openclaw_restart_and_new_task",status:(if $recovery_pass then "PASS" else "FAIL" end),evidence:"reports/recovery-suite.json"}] else [] end)}'
trap - ERR
`;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSuite(value: string | undefined): VerificationSuite {
  if (value === undefined || value === "all") {
    return "all";
  }
  if (value === "isolation" || value === "lifecycle" || value === "recovery") {
    return value;
  }
  throw new Error("verification suite must be all, isolation, lifecycle, or recovery");
}

function parseJsonObject(text: string, label: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (!isRecord(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return value;
}

function runRealOpenClawVerifier(): { readonly exitCode: number; readonly report: JsonRecord } {
  const startedAt = Date.now();
  const result = spawnSync("pnpm", ["exec", "tsx", "scripts/verify/phase3-openclaw.ts"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
    timeout: 20 * 60 * 1_000,
    maxBuffer: 12 * 1_024 * 1_024,
  });
  let report: JsonRecord = { status: "FAIL", reason: "real verifier produced no report" };
  try {
    report = parseJsonObject(readFileSync(phase3ReportPath, "utf8"), "real OpenClaw report");
    const generatedAt =
      typeof report["generated_at"] === "string" ? Date.parse(report["generated_at"]) : Number.NaN;
    if (!Number.isFinite(generatedAt) || generatedAt < startedAt - 5_000) {
      report = { status: "FAIL", reason: "real verifier report is stale" };
    }
  } catch {
    // Preserve the explicit missing-report failure without copying verifier output.
  }
  return { exitCode: result.status ?? 1, report };
}

function remotePassed(remote: JsonRecord): boolean {
  return remote["overall_passed"] === true;
}

function realTests(report: JsonRecord): readonly JsonRecord[] {
  const status = typeof report["status"] === "string" ? report["status"] : "FAIL";
  const openclaw = isRecord(report["openclaw"]) ? report["openclaw"] : {};
  const gateway = isRecord(openclaw["gateway"]) ? openclaw["gateway"] : {};
  const stablePassed =
    gateway["rpc_ready"] === true && typeof openclaw["observed_version"] === "string";
  return [
    {
      name: "official_stable_gateway_rpc",
      status: stablePassed ? "PASS" : "FAIL",
      evidence: "artifacts/reports/phase-3-remote-e2e.json",
    },
    {
      name: "l0_l1_native_sessions_spawn_l2",
      status,
      evidence: "artifacts/reports/phase-3-remote-e2e.json",
    },
  ];
}

function recordArray(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

async function main(): Promise<void> {
  const suite = parseSuite(process.argv[2]);
  const config = await loadConfig();
  await prepareRemoteTransport();

  let realOpenClawTests: readonly JsonRecord[] = [];
  let realStatus: string | null = null;
  let realExitCode = 0;
  if (suite === "all") {
    await rm(phase3ReportPath, { force: true });
    const real = runRealOpenClawVerifier();
    realExitCode = real.exitCode;
    realStatus = typeof real.report["status"] === "string" ? real.report["status"] : "FAIL";
    realOpenClawTests = realTests(real.report);
  }

  const remoteResult = runRemoteScript(
    config,
    `verify-${suite}`,
    remoteVerificationScript,
    [config.remoteWorkdir, suite],
    { timeoutMs: 30 * 60 * 1_000, maxBufferBytes: 8 * 1_024 * 1_024 },
  );
  if (remoteResult.status !== 0) {
    const failedStage = /^VERIFY_REMOTE_FAILED_STAGE=([A-Za-z0-9_-]+)$/mu.exec(
      remoteResult.stdout,
    )?.[1];
    throw new Error(
      `remote ${suite} verification could not run at ${failedStage ?? "unknown stage"}`,
    );
  }
  const remote = parseJsonObject(remoteResult.stdout, `remote ${suite} verification`);

  if (suite === "all") {
    realOpenClawTests = [...recordArray(remote["real_openclaw_tests"]), ...realOpenClawTests];
  }

  const passed =
    remotePassed(remote) && (suite !== "all" || (realExitCode === 0 && realStatus === "PASS"));
  const providerBlocked = remote["provider_blocked"] === true || realStatus === "BLOCKED_EXTERNAL";
  const status = passed
    ? "PASS"
    : providerBlocked && remote["platform_passed"] === true
      ? "BLOCKED_EXTERNAL"
      : "FAIL";
  const report = {
    schema_version: "1.0",
    run_id: `phase6_${randomUUID()}`,
    generated_at: new Date().toISOString(),
    target: "redacted",
    status,
    suite,
    platform_passed: remote["platform_passed"] === true,
    provider_blocked: providerBlocked,
    real_openclaw_tests: realOpenClawTests,
    postgres_tests: recordArray(remote["postgres_tests"]),
    isolation_tests: recordArray(remote["isolation_tests"]),
    mock_tool_tests: recordArray(remote["mock_tool_tests"]),
    lifecycle_tests: recordArray(remote["lifecycle_tests"]),
    recovery_tests: recordArray(remote["recovery_tests"]),
  };
  await mkdir(dirname(localReportPath), { recursive: true });
  await writeFile(localReportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });

  const transferPath = resolve(workspaceRoot, "runtime/deploy/verification-summary.json");
  await mkdir(dirname(transferPath), { recursive: true, mode: 0o700 });
  await writeFile(transferPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try {
    copyFileToRemote(
      config,
      `verify-report-${suite}`,
      transferPath,
      `${config.remoteWorkdir}/reports/verification-summary.json`,
    );
  } finally {
    await rm(transferPath, { force: true });
  }

  console.log(`AgentNest ${suite} verification: ${status}`);
  console.log(`real_openclaw_tests: ${realOpenClawTests.length.toString()}`);
  console.log(`postgres_tests: ${recordArray(remote["postgres_tests"]).length.toString()}`);
  console.log(`isolation_tests: ${recordArray(remote["isolation_tests"]).length.toString()}`);
  console.log(
    `mock_tool_tests: ${Array.isArray(remote["mock_tool_tests"]) ? remote["mock_tool_tests"].length.toString() : "0"}`,
  );
  if (!passed) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown verification failure";
  console.error(`AgentNest verification failed: ${message}`);
  process.exitCode = 1;
});
