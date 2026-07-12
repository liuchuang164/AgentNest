import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  demoCapabilityProfiles,
  demoTaskTemplates,
  deriveLogicalAgentId,
} from "@agentnest/capability";

import { loadConfig, resolveStableVersion, type PreflightConfig } from "./preflight.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const knownHostsPath = resolve(workspaceRoot, "runtime/ssh/known_hosts");
const reportPath = resolve(workspaceRoot, "artifacts/reports/remote-phase3-config-summary.json");
const qwenChinaStandardBaseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";

interface RemoteCommandResult {
  readonly status: number;
  readonly stdout: string;
}

interface WorkspaceFile {
  readonly name: string;
  readonly content: string;
}

interface WorkspacePayload {
  readonly agentId: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly files: readonly WorkspaceFile[];
}

interface OpenClawProfilePayload {
  readonly id: string;
  readonly default?: boolean;
  readonly workspace: string;
  readonly agentDir: string;
  readonly model: string;
  readonly skills: readonly string[];
  readonly subagents?: {
    readonly allowAgents: readonly string[];
    readonly requireAgentId: boolean;
  };
  readonly tools: {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
  };
}

interface ConfigurationPayload {
  readonly gatewayPort: number;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly modelBaseUrl: string;
  readonly profiles: readonly OpenClawProfilePayload[];
  readonly l1AgentIds: readonly string[];
  readonly plugin: {
    readonly dataGatewayUrl: string;
    readonly externalGatewayUrl: string;
    readonly agentScopes: Readonly<Record<string, { readonly bizDomain: string }>>;
  };
  readonly workspaces: readonly WorkspacePayload[];
}

const remoteSecretProvisionScript = String.raw`set -eu
workdir=$1
state_dir="$workdir/openclaw-state"
env_file="$state_dir/.env"
umask 077
install -d -m 0700 "$state_dir"
IFS= read -r model_api_key
if ! printf '%s' "$model_api_key" | grep -Eq '^[A-Za-z0-9._-]{8,}$'; then
  printf 'ENV_READY=INVALID_MODEL_KEY\n'
  exit 2
fi
gateway_token=
if [ -f "$env_file" ]; then
  gateway_token=$(awk -F= '$1 == "OPENCLAW_GATEWAY_TOKEN" {print substr($0, index($0, "=") + 1)}' "$env_file" | tail -n 1)
fi
if ! printf '%s' "$gateway_token" | grep -Eq '^[a-f0-9]{64}$'; then
  gateway_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
fi
temporary="$env_file.tmp.$$"
{
  printf 'QWEN_API_KEY=%s\n' "$model_api_key"
  printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$gateway_token"
} > "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$env_file"
printf 'ENV_READY=PASS\n'
`;

