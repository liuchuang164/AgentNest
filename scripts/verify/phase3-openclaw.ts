import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  demoCapabilityProfiles,
  demoTaskTemplates,
  deriveLogicalAgentId,
} from "@agentnest/capability";

import {
  OPENCLAW_2026_6_11,
  assertExpectedOpenClawVersion,
} from "../../packages/openclaw-adapter/src/index.js";
import { loadConfig, resolveStableVersion, type PreflightConfig } from "../deploy/preflight.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const knownHostsPath = resolve(workspaceRoot, "runtime/ssh/known_hosts");
const reportPath = resolve(workspaceRoot, "artifacts/reports/phase-3-remote-e2e.json");

interface RemoteResult {
  readonly status: number;
  readonly stdout: string;
}

interface ProbeExpectations {
  readonly expectedOpenClawVersion: string;
  readonly taskId: string;
  readonly probeId: string;
  readonly executionContextId: string;
  readonly mainSessionKey: string;
  readonly l1AgentId: string;
  readonly l1SessionKey: string;
  readonly l2AgentId: string;
  readonly legalSkill: string;
  readonly robotSkill: string;
  readonly legalTools: readonly string[];
  readonly robotTools: readonly string[];
  readonly allBusinessTools: readonly string[];
  readonly mainMarker: string;
  readonly l2Marker: string;
}

type JsonRecord = Record<string, unknown>;

