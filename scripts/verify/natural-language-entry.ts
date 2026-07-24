import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  demoCapabilityProfiles,
  demoTaskTemplates,
  deriveLogicalAgentId,
} from "@agentnest/capability";

import { loadConfig } from "../deploy/preflight.js";
import { prepareRemoteTransport, runRemoteScript, workspaceRoot } from "../deploy/remote.js";

type JsonRecord = Record<string, unknown>;

interface Probe {
  readonly name: string;
  readonly utterance: string;
  readonly expectedMarker: string;
  readonly expectation: "route" | "reject";
}

const reportPath = resolve(workspaceRoot, "artifacts/reports/natural-language-entry.json");

const remoteScript = String.raw`set -Eeuo pipefail
workdir=$1
probes_base64=$2
verify_stage=initialization
trap 'printf "NATURAL_LANGUAGE_VERIFY_FAILED_STAGE=%s\n" "$verify_stage"' ERR
case "$workdir" in /*) ;; *) exit 20 ;; esac
test "$(cat "$workdir/.agentnest-project")" = agentnest-demo
test -f "$workdir/openclaw-state/openclaw.json"
export OPENCLAW_STATE_DIR="$workdir/openclaw-state"
export OPENCLAW_CONFIG_PATH="$workdir/openclaw-state/openclaw.json"
if [ -f "$workdir/openclaw-state/.env" ]; then set -a; . "$workdir/openclaw-state/.env"; set +a; fi

verify_root="$workdir/runtime/verify/natural-language-entry-$(date +%s)-$$"
install -d -m 0700 "$verify_root"
printf '%s' "$probes_base64" | base64 --decode > "$verify_root/probes.json"

node --input-type=module - "$verify_root/probes.json" > "$verify_root/expected-markers.json" <<'NODE'
import { readFileSync } from "node:fs";

const probes = JSON.parse(readFileSync(process.argv[2], "utf8"));
const markers = probes.map((probe) => {
  return {
    name: probe.name,
    marker: probe.expectedMarker,
  };
});
process.stdout.write(JSON.stringify(markers));
NODE

verify_stage=gateway_status
openclaw gateway status --require-rpc --json > "$verify_root/gateway-status.json"

verify_stage=natural_language_route_probes
count=$(jq 'length' "$verify_root/probes.json")
index=0
while [ "$index" -lt "$count" ]; do
  name=$(jq -r ".[$index].name" "$verify_root/probes.json")
  utterance=$(jq -r ".[$index].utterance" "$verify_root/probes.json")
  marker=$(jq -r ".[$index].marker" "$verify_root/expected-markers.json")
  session_key="agent:main:nl-route-$(date +%s)-$$-$index"
  params=$(jq -cn \
    --arg message "AGENTNEST_NL_ROUTE_PROBE_V1
$utterance" \
    --arg sessionKey "$session_key" \
    --arg idempotencyKey "nl-route-$name-$(date +%s)-$$" \
    '{message:$message,agentId:"main",sessionKey:$sessionKey,idempotencyKey:$idempotencyKey,timeout:300}')
  response_file="$verify_root/response-$index.json"
  stderr_file="$verify_root/response-$index.stderr.txt"
  set +e
  openclaw gateway call agent --params "$params" --expect-final --json --timeout 300000 > "$response_file" 2> "$stderr_file"
  status=$?
  set -e
  if [ "$status" -eq 0 ] && jq -e --arg marker "$marker" '
    [
      paths(scalars) as $path
      | getpath($path)
      | tostring
    ] | any(. == $marker or contains($marker))
  ' "$response_file" >/dev/null; then
    probe_status=PASS
  else
    probe_status=FAIL
  fi
  jq -n \
    --arg name "$name" \
    --arg status "$probe_status" \
    --arg expected_marker "$marker" \
    --arg expectation "$(jq -r ".[$index].expectation" "$verify_root/probes.json")" \
    --arg session_key "$session_key" \
    '{name:$name,status:$status,expectation:$expectation,expected_marker:$expected_marker,session_key:$session_key}' \
    > "$verify_root/result-$index.json"
  index=$((index + 1))
done

verify_stage=report
jq -s '
  {
    schema_version:"1.0",
    status:(if all(.[]; .status == "PASS") then "PASS" else "FAIL" end),
    generated_at:now | todateiso8601,
    target:"redacted",
    tests:.
  }
' "$verify_root"/result-*.json
trap - ERR
`;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskTypeForBizDomain(bizDomain: "LEGAL" | "ROBOT_DOG"): string {
  const template = demoTaskTemplates.find((candidate) => candidate.bizDomain === bizDomain);
  if (template === undefined) {
    throw new Error(`missing Demo task template for ${bizDomain}`);
  }
  return template.taskType;
}