const remoteConfigureScript = String.raw`set -Eeuo pipefail
workdir=$1
payload_base64=$2
payload="$workdir/config/phase3-openclaw-payload.json"
state_dir="$workdir/openclaw-state"
export OPENCLAW_STATE_DIR="$state_dir"
export OPENCLAW_CONFIG_PATH="$state_dir/openclaw.json"
set -a
. "$state_dir/.env"
set +a
umask 077
install -d -m 0755 "$workdir/config" "$workdir/runtime/openclaw"
printf '%s' "$payload_base64" | base64 --decode > "$payload"
chmod 0600 "$payload"

node --input-type=module - "$workdir" <<'NODE'
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const workdir = resolve(process.argv[2]);
const runtimeRoot = resolve(workdir, "runtime/openclaw");
const payload = JSON.parse(await readFile(resolve(workdir, "config/phase3-openclaw-payload.json"), "utf8"));
const assertInside = (candidate) => {
  const absolute = resolve(candidate);
  if (absolute !== runtimeRoot && !absolute.startsWith(runtimeRoot + sep)) {
    throw new Error("workspace payload escaped the project runtime root");
  }
};
for (const workspace of payload.workspaces) {
  assertInside(workspace.workspace);
  assertInside(workspace.agentDir);
  await mkdir(workspace.workspace, { recursive: true, mode: 0o755 });
  await mkdir(workspace.agentDir, { recursive: true, mode: 0o700 });
  for (const file of workspace.files) {
    const target = resolve(workspace.workspace, file.name);
    assertInside(target);
    await mkdir(resolve(target, ".."), { recursive: true, mode: 0o755 });
    await writeFile(target, file.content, { mode: 0o644 });
  }
}
const wrapper = resolve(runtimeRoot, "openclaw-wrapper.sh");
const wrapperContent = [
  "#!/bin/sh",
  "set -eu",
  "export OPENCLAW_STATE_DIR=" + JSON.stringify(resolve(workdir, "openclaw-state")),
  "export OPENCLAW_CONFIG_PATH=" + JSON.stringify(resolve(workdir, "openclaw-state/openclaw.json")),
  "set -a",
  ". " + JSON.stringify(resolve(workdir, "openclaw-state/.env")),
  "set +a",
  'exec /usr/bin/openclaw "$@"',
  "",
].join("\n");
await writeFile(
  wrapper,
  wrapperContent,
  { mode: 0o755 },
);
await chmod(wrapper, 0o755);
NODE

gateway_port=$(jq -r '.gatewayPort' "$payload")
model_provider=$(jq -r '.modelProvider' "$payload")
model_name=$(jq -r '.modelName' "$payload")
model_base_url=$(jq -r '.modelBaseUrl' "$payload")
profiles=$(jq -c '.profiles' "$payload")
agent_to_agent_ids=$(jq -c '["main"] + .l1AgentIds' "$payload")
plugin_config=$(jq -c '.plugin' "$payload")

plugin_source="$workdir/source/packages/tenant-runtime-plugin"
plugin_ready=no
if [ -d "$plugin_source" ]; then
  # Stable OpenClaw enables a newly installed plugin immediately. Seed a valid,
  # disabled entry first so the CLI remains usable between install and enable.
  openclaw config set plugins.entries.agentnest-tenant-runtime.enabled false --strict-json >/dev/null
  openclaw config set plugins.entries.agentnest-tenant-runtime.config "$plugin_config" --strict-json >/dev/null
  plugin_archive_dir="$workdir/config/plugin-archives"
  install -d -m 0700 "$plugin_archive_dir"
  find "$plugin_archive_dir" -mindepth 1 -maxdepth 1 -type f -name 'agentnest-tenant-runtime-plugin-*.tgz' -delete
  pack_result=$(cd "$plugin_source" && npm pack --json --pack-destination "$plugin_archive_dir")
  plugin_archive_name=$(printf '%s' "$pack_result" | jq -r 'if length == 1 then .[0].filename else empty end')
  case "$plugin_archive_name" in
    agentnest-tenant-runtime-plugin-*.tgz) ;;
    *) printf 'CONFIGURE_FAILED_STAGE=plugin_pack\n'; exit 5 ;;
  esac
  plugin_archive="$plugin_archive_dir/$plugin_archive_name"
  test -f "$plugin_archive"
  openclaw plugins install --force "$plugin_archive" >/dev/null
  rm -f "$plugin_archive"
fi
if openclaw plugins inspect agentnest-tenant-runtime --json >/dev/null 2>&1; then
  plugin_ready=yes
fi
if [ "$plugin_ready" != yes ]; then
  printf 'CONFIGURE_FAILED_STAGE=plugin_install\n'
  exit 6
fi

openclaw config set gateway.mode local >/dev/null
openclaw config set gateway.bind loopback >/dev/null
openclaw config set gateway.port "$gateway_port" --strict-json >/dev/null
openclaw config set gateway.auth.mode token >/dev/null
openclaw config set gateway.auth.token --ref-provider default --ref-source env --ref-id OPENCLAW_GATEWAY_TOKEN >/dev/null
openclaw config set "models.providers.$model_provider.baseUrl" "$model_base_url" >/dev/null
openclaw config set "models.providers.$model_provider.apiKey" --ref-provider default --ref-source env --ref-id QWEN_API_KEY >/dev/null
openclaw config set plugins.allow '["agentnest-tenant-runtime","qwen"]' --strict-json >/dev/null
openclaw config set plugins.entries.agentnest-tenant-runtime.enabled true --strict-json >/dev/null
openclaw config set plugins.entries.agentnest-tenant-runtime.config "$plugin_config" --strict-json >/dev/null
openclaw plugins enable agentnest-tenant-runtime >/dev/null
openclaw config set agents.defaults.model.primary "$model_name" >/dev/null
openclaw config set agents.defaults.skills '[]' --strict-json >/dev/null
openclaw config set agents.defaults.subagents '{"maxConcurrent":5,"maxSpawnDepth":1,"maxChildrenPerAgent":5,"archiveAfterMinutes":0,"runTimeoutSeconds":300,"requireAgentId":true}' --strict-json >/dev/null
openclaw config set agents.list "$profiles" --strict-json --replace >/dev/null
openclaw config set tools.sessions.visibility all >/dev/null
openclaw config set tools.agentToAgent.enabled true --strict-json >/dev/null
openclaw config set tools.agentToAgent.allow "$agent_to_agent_ids" --strict-json >/dev/null
openclaw config set session.agentToAgent.maxPingPongTurns 0 --strict-json >/dev/null
openclaw config validate --json >/dev/null

wrapper="$workdir/runtime/openclaw/openclaw-wrapper.sh"
if command -v loginctl >/dev/null 2>&1; then
  sudo loginctl enable-linger "$(id -un)"
fi
openclaw gateway install --force --runtime node --wrapper "$wrapper" --port "$gateway_port" --json >/dev/null
openclaw gateway restart --json >/dev/null 2>&1 || openclaw gateway start --json >/dev/null

gateway_ready=no
attempt=0
while [ "$attempt" -lt 30 ]; do
  if openclaw gateway status --require-rpc --json >/dev/null 2>&1; then
    gateway_ready=yes
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$gateway_ready" != yes ]; then
  printf 'CONFIGURE_FAILED_STAGE=gateway_readiness\n'
  exit 3
fi

admin_probe_params=$(jq -cn '{key:"agent:main:agentnest-admin-scope-validation",deleteTranscript:true}')
if ! openclaw gateway call sessions.delete --params "$admin_probe_params" --json --timeout 30000 >/dev/null 2>&1; then
  if ! node --input-type=module - "$state_dir" <<'NODE'
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const stateDir = process.argv[2];
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const packageRoot = resolve(globalRoot, "openclaw");
const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
const exportedPath = manifest.exports?.["./plugin-sdk/device-bootstrap"]?.default;
if (typeof exportedPath !== "string" || !exportedPath.startsWith("./dist/")) {
  throw new Error("OpenClaw device-bootstrap public export is unavailable");
}
const api = await import(pathToFileURL(resolve(packageRoot, exportedPath)).href);
const list = await api.listDevicePairing(stateDir);
const target = list.paired.find((device) =>
  (device.scopes ?? []).includes("operator.write") ||
  Object.values(device.tokens ?? {}).some((token) => token.scopes.includes("operator.write")),
);
const pending = list.pending
  .filter(
    (request) =>
      request.deviceId === target?.deviceId &&
      (request.scopes ?? []).includes("operator.admin"),
  )
  .sort((left, right) => right.ts - left.ts)[0];
if (!pending) {
  throw new Error("OpenClaw operator.admin scope request was not found");
}
const approved = await api.approveDevicePairing(
  pending.requestId,
  { callerScopes: ["operator.admin"] },
  stateDir,
);
if (approved?.status !== "approved") {
  throw new Error("OpenClaw operator.admin scope request was not approved");
}
NODE
  then
    printf 'CONFIGURE_FAILED_STAGE=gateway_admin_scope_approval\n'
    exit 9
  fi
  if ! openclaw gateway call sessions.delete --params "$admin_probe_params" --json --timeout 30000 >/dev/null 2>&1; then
    printf 'CONFIGURE_FAILED_STAGE=gateway_admin_scope_validation\n'
    exit 10
  fi
fi

observed_count=$(openclaw agents list --json | jq 'length')
expected_count=$(jq '.profiles | length' "$payload")
if [ "$observed_count" -ne "$expected_count" ]; then
  printf 'CONFIGURE_FAILED_STAGE=profile_count\n'
  exit 4
fi
for agent_id in $(jq -r '.profiles[].id' "$payload"); do
  openclaw agents list --json | jq -e --arg id "$agent_id" '.[] | select(.id == $id)' >/dev/null
done
openclaw plugins inspect agentnest-tenant-runtime --runtime --json >/dev/null || {
  printf 'CONFIGURE_FAILED_STAGE=plugin_runtime\n'
  exit 7
}
openclaw plugins doctor >/dev/null || {
  printf 'CONFIGURE_FAILED_STAGE=plugin_doctor\n'
  exit 8
}

doctor_errors=$(openclaw doctor --lint --json --non-interactive --no-workspace-suggestions 2>/dev/null | jq '[.findings[]? | select(.severity == "error")] | length' 2>/dev/null || printf unknown)
schema_sha=$(openclaw config schema | sha256sum | awk '{print $1}')
printf 'CONFIGURE=PASS\n'
printf 'PROFILE_COUNT=%s\n' "$observed_count"
printf 'MODEL_PROVIDER=%s\n' "$model_provider"
printf 'MODEL_NAME=%s\n' "$model_name"
printf 'GATEWAY_READY=yes\n'
printf 'DOCTOR_ERROR_COUNT=%s\n' "$doctor_errors"
printf 'OPENCLAW_SCHEMA_SHA256=%s\n' "$schema_sha"
printf 'AGENTNEST_PLUGIN=%s\n' "$plugin_ready"
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sshBaseArguments(config: PreflightConfig): {
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
    environment["DISPLAY"] = "agentnest-configure:0";
    environment["AGENTNEST_SSH_PASSWORD"] = config.password ?? "";
  } else {
    arguments_.push("-o", "BatchMode=yes", "-i", config.privateKeyPath ?? "");
  }
  arguments_.push(`${config.sshUser}@${config.sshHost}`);
  return { arguments_, environment };
}

function runRemote(
  config: PreflightConfig,
  remoteCommand: string,
  input: string,
  timeout: number,
): RemoteCommandResult {
  const invocation = sshBaseArguments(config);
  invocation.arguments_.push(remoteCommand);
  const result = spawnSync("ssh", invocation.arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: invocation.environment,
    input,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  delete invocation.environment["AGENTNEST_SSH_PASSWORD"];
  return { status: result.status ?? 1, stdout: result.stdout };
}

function replaceTokens(content: string, replacements: Readonly<Record<string, string>>): string {
  let result = content;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`__${token}__`, value);
  }
  return result;
}

function deriveL2AgentId(logicalAgentId: string, taskType: string): string {
  const digest = createHash("sha256")
    .update(`${logicalAgentId}:${taskType}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `l2_${digest}`;
}