const remoteEvidenceAnalyzer = String.raw`import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.argv[2];
const root = resolve(process.argv[3]);
const readText = (name) => readFileSync(resolve(root, name), "utf8").trim();
const readJson = (name) => JSON.parse(readText(name));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const expected = readJson("expected.json");

const objects = (value, output = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) objects(entry, output);
  } else if (isObject(value)) {
    output.push(value);
    for (const entry of Object.values(value)) objects(entry, output);
  }
  return output;
};
const strings = (value, output = []) => {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, output);
  else if (isObject(value)) for (const entry of Object.values(value)) strings(entry, output);
  return output;
};
const contains = (value, needle) => strings(value).some((entry) => entry.includes(needle));
const directValue = (value, keys) => {
  for (const entry of objects(value)) {
    for (const key of keys) {
      if (typeof entry[key] === "string") return entry[key];
    }
  }
  return null;
};
const directValues = (value, keys) => {
  const output = [];
  for (const entry of objects(value)) {
    for (const key of keys) {
      if (typeof entry[key] === "string") output.push(entry[key]);
    }
  }
  return [...new Set(output)];
};
const hasAssistantMarker = (value, marker) =>
  objects(value).some((entry) => {
    const role = entry.role ?? (isObject(entry.message) ? entry.message.role : undefined);
    return role === "assistant" && contains(entry, marker);
  });
const findMarker = (value, marker) => (contains(value, marker) ? marker : null);
const sessionRows = (value) =>
  objects(value).filter(
    (entry) => typeof entry.key === "string" || typeof entry.sessionKey === "string",
  );
const hasSession = (value, key, agentId) =>
  sessionRows(value).some((entry) => {
    const observedKey = entry.key ?? entry.sessionKey;
    const observedAgent = entry.agentId ?? entry.agent_id;
    return observedKey === key &&
      (observedAgent === undefined || observedAgent === agentId || key.startsWith("agent:" + agentId + ":"));
  });
const asStrings = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
const sorted = (value) => [...new Set(value)].sort();
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const knownNames = (value, allowed) => {
  const candidates = directValues(value, ["name", "toolName", "id", "skillName"]);
  return sorted(candidates.filter((entry) => allowed.includes(entry)));
};
const parseExit = (name) => Number(readText(name));
const safeRunId = (value) => {
  const candidate = directValue(value, ["runId", "run_id"]);
  return candidate !== null && /^[A-Za-z0-9_-]{6,128}$/.test(candidate) ? candidate : null;
};

const locateTask = () => {
  const tasks = readJson("tasks.json");
  const sessions = readJson("sessions.json");
  const candidates = objects(tasks)
    .filter((entry) => contains(entry, expected.taskId))
    .filter((entry) => contains(entry, expected.l2AgentId))
    .filter((entry) => contains(entry, expected.l1SessionKey))
    .sort((left, right) => JSON.stringify(left).length - JSON.stringify(right).length);
  const task = candidates[0];
  if (task === undefined) process.exit(2);
  const childSessionKey = strings(task).find(
    (entry) => entry.startsWith("agent:" + expected.l2AgentId + ":subagent:"),
  );
  if (childSessionKey === undefined || !hasSession(sessions, childSessionKey, expected.l2AgentId)) {
    process.exit(3);
  }
  const status = directValue(task, ["status", "state"]);
  const runId = safeRunId(task);
  writeFileSync(
    resolve(root, "child-meta.json"),
    JSON.stringify({ childSessionKey, runId, status, parentSessionObserved: true }),
  );
};

const providerError = () => {
  const combined = ["main-rpc.json", "main-rpc.stderr.txt"]
    .map((name) => {
      try { return readText(name); } catch { return ""; }
    })
    .join("\n");
  if (/Arrearage|make sure your account is in good standing|account (?:is )?not in good standing|account.*in arrears|overdue-payment/i.test(combined)) {
    return {
      http_status: 400,
      code: "Arrearage",
      message: "The model-provider account is in arrears or not in good standing.",
    };
  }
  if (/quota|billing|insufficient[_ -]balance|payment required/i.test(combined)) {
    return {
      http_status: /(?:HTTP\s*)?402|status(?:Code)?["':=\s]+402/i.test(combined) ? 402 : null,
      code: "PROVIDER_BILLING_BLOCK",
      message: "The model provider rejected the request for quota or billing reasons.",
    };
  }
  return null;
};

if (mode === "locate") {
  locateTask();
  process.exit(0);
}
if (mode === "main-accepted") {
  const rpc = readJson("main-rpc.json");
  process.exit(findMarker(rpc, expected.mainMarker) === expected.mainMarker && providerError() === null ? 0 : 1);
}
if (mode === "marker") {
  locateTask();
  const meta = readJson("child-meta.json");
  const history = readJson("child-history.json");
  const terminal = ["succeeded", "completed"].includes(String(meta.status).toLowerCase());
  process.exit(terminal && hasAssistantMarker(history, expected.l2Marker) ? 0 : 1);
}
if (mode !== "final") throw new Error("unsupported analyzer mode");

const versionRaw = readText("version.txt");
const versionMatch = /^(?:OpenClaw\s+)?(\d+\.\d+\.\d+)(?:\s+\(([0-9a-f]{7,40})\))?$/i.exec(versionRaw);
if (versionMatch === null) throw new Error("invalid OpenClaw version output");
const observedVersion = versionMatch[1];
const observedCommit = versionMatch[2] ?? null;

const gatewayDocument = readJson("gateway-config.json");
const gateway = isObject(gatewayDocument.gateway) ? gatewayDocument.gateway : gatewayDocument;
const gatewayStaticOk = gateway.mode === "local" && gateway.bind === "loopback" && Number(gateway.port) === Number(expected.gatewayPort);

const doctor = readJson("doctor.json");
const doctorErrors = objects(doctor).filter((entry) => String(entry.severity).toLowerCase() === "error").length;
const doctorWarnings = objects(doctor).filter((entry) => String(entry.severity).toLowerCase() === "warn").length;

const agentsDocument = readJson("agents-config.json");
const agents = isObject(agentsDocument.agents) ? agentsDocument.agents : agentsDocument;
const profileList = Array.isArray(agents.list) ? agents.list.filter(isObject) : [];
const profile = (id) => profileList.find((entry) => entry.id === id);
const mainProfile = profile("main");
const l1Profile = profile(expected.l1AgentId);
const l2Profile = profile(expected.l2AgentId);
const profileTools = (entry, key) => isObject(entry?.tools) ? asStrings(entry.tools[key]) : [];
const profileSkills = (entry) => asStrings(entry?.skills);
const profileSubagents = (entry) => isObject(entry?.subagents) ? asStrings(entry.subagents.allowAgents) : [];
const allProfilesPresent = mainProfile !== undefined && l1Profile !== undefined && l2Profile !== undefined;
const expectedRoot = resolve(expected.remoteWorkdir, "runtime/openclaw");
const expectedWorkspace = (id) => resolve(expectedRoot, "workspaces", id);
const expectedAgentDir = (id) => resolve(expectedRoot, "agents", id, "agent");
const pathOk = (entry, id) => entry?.workspace === expectedWorkspace(id) && entry?.agentDir === expectedAgentDir(id);
const distinctPaths = allProfilesPresent && new Set([mainProfile.workspace, l1Profile.workspace, l2Profile.workspace]).size === 3 &&
  new Set([mainProfile.agentDir, l1Profile.agentDir, l2Profile.agentDir]).size === 3;

const mainAllow = profileTools(mainProfile, "allow");
const mainDeny = profileTools(mainProfile, "deny");
const l1Allow = profileTools(l1Profile, "allow");
const l1Deny = profileTools(l1Profile, "deny");
const l2Allow = profileTools(l2Profile, "allow");
const l2Deny = profileTools(l2Profile, "deny");
const staticToolsOk =
  mainAllow.includes("sessions_send") && expected.allBusinessTools.every((name) => !mainAllow.includes(name) && mainDeny.includes(name)) &&
  l1Allow.includes("sessions_spawn") && expected.legalTools.every((name) => l1Allow.includes(name)) && expected.robotTools.every((name) => !l1Allow.includes(name) && l1Deny.includes(name)) &&
  expected.legalTools.every((name) => l2Allow.includes(name)) && expected.robotTools.every((name) => !l2Allow.includes(name) && l2Deny.includes(name)) &&
  !l2Allow.includes("sessions_spawn") && sameSet(profileSubagents(l1Profile), [expected.l2AgentId]);
const staticSkillsOk = sameSet(profileSkills(mainProfile), []) && sameSet(profileSkills(l1Profile), [expected.legalSkill]) && sameSet(profileSkills(l2Profile), [expected.legalSkill]);

const listedAgents = directValues(readJson("agents-list.json"), ["id", "agentId"]);
const observedProfilesOk = ["main", expected.l1AgentId, expected.l2AgentId].every((id) => listedAgents.includes(id));
const businessSkills = [expected.legalSkill, expected.robotSkill];
const mainSkills = knownNames(readJson("skills-main.json"), businessSkills);
const l1Skills = knownNames(readJson("skills-l1.json"), businessSkills);
const l2Skills = knownNames(readJson("skills-l2.json"), businessSkills);
const observedSkillsOk = sameSet(mainSkills, []) && sameSet(l1Skills, [expected.legalSkill]) && sameSet(l2Skills, [expected.legalSkill]);

const knownTools = [...expected.allBusinessTools, "sessions_send", "sessions_spawn", "session_status"];
const effective = (name) => {
  const exit = parseExit("effective-" + name + ".exit.txt");
  if (exit !== 0) return { available: false, tools: [] };
  return { available: true, tools: knownNames(readJson("effective-" + name + ".json"), knownTools) };
};
const mainEffective = effective("main");
const l1Effective = effective("l1");
const l2Effective = effective("l2");
const effectiveIsolationOk = mainEffective.available && l1Effective.available && l2Effective.available &&
  mainEffective.tools.includes("sessions_send") && !mainEffective.tools.some((name) => expected.allBusinessTools.includes(name)) &&
  l1Effective.tools.includes("sessions_spawn") && !l1Effective.tools.some((name) => expected.robotTools.includes(name)) &&
  !l2Effective.tools.includes("sessions_spawn") && !l2Effective.tools.some((name) => expected.robotTools.includes(name));

const sessions = readJson("sessions.json");
const mainRpc = readJson("main-rpc.json");
const mainOutput = findMarker(mainRpc, expected.mainMarker);
const embeddedFallback = objects(mainRpc).some((entry) => entry.transport === "embedded" || entry.fallbackFrom === "gateway");
let childMeta = null;
let childHistory = null;
let l1History = null;
try { childMeta = readJson("child-meta.json"); } catch {}
try { childHistory = readJson("child-history.json"); } catch {}
try { l1History = readJson("l1-history.json"); } catch {}
const childKey = isObject(childMeta) && typeof childMeta.childSessionKey === "string" ? childMeta.childSessionKey : null;
const l1Marker = childKey === null ? null : "AGENTNEST_L1_SPAWNED|task_id=" + expected.taskId + "|l1_agent_id=" + expected.l1AgentId + "|l2_agent_id=" + expected.l2AgentId + "|child_session_key=" + childKey;
const nativeTask = isObject(childMeta) && childMeta.parentSessionObserved === true && ["succeeded", "completed"].includes(String(childMeta.status).toLowerCase());
const markerPersisted = childHistory !== null && hasAssistantMarker(childHistory, expected.l2Marker);
const l1LinkedChild = l1History !== null && l1Marker !== null && hasAssistantMarker(l1History, l1Marker);
const sessionEvidence = {
  main_probe_observed: hasSession(sessions, expected.mainSessionKey, "main"),
  l1_stable_observed: hasSession(sessions, expected.l1SessionKey, expected.l1AgentId),
  l2_child_observed: childKey !== null && hasSession(sessions, childKey, expected.l2AgentId),
};

const staticEvidenceOk = observedVersion === expected.expectedOpenClawVersion && gatewayStaticOk && doctorErrors === 0 && allProfilesPresent &&
  pathOk(mainProfile, "main") && pathOk(l1Profile, expected.l1AgentId) && pathOk(l2Profile, expected.l2AgentId) && distinctPaths &&
  staticToolsOk && staticSkillsOk && observedProfilesOk && observedSkillsOk;
const chainOk = parseExit("main-rpc.exit.txt") === 0 && mainOutput === expected.mainMarker && !embeddedFallback && nativeTask && markerPersisted &&
  l1LinkedChild && Object.values(sessionEvidence).every(Boolean) && effectiveIsolationOk;
const externalError = providerError();
const status = staticEvidenceOk && chainOk ? "PASS" : staticEvidenceOk && externalError !== null ? "BLOCKED_EXTERNAL" : "FAIL";

const report = {
  schema_version: "1.0",
  generated_at: new Date().toISOString(),
  target: "redacted",
  status,
  openclaw: {
    expected_version: expected.expectedOpenClawVersion,
    observed_version: observedVersion,
    observed_commit: observedCommit,
    version_output: versionRaw,
    gateway: { command_succeeded: true, rpc_ready: true, mode: gateway.mode, bind: gateway.bind, port: Number(gateway.port) },
    doctor: { command_succeeded: true, error_count: doctorErrors, warning_count: doctorWarnings },
  },
  probe: {
    task_id: expected.taskId,
    tenant_id: "tenant_A",
    biz_domain: "LEGAL",
    task_type: "LEGAL_EVIDENCE_CHECK",
    phase3_chain_probe: true,
    main_session_key: expected.mainSessionKey,
    main_run_id: safeRunId(mainRpc),
    main_final_output: mainOutput,
    l1_agent_id: expected.l1AgentId,
    l1_session_key: expected.l1SessionKey,
    l2_agent_id: expected.l2AgentId,
    l2_run_id: isObject(childMeta) && typeof childMeta.runId === "string" ? childMeta.runId : null,
    l2_child_session_key: childKey,
    l2_marker: markerPersisted ? expected.l2Marker : null,
    session_evidence: sessionEvidence,
    native_sessions_spawn_task_evidence: nativeTask,
    l1_child_link_evidence: l1LinkedChild,
    persisted_child_marker_evidence: markerPersisted,
    embedded_fallback_observed: embeddedFallback,
  },
  profiles: {
    observed_ids: ["main", expected.l1AgentId, expected.l2AgentId].filter((id) => listedAgents.includes(id)),
    distinct_workspaces: distinctPaths,
    distinct_agent_dirs: distinctPaths,
    expected_paths_observed: allProfilesPresent && pathOk(mainProfile, "main") && pathOk(l1Profile, expected.l1AgentId) && pathOk(l2Profile, expected.l2AgentId),
  },
  skills: { main: mainSkills, l1: l1Skills, l2: l2Skills, isolation_passed: observedSkillsOk && staticSkillsOk },
  tools: {
    configured: { main_allow: mainAllow, main_deny: mainDeny, l1_allow: l1Allow, l1_deny: l1Deny, l2_allow: l2Allow, l2_deny: l2Deny, isolation_passed: staticToolsOk },
    effective: { main: mainEffective, l1: l1Effective, l2: l2Effective, isolation_passed: effectiveIsolationOk },
  },
  external_blocker: status === "BLOCKED_EXTERNAL" ? { provider: "qwen", ...externalError } : null,
  claims: {
    openclaw_chain: chainOk ? "REAL_GATEWAY_RPC_L0_L1_NATIVE_L2" : "NOT_COMPLETED",
    gateway_rpc_method: "openclaw gateway call agent",
    embedded_fallback_used: embeddedFallback,
    business_tool_execution: "NOT_RUN_PHASE3_CHAIN_PROBE",
    gateway_mock_claimed: false,
  },
};
process.stdout.write(JSON.stringify(report));
`;

