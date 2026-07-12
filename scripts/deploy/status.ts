import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./preflight.js";
import {
  parseKeyValueOutput,
  prepareRemoteTransport,
  runRemoteScript,
  workspaceRoot,
} from "./remote.js";

const localReportPath = resolve(workspaceRoot, "artifacts/reports/phase-6-status.json");

const remoteStatusScript = String.raw`set -u
workdir=$1
case "$workdir" in /*) ;; *) exit 20 ;; esac
if [ ! -f "$workdir/.agentnest-project" ] || [ "$(cat "$workdir/.agentnest-project")" != agentnest-demo ]; then
  printf 'PROJECT_MARKER=missing\n'
  exit 0
fi
printf 'PROJECT_MARKER=present\n'
source_dir="$workdir/source"
env_file="$workdir/config/agentnest.env"
if [ ! -f "$env_file" ] || [ ! -f "$source_dir/compose.yaml" ]; then
  printf 'DEPLOYMENT_FILES=missing\n'
  exit 0
fi
printf 'DEPLOYMENT_FILES=present\n'
if docker info >/dev/null 2>&1; then docker_cmd=docker; else docker_cmd='sudo -n docker'; fi
compose() { $docker_cmd compose --project-name agentnest-demo --env-file "$env_file" -f "$source_dir/compose.yaml" "$@"; }
expected=$(compose config --services 2>/dev/null | wc -l | tr -d ' ')
running_lines=$(compose ps --services --status running 2>/dev/null)
running=$(printf '%s\n' "$running_lines" | awk 'NF {count += 1} END {print count + 0}')
running_names=$(printf '%s\n' "$running_lines" | awk 'NF' | paste -sd, -)
if [ -z "$running_names" ]; then running_names=none; fi
printf 'SERVICE_EXPECTED=%s\n' "$expected"
printf 'SERVICE_RUNNING=%s\n' "$running"
printf 'SERVICE_RUNNING_NAMES=%s\n' "$running_names"
for service in postgres control-plane data-gateway-mock external-gateway-mock; do
  key=$(printf '%s' "$service" | tr '[:lower:]-' '[:upper:]_')
  container_id=$(compose ps --all --quiet "$service" 2>/dev/null || true)
  if [ -z "$container_id" ]; then
    state=missing
    health=none
    exit_code=none
  else
    state=$($docker_cmd inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || printf unknown)
    health=$($docker_cmd inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || printf unknown)
    exit_code=$($docker_cmd inspect --format '{{.State.ExitCode}}' "$container_id" 2>/dev/null || printf unknown)
  fi
  printf 'SERVICE_%s_STATE=%s\n' "$key" "$state"
  printf 'SERVICE_%s_HEALTH=%s\n' "$key" "$health"
  printf 'SERVICE_%s_EXIT=%s\n' "$key" "$exit_code"
done
set -a
. "$env_file"
set +a
health() { curl -fsS -H 'X-Request-Id: status-probe' "http://127.0.0.1:$1/health" >/dev/null 2>&1 && printf pass || printf fail; }
printf 'CONTROL_HEALTH=%s\n' "$(health "$CONTROL_PLANE_PORT")"
printf 'DATA_HEALTH=%s\n' "$(health "$DATA_GATEWAY_MOCK_PORT")"
printf 'EXTERNAL_HEALTH=%s\n' "$(health "$EXTERNAL_GATEWAY_MOCK_PORT")"
printf 'POSTGRES_HEALTH=%s\n' "$(compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" </dev/null >/dev/null 2>&1 && printf pass || printf fail)"
export OPENCLAW_STATE_DIR="$workdir/openclaw-state"
export OPENCLAW_CONFIG_PATH="$workdir/openclaw-state/openclaw.json"
if [ -f "$workdir/openclaw-state/.env" ]; then set -a; . "$workdir/openclaw-state/.env"; set +a; fi
printf 'OPENCLAW_VERSION=%s\n' "$(openclaw --version 2>/dev/null | tr '\r\n' ' ' || true)"
printf 'OPENCLAW_GATEWAY=%s\n' "$(openclaw gateway status --require-rpc --json >/dev/null 2>&1 && printf pass || printf fail)"
plugin_json=$(openclaw plugins list --json 2>/dev/null || printf '{}')
printf 'AGENTNEST_PLUGIN=%s\n' "$(printf '%s' "$plugin_json" | jq -e '.. | objects | select(.id? == "agentnest-tenant-runtime" and .enabled? != false and .error? == null and ((.status? // "loaded") | test("^(loaded|active|enabled|ready)$"; "i")))' >/dev/null 2>&1 && printf pass || printf fail)"
`;

async function main(): Promise<void> {
  const config = await loadConfig();
  await prepareRemoteTransport();
  const remote = runRemoteScript(config, "status", remoteStatusScript, [config.remoteWorkdir]);
  if (remote.status !== 0) {
    throw new Error(`remote status probe failed with exit code ${String(remote.status)}`);
  }
  const observed = parseKeyValueOutput(remote.stdout);
  const healthy =
    observed["PROJECT_MARKER"] === "present" &&
    observed["DEPLOYMENT_FILES"] === "present" &&
    observed["SERVICE_EXPECTED"] === "4" &&
    observed["SERVICE_RUNNING"] === "4" &&
    ["CONTROL_HEALTH", "DATA_HEALTH", "EXTERNAL_HEALTH", "POSTGRES_HEALTH"].every(
      (key) => observed[key] === "pass",
    ) &&
    observed["OPENCLAW_GATEWAY"] === "pass" &&
    observed["AGENTNEST_PLUGIN"] === "pass";
  const report = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    target: "redacted",
    status: healthy ? "PASS" : "FAIL",
    observed,
  };
  await mkdir(dirname(localReportPath), { recursive: true });
  await writeFile(localReportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  if (!healthy) {
    throw new Error("one or more project-owned services or the OpenClaw Gateway are unhealthy");
  }
  console.log("AgentNest remote status: PASS");
  console.log("services: 4/4 running and healthy");
  console.log(`OpenClaw: ${observed["OPENCLAW_VERSION"] ?? "unknown"}`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown status failure";
  console.error(`AgentNest status failed: ${message}`);
  process.exitCode = 1;
});