async function readAsset(path: string): Promise<string> {
  return await readFile(resolve(workspaceRoot, path), "utf8");
}

async function buildPayload(config: PreflightConfig): Promise<ConfigurationPayload> {
  if (config.modelProvider !== "qwen" || !config.modelName.startsWith("qwen/")) {
    throw new Error(
      "Phase 3 currently supports the configured qwen provider and qwen/* model only",
    );
  }
  const runtimeRoot = `${config.remoteWorkdir}/runtime/openclaw`;
  const allBusinessTools = [
    ...new Set(demoCapabilityProfiles.flatMap((profile) => Object.keys(profile.tools))),
  ].sort();
  const mainTemplate = await readAsset("infra/openclaw/workspaces/main/AGENTS.md");
  const skillAssets = new Map([
    ["legal-evidence-check", await readAsset("skills/legal-evidence-check/SKILL.md")],
    ["robot-dog-health-check", await readAsset("skills/robot-dog-health-check/SKILL.md")],
  ]);
  const profiles: OpenClawProfilePayload[] = [];
  const workspaces: WorkspacePayload[] = [];
  const agentScopes: Record<string, { readonly bizDomain: string }> = {};
  const routeTable = demoCapabilityProfiles.map((capability) => {
    const taskTemplate = demoTaskTemplates.find(
      (candidate) => candidate.bizDomain === capability.biz_domain,
    );
    if (taskTemplate === undefined) {
      throw new Error(`missing task template for ${capability.biz_domain}`);
    }
    const agentId = deriveLogicalAgentId({
      tenantId: capability.tenant_id,
      bizDomain: capability.biz_domain,
    });
    return {
      tenant_id: capability.tenant_id,
      biz_domain: capability.biz_domain,
      task_type: taskTemplate.taskType,
      agent_id: agentId,
      probe_session_key: `agent:${agentId}:main`,
    };
  });
  const mainWorkspace = `${runtimeRoot}/workspaces/main`;
  profiles.push({
    id: "main",
    default: true,
    workspace: mainWorkspace,
    agentDir: `${runtimeRoot}/agents/main/agent`,
    model: config.modelName,
    skills: [],
    tools: {
      allow: ["sessions_send", "session_status"],
      deny: allBusinessTools,
    },
  });
  workspaces.push({
    agentId: "main",
    workspace: mainWorkspace,
    agentDir: `${runtimeRoot}/agents/main/agent`,
    files: [
      {
        name: "AGENTS.md",
        content: replaceTokens(mainTemplate, {
          L1_ROUTE_TABLE_JSON: JSON.stringify(routeTable, null, 2),
        }),
      },
    ],
  });

  const l1AgentIds: string[] = [];
  for (const capability of demoCapabilityProfiles) {
    const taskTemplate = demoTaskTemplates.find(
      (candidate) => candidate.bizDomain === capability.biz_domain,
    );
    if (taskTemplate === undefined) {
      throw new Error(`missing task template for ${capability.biz_domain}`);
    }
    const logicalAgentId = deriveLogicalAgentId({
      tenantId: capability.tenant_id,
      bizDomain: capability.biz_domain,
    });
    const l2AgentId = deriveL2AgentId(logicalAgentId, taskTemplate.taskType);
    agentScopes[logicalAgentId] = { bizDomain: capability.biz_domain };
    agentScopes[l2AgentId] = { bizDomain: capability.biz_domain };
    const businessTools = Object.keys(capability.tools).sort();
    const deniedBusinessTools = allBusinessTools.filter(
      (toolName) => !businessTools.includes(toolName),
    );
    const role = capability.biz_domain === "LEGAL" ? "legal" : "robot-dog";
    const l2Role =
      capability.biz_domain === "LEGAL" ? "legal-evidence-check" : "robot-dog-health-check";
    const l1Template = await readAsset(`infra/openclaw/workspaces/l1-${role}/AGENTS.md`);
    const l2Template = await readAsset(`infra/openclaw/workspaces/l2-${l2Role}/AGENTS.md`);
    const replacements = {
      TENANT_ID: capability.tenant_id,
      BIZ_DOMAIN: capability.biz_domain,
      L1_AGENT_ID: logicalAgentId,
      L2_AGENT_ID: l2AgentId,
      TASK_TYPE: taskTemplate.taskType,
    };
    const l1Workspace = `${runtimeRoot}/workspaces/${logicalAgentId}`;
    const l2Workspace = `${runtimeRoot}/workspaces/${l2AgentId}`;
    const skillName = capability.skills[0];
    const skillContent = skillName === undefined ? undefined : skillAssets.get(skillName);
    if (skillName === undefined || skillContent === undefined) {
      throw new Error(`missing versioned skill for ${capability.biz_domain}`);
    }
    profiles.push({
      id: logicalAgentId,
      workspace: l1Workspace,
      agentDir: `${runtimeRoot}/agents/${logicalAgentId}/agent`,
      model: config.modelName,
      skills: [...capability.skills],
      subagents: { allowAgents: [l2AgentId], requireAgentId: true },
      tools: {
        allow: [
          "sessions_spawn",
          "sessions_yield",
          "subagents",
          "session_status",
          ...businessTools,
        ],
        deny: deniedBusinessTools,
      },
    });
    profiles.push({
      id: l2AgentId,
      workspace: l2Workspace,
      agentDir: `${runtimeRoot}/agents/${l2AgentId}/agent`,
      model: config.modelName,
      skills: [...taskTemplate.skills],
      tools: {
        allow: Object.keys(taskTemplate.tools).sort(),
        deny: deniedBusinessTools,
      },
    });
    workspaces.push(
      {
        agentId: logicalAgentId,
        workspace: l1Workspace,
        agentDir: `${runtimeRoot}/agents/${logicalAgentId}/agent`,
        files: [
          { name: "AGENTS.md", content: replaceTokens(l1Template, replacements) },
          { name: `skills/${skillName}/SKILL.md`, content: skillContent },
        ],
      },
      {
        agentId: l2AgentId,
        workspace: l2Workspace,
        agentDir: `${runtimeRoot}/agents/${l2AgentId}/agent`,
        files: [
          { name: "AGENTS.md", content: replaceTokens(l2Template, replacements) },
          { name: `skills/${skillName}/SKILL.md`, content: skillContent },
        ],
      },
    );
    l1AgentIds.push(logicalAgentId);
  }
  return {
    gatewayPort: config.ports[0] ?? 18_789,
    modelProvider: config.modelProvider,
    modelName: config.modelName,
    modelBaseUrl: qwenChinaStandardBaseUrl,
    profiles,
    l1AgentIds,
    plugin: {
      dataGatewayUrl: `http://127.0.0.1:${String(config.ports[2] ?? 18_081)}`,
      externalGatewayUrl: `http://127.0.0.1:${String(config.ports[3] ?? 18_082)}`,
      agentScopes,
    },
    workspaces,
  };
}