const remoteVerifyScript = String.raw`set -eu
workdir=$1
gateway_port=$2
probe_id=$3
expected_base64=$4
analyzer_base64=$5
state_dir="$workdir/openclaw-state"
verify_root="$workdir/runtime/verify"
verify_dir="$verify_root/$probe_id"

if ! printf '%s' "$probe_id" | grep -Eq '^p3-[a-f0-9]{16}$'; then
  printf 'VERIFY_FAILED_STAGE=invalid_probe_id\n'
  exit 2
fi
if [ ! -f "$state_dir/.env" ]; then
  printf 'VERIFY_FAILED_STAGE=missing_project_env\n'
  exit 2
fi
umask 077
install -d -m 0700 "$verify_root" "$verify_dir"
cleanup() {
  rm -f "$verify_dir"/*.json "$verify_dir"/*.txt "$verify_dir"/*.mjs 2>/dev/null || true
  rmdir "$verify_dir" 2>/dev/null || true
}
trap cleanup EXIT
printf '%s' "$expected_base64" | base64 --decode > "$verify_dir/expected.json"
printf '%s' "$analyzer_base64" | base64 --decode > "$verify_dir/analyze.mjs"
chmod 0600 "$verify_dir/expected.json" "$verify_dir/analyze.mjs"

export OPENCLAW_STATE_DIR="$state_dir"
export OPENCLAW_CONFIG_PATH="$state_dir/openclaw.json"
export NO_COLOR=1
set -a
. "$state_dir/.env"
set +a

fail() {
  printf 'VERIFY_FAILED_STAGE=%s\n' "$1"
  exit 3
}
capture() {
  stage=$1
  output=$2
  shift 2
  if ! "$@" > "$output" 2>/dev/null; then fail "$stage"; fi
}
optional() {
  output=$1
  exit_file=$2
  shift 2
  set +e
  "$@" > "$output" 2>/dev/null
  command_status=$?
  set -e
  printf '%s\n' "$command_status" > "$exit_file"
}

capture version "$verify_dir/version.txt" openclaw --version
capture gateway_status "$verify_dir/gateway-status.json" openclaw gateway status --require-rpc --json
capture gateway_config "$verify_dir/gateway-config.json" openclaw config get gateway --json
capture doctor "$verify_dir/doctor.json" openclaw doctor --lint --json --non-interactive --no-workspace-suggestions
capture agents_config "$verify_dir/agents-config.json" openclaw config get agents --json
capture agents_list "$verify_dir/agents-list.json" openclaw agents list --json

l1_agent_id=$(jq -r '.l1AgentId' "$verify_dir/expected.json")
l2_agent_id=$(jq -r '.l2AgentId' "$verify_dir/expected.json")
task_id=$(jq -r '.taskId' "$verify_dir/expected.json")
execution_context_id=$(jq -r '.executionContextId' "$verify_dir/expected.json")
main_session_key=$(jq -r '.mainSessionKey' "$verify_dir/expected.json")
l1_session_key=$(jq -r '.l1SessionKey' "$verify_dir/expected.json")
capture skills_main "$verify_dir/skills-main.json" openclaw skills list --agent main --eligible --json
capture skills_l1 "$verify_dir/skills-l1.json" openclaw skills list --agent "$l1_agent_id" --eligible --json
capture skills_l2 "$verify_dir/skills-l2.json" openclaw skills list --agent "$l2_agent_id" --eligible --json

probe_message=$(printf '%s\n' \
  "AGENTNEST_CONTROLLER_CONTEXT_V1 {\"execution_context_id\":\"$execution_context_id\"}" \
  'AgentNest Phase 3 deterministic chain probe. Follow the configured routing instructions exactly.' \
  "task_id=$task_id" \
  'tenant_id=tenant_A' \
  'biz_domain=LEGAL' \
  'task_type=LEGAL_EVIDENCE_CHECK' \
  'resource_type=CASE' \
  'resource_id=case_001' \
  'phase3_chain_probe=true' \
  'Do not execute or claim a business tool call for this Phase 3 probe.')
main_params=$(jq -cn \
  --arg message "$probe_message" \
  --arg sessionKey "$main_session_key" \
  --arg idempotencyKey "phase3-$probe_id" \
  '{message:$message,agentId:"main",sessionKey:$sessionKey,idempotencyKey:$idempotencyKey,timeout:600}')
set +e
openclaw gateway call agent --params "$main_params" --expect-final --json --timeout 600000 \
  > "$verify_dir/main-rpc.json" 2> "$verify_dir/main-rpc.stderr.txt"
main_status=$?
set -e
printf '%s\n' "$main_status" > "$verify_dir/main-rpc.exit.txt"
if ! jq -e . "$verify_dir/main-rpc.json" >/dev/null 2>&1; then
  printf '{}\n' > "$verify_dir/main-rpc.json"
fi

capture sessions "$verify_dir/sessions.json" openclaw sessions --all-agents --json
capture tasks "$verify_dir/tasks.json" openclaw tasks list --runtime subagent --json

chain_candidate=no
if [ "$main_status" -eq 0 ] && node "$verify_dir/analyze.mjs" main-accepted "$verify_dir" >/dev/null 2>&1; then
  chain_candidate=yes
fi
marker_ready=no
attempt=0
while [ "$chain_candidate" = yes ] && [ "$attempt" -lt 120 ]; do
  capture sessions "$verify_dir/sessions.json" openclaw sessions --all-agents --json
  capture tasks "$verify_dir/tasks.json" openclaw tasks list --runtime subagent --json
  if node "$verify_dir/analyze.mjs" locate "$verify_dir" >/dev/null 2>&1; then
    child_key=$(jq -r '.childSessionKey' "$verify_dir/child-meta.json")
    child_params=$(jq -cn --arg sessionKey "$child_key" '{sessionKey:$sessionKey,limit:100,maxChars:500000}')
    optional "$verify_dir/child-history.json" "$verify_dir/child-history.exit.txt" \
      openclaw gateway call chat.history --params "$child_params" --json --timeout 30000
    if [ "$(cat "$verify_dir/child-history.exit.txt")" -eq 0 ] && \
      node "$verify_dir/analyze.mjs" marker "$verify_dir" >/dev/null 2>&1; then
      marker_ready=yes
      break
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done

l1_params=$(jq -cn --arg sessionKey "$l1_session_key" '{sessionKey:$sessionKey,limit:100,maxChars:500000}')
optional "$verify_dir/l1-history.json" "$verify_dir/l1-history.exit.txt" \
  openclaw gateway call chat.history --params "$l1_params" --json --timeout 30000
main_tools_params=$(jq -cn --arg sessionKey "$main_session_key" '{sessionKey:$sessionKey}')
l1_tools_params=$(jq -cn --arg sessionKey "$l1_session_key" '{sessionKey:$sessionKey}')
optional "$verify_dir/effective-main.json" "$verify_dir/effective-main.exit.txt" \
  openclaw gateway call tools.effective --params "$main_tools_params" --json --timeout 30000
optional "$verify_dir/effective-l1.json" "$verify_dir/effective-l1.exit.txt" \
  openclaw gateway call tools.effective --params "$l1_tools_params" --json --timeout 30000
if [ "$marker_ready" = yes ]; then
  child_key=$(jq -r '.childSessionKey' "$verify_dir/child-meta.json")
  l2_tools_params=$(jq -cn --arg sessionKey "$child_key" '{sessionKey:$sessionKey}')
  optional "$verify_dir/effective-l2.json" "$verify_dir/effective-l2.exit.txt" \
    openclaw gateway call tools.effective --params "$l2_tools_params" --json --timeout 30000
else
  printf '1\n' > "$verify_dir/effective-l2.exit.txt"
fi

node "$verify_dir/analyze.mjs" final "$verify_dir"
`;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let value = root;
  for (const key of path) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