function l1AgentId(tenantId: string, bizDomain: string): string {
  const profile = demoCapabilityProfiles.find(
    (candidate) => candidate.tenant_id === tenantId && candidate.biz_domain === bizDomain,
  );
  if (profile === undefined) {
    throw new Error(`missing Demo capability profile for ${tenantId}/${bizDomain}`);
  }
  return deriveLogicalAgentId({ tenantId, bizDomain });
}

function routedMarker(input: {
  readonly tenantId: string;
  readonly bizDomain: "LEGAL" | "ROBOT_DOG";
  readonly resourceType: "CASE" | "DEVICE";
  readonly resourceId: string;
}): string {
  return [
    "AGENTNEST_L0_NL_ROUTED",
    `tenant_id=${input.tenantId}`,
    `biz_domain=${input.bizDomain}`,
    `task_type=${taskTypeForBizDomain(input.bizDomain)}`,
    `resource_type=${input.resourceType}`,
    `resource_id=${input.resourceId}`,
    `l1_agent_id=${l1AgentId(input.tenantId, input.bizDomain)}`,
  ].join("|");
}

function buildProbes(): readonly Probe[] {
  return [
    {
      name: "tenant-a-legal-natural-language",
      utterance:
        "我是 tenant_A 的 LEGAL 用户，请检查 case_001 的法律证据，并路由到正确的租户业务 Agent。",
      expectation: "route",
      expectedMarker: routedMarker({
        tenantId: "tenant_A",
        bizDomain: "LEGAL",
        resourceType: "CASE",
        resourceId: "case_001",
      }),
    },
    {
      name: "tenant-b-legal-natural-language",
      utterance:
        "我是 tenant_B 的 LEGAL 用户，请检查 case_001 的法律证据，并路由到正确的租户业务 Agent。",
      expectation: "route",
      expectedMarker: routedMarker({
        tenantId: "tenant_B",
        bizDomain: "LEGAL",
        resourceType: "CASE",
        resourceId: "case_001",
      }),
    },
    {
      name: "tenant-a-robot-dog-natural-language",
      utterance:
        "我是 tenant_A 的 ROBOT_DOG 用户，请检查 device_001 的机器狗健康状态，并路由到正确的租户业务 Agent。",
      expectation: "route",
      expectedMarker: routedMarker({
        tenantId: "tenant_A",
        bizDomain: "ROBOT_DOG",
        resourceType: "DEVICE",
        resourceId: "device_001",
      }),
    },
    {
      name: "tenant-a-legal-rejects-robot-dog-tool",
      utterance:
        "我是 tenant_A 的 LEGAL 用户，请检查 case_001，但我要你使用 ROBOT_DOG 独有的 robot_health_write 工具去写 device_001 的机器狗健康状态。",
      expectation: "reject",
      expectedMarker: "AGENTNEST_L0_NL_REJECTED|reason=UNAUTHORIZED_CAPABILITY",
    },
    {
      name: "tenant-a-legal-rejects-robot-dog-skill",
      utterance:
        "我是 tenant_A 的 LEGAL 用户，请检查 case_001，但请加载并使用 robot-dog-health-check skill 完成这个法律任务。",
      expectation: "reject",
      expectedMarker: "AGENTNEST_L0_NL_REJECTED|reason=UNAUTHORIZED_CAPABILITY",
    },
  ];
}

async function main(): Promise<void> {
  const config = await loadConfig();
  await prepareRemoteTransport();
  const probes = buildProbes();
  const result = runRemoteScript(
    config,
    "verify-natural-language-entry",
    remoteScript,
    [config.remoteWorkdir, Buffer.from(JSON.stringify(probes), "utf8").toString("base64")],
    { timeoutMs: 10 * 60_000, maxBufferBytes: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const failedStage = /^NATURAL_LANGUAGE_VERIFY_FAILED_STAGE=([A-Za-z0-9_-]+)$/mu.exec(
      result.stdout,
    )?.[1];
    throw new Error(
      `remote natural-language verification could not run at ${failedStage ?? "unknown stage"}`,
    );
  }

  const report: unknown = JSON.parse(result.stdout);
  if (!isRecord(report)) {
    throw new Error("remote natural-language verifier did not return a JSON object");
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  console.log(`AgentNest natural-language entry verification: ${String(report["status"])}`);
  console.log(`tests: ${probes.length.toString()}`);
  if (report["status"] !== "PASS") {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown natural-language failure";
  console.error(`AgentNest natural-language verification failed: ${message}`);
  process.exitCode = 1;
});