function parseOutput(output: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      const key = line.slice(0, separator);
      if (/^[A-Z0-9_]+$/.test(key)) {
        parsed[key] = line.slice(separator + 1).replaceAll(/[\r\n]/g, " ");
      }
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const stable = await resolveStableVersion();
  if (config.modelApiKey === null) {
    throw new Error("config.txt is missing required field MODEL_API_KEY");
  }
  await chmod(askpassPath, 0o755);
  const payload = await buildPayload(config);

  const secretCommand = `bash -c ${shellQuote(remoteSecretProvisionScript)} -- ${shellQuote(config.remoteWorkdir)}`;
  const secretResult = runRemote(config, secretCommand, `${config.modelApiKey}\n`, 60_000);
  if (secretResult.status !== 0 || parseOutput(secretResult.stdout)["ENV_READY"] !== "PASS") {
    throw new Error("remote project-scoped OpenClaw environment provisioning failed");
  }

  const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const configureArguments = ["bash", "-s", "--", config.remoteWorkdir, payloadBase64]
    .map(shellQuote)
    .join(" ");
  const configureResult = runRemote(config, configureArguments, remoteConfigureScript, 5 * 60_000);
  if (configureResult.status !== 0) {
    const observed = parseOutput(configureResult.stdout);
    throw new Error(
      `remote OpenClaw configuration failed at ${observed["CONFIGURE_FAILED_STAGE"] ?? "unknown stage"}`,
    );
  }
  const observed = parseOutput(configureResult.stdout);
  if (
    observed["CONFIGURE"] !== "PASS" ||
    Number(observed["PROFILE_COUNT"]) !== payload.profiles.length ||
    observed["AGENTNEST_PLUGIN"] !== "yes"
  ) {
    throw new Error("remote OpenClaw configuration did not match the requested profiles");
  }
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schema_version: "1.0",
        generated_at: new Date().toISOString(),
        target: "redacted",
        expected_openclaw_version: stable.version,
        model_provider: config.modelProvider,
        model_name: config.modelName,
        profile_ids: payload.profiles.map((profile) => profile.id),
        distinct_workspaces: new Set(payload.profiles.map((profile) => profile.workspace)).size,
        distinct_agent_dirs: new Set(payload.profiles.map((profile) => profile.agentDir)).size,
        observed,
        status: "PASS",
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
  console.log("remote OpenClaw Phase 3 configuration: PASS");
  console.log(`OpenClaw stable: ${stable.version}`);
  console.log(`profiles: ${String(payload.profiles.length)}`);
  console.log("gateway: loopback and RPC ready");
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown OpenClaw configuration failure";
  console.error(`OpenClaw configuration failed: ${message}`);
  process.exitCode = 1;
});