function requireString(root: unknown, path: readonly string[]): string {
  const value = valueAt(root, path);
  if (typeof value !== "string") {
    throw new Error(`remote evidence is missing ${path.join(".")}`);
  }
  return value;
}

function requireBoolean(root: unknown, path: readonly string[]): boolean {
  const value = valueAt(root, path);
  if (typeof value !== "boolean") {
    throw new Error(`remote evidence is missing ${path.join(".")}`);
  }
  return value;
}

function deriveL2AgentId(logicalAgentId: string, taskType: string): string {
  const digest = createHash("sha256")
    .update(`${logicalAgentId}:${taskType}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `l2_${digest}`;
}

function buildExpectations(
  remoteWorkdir: string,
  gatewayPort: number,
): ProbeExpectations & {
  readonly remoteWorkdir: string;
  readonly gatewayPort: number;
} {
  const legal = demoCapabilityProfiles.find(
    (profile) => profile.tenant_id === "tenant_A" && profile.biz_domain === "LEGAL",
  );
  const robot = demoCapabilityProfiles.find(
    (profile) => profile.tenant_id === "tenant_A" && profile.biz_domain === "ROBOT_DOG",
  );
  const template = demoTaskTemplates.find(
    (candidate) => candidate.taskType === "LEGAL_EVIDENCE_CHECK",
  );
  if (legal === undefined || robot === undefined || template === undefined) {
    throw new Error("required Phase 3 Demo capability profiles are missing");
  }
  const legalSkill = legal.skills[0];
  const robotSkill = robot.skills[0];
  if (legalSkill === undefined || robotSkill === undefined) {
    throw new Error("required Phase 3 Demo skills are missing");
  }
  const probeId = `p3-${randomBytes(8).toString("hex")}`;
  const taskId = `p3_${probeId.slice(3)}`;
  const l1AgentId = deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" });
  const l2AgentId = deriveL2AgentId(l1AgentId, template.taskType);
  const l1SessionKey = `agent:${l1AgentId}:main`;
  const mainSessionKey = `agent:main:${probeId}`;
  return {
    expectedOpenClawVersion: OPENCLAW_2026_6_11,
    taskId,
    probeId,
    executionContextId: randomUUID(),
    mainSessionKey,
    l1AgentId,
    l1SessionKey,
    l2AgentId,
    legalSkill,
    robotSkill,
    legalTools: Object.keys(legal.tools).sort(),
    robotTools: Object.keys(robot.tools).sort(),
    allBusinessTools: [
      ...new Set([...Object.keys(legal.tools), ...Object.keys(robot.tools)]),
    ].sort(),
    mainMarker: `AGENTNEST_L0_DISPATCHED|task_id=${taskId}|l1_session_key=${l1SessionKey}`,
    l2Marker: `AGENTNEST_L2_RESULT|task_id=${taskId}|task_type=LEGAL_EVIDENCE_CHECK|status=CHAIN_OK|role=LEGAL|tool_mode=NOT_RUN`,
    remoteWorkdir,
    gatewayPort,
  };
}

function sshInvocation(config: PreflightConfig): {
  readonly arguments_: string[];
  readonly environment: NodeJS.ProcessEnv;
} {
  const arguments_ = [
    "-T",
    "-p",
    String(config.sshPort),
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "HashKnownHosts=yes",
    "-o",
    "LogLevel=ERROR",
  ];
  const environment: NodeJS.ProcessEnv = { ...process.env };
  if (config.authMode === "password") {
    arguments_.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
    environment["SSH_ASKPASS"] = askpassPath;
    environment["SSH_ASKPASS_REQUIRE"] = "force";
    environment["DISPLAY"] = "agentnest-phase3-verify:0";
    environment["AGENTNEST_SSH_PASSWORD"] = config.password ?? "";
  } else {
    arguments_.push("-o", "BatchMode=yes", "-i", config.privateKeyPath ?? "");
  }
  arguments_.push(`${config.sshUser}@${config.sshHost}`);
  return { arguments_, environment };
}

function runRemote(
  config: PreflightConfig,
  expectations: ProbeExpectations & {
    readonly remoteWorkdir: string;
    readonly gatewayPort: number;
  },
): RemoteResult {
  const invocation = sshInvocation(config);
  invocation.arguments_.push(
    "bash",
    "-s",
    "--",
    config.remoteWorkdir,
    String(expectations.gatewayPort),
    expectations.probeId,
    Buffer.from(JSON.stringify(expectations), "utf8").toString("base64"),
    Buffer.from(remoteEvidenceAnalyzer, "utf8").toString("base64"),
  );
  const result = spawnSync("ssh", invocation.arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: invocation.environment,
    input: remoteVerifyScript,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  delete invocation.environment["AGENTNEST_SSH_PASSWORD"];
  return { status: result.status ?? 1, stdout: result.stdout };
}

function assertNoCredentialMaterial(report: unknown, config: PreflightConfig): void {
  const serialized = JSON.stringify(report);
  const forbiddenValues = [
    config.password,
    config.modelApiKey,
    config.privateKeyPath,
    config.sshHost,
    config.sshUser,
  ].filter((value): value is string => value !== null && value.length >= 3);
  if (forbiddenValues.some((value) => serialized.includes(value))) {
    throw new Error("remote evidence contained forbidden target or credential material");
  }
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (
        /password|authorization|credential|api[_-]?key|private[_-]?key|secret|token/iu.test(key)
      ) {
        throw new Error("remote evidence contained a forbidden sensitive field");
      }
      inspect(entry);
    }
  };
  inspect(report);
}

function validateRemoteEvidence(
  report: unknown,
  expectations: ProbeExpectations,
  expectedVersion: string,
): "PASS" | "BLOCKED_EXTERNAL" | "FAIL" {
  const status = requireString(report, ["status"]);
  if (status !== "PASS" && status !== "BLOCKED_EXTERNAL" && status !== "FAIL") {
    throw new Error("remote evidence returned an unknown status");
  }
  const rawVersion = requireString(report, ["openclaw", "version_output"]);
  assertExpectedOpenClawVersion(rawVersion, expectedVersion);
  if (requireString(report, ["openclaw", "observed_version"]) !== expectedVersion) {
    throw new Error("remote OpenClaw version did not match the official stable baseline");
  }
  if (!requireBoolean(report, ["openclaw", "gateway", "rpc_ready"])) {
    throw new Error("remote loopback Gateway RPC was not ready");
  }
  if (!requireBoolean(report, ["profiles", "distinct_workspaces"])) {
    throw new Error("Phase 3 profiles did not have distinct workspaces");
  }
  if (!requireBoolean(report, ["profiles", "distinct_agent_dirs"])) {
    throw new Error("Phase 3 profiles did not have distinct agent directories");
  }
  if (!requireBoolean(report, ["skills", "isolation_passed"])) {
    throw new Error("Phase 3 observed Skill isolation failed");
  }
  if (!requireBoolean(report, ["tools", "configured", "isolation_passed"])) {
    throw new Error("Phase 3 configured Tool isolation failed");
  }
  if (status === "PASS") {
    if (requireString(report, ["probe", "main_final_output"]) !== expectations.mainMarker) {
      throw new Error("the real L0 final marker was not observed");
    }
    if (requireString(report, ["probe", "l1_session_key"]) !== expectations.l1SessionKey) {
      throw new Error("the stable L1 session key was not observed");
    }
    if (requireString(report, ["probe", "l2_marker"]) !== expectations.l2Marker) {
      throw new Error("the persisted L2 result marker was not observed");
    }
    for (const path of [
      ["probe", "native_sessions_spawn_task_evidence"],
      ["probe", "l1_child_link_evidence"],
      ["probe", "persisted_child_marker_evidence"],
      ["tools", "effective", "isolation_passed"],
    ] as const) {
      if (!requireBoolean(report, path)) {
        throw new Error(`required real-chain evidence failed: ${path.join(".")}`);
      }
    }
  } else if (status === "BLOCKED_EXTERNAL") {
    if (requireString(report, ["external_blocker", "code"]) !== "Arrearage") {
      throw new Error("external model-provider blocker was not safely classified");
    }
  }
  return status;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const stable = await resolveStableVersion();
  if (stable.version !== OPENCLAW_2026_6_11) {
    throw new Error(
      `official stable is ${stable.version}; Phase 3 profiles must be reconfigured before verification`,
    );
  }
  await chmod(askpassPath, 0o755);
  const gatewayPort = config.ports[0] ?? 18_789;
  const expectations = buildExpectations(config.remoteWorkdir, gatewayPort);
  const remote = runRemote(config, expectations);
  if (remote.status !== 0) {
    const failedStage = /^VERIFY_FAILED_STAGE=([A-Za-z0-9_-]+)$/mu.exec(remote.stdout)?.[1];
    throw new Error(
      `remote Phase 3 verifier failed at ${failedStage ?? "SSH or evidence collection"}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(remote.stdout);
  } catch {
    throw new Error("remote Phase 3 verifier did not return safe structured evidence");
  }
  assertNoCredentialMaterial(report, config);
  const status = validateRemoteEvidence(report, expectations, stable.version);
  if (!isRecord(report)) {
    throw new Error("remote Phase 3 report was not an object");
  }
  const finalReport = {
    ...report,
    official_stable: { version: stable.version, source: stable.source },
  };
  assertNoCredentialMaterial(finalReport, config);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, { mode: 0o644 });

  if (status === "PASS") {
    console.log("remote OpenClaw Phase 3 real L0 -> L1 -> native L2 verification: PASS");
    return;
  }
  if (status === "BLOCKED_EXTERNAL") {
    console.error(
      "remote OpenClaw Phase 3 verification: BLOCKED_EXTERNAL (Qwen Arrearage/account not in good standing)",
    );
  } else {
    console.error("remote OpenClaw Phase 3 verification: FAIL");
  }
  process.exitCode = 1;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown Phase 3 verification failure";
  console.error(`Phase 3 OpenClaw verification failed: ${message}`);
  process.exitCode = 1;
});
