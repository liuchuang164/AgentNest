import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig, resolveStableVersion } from "./preflight.js";
import {
  copyFileToRemote,
  parseKeyValueOutput,
  prepareRemoteTransport,
  runRemoteScript,
  workspaceRoot,
} from "./remote.js";

const requiredTrackedDeploymentFiles = [
  "Dockerfile",
  ".dockerignore",
  "compose.yaml",
  "package.json",
  "pnpm-lock.yaml",
  "scripts/deploy/deploy.sh",
  "scripts/deploy/status.sh",
  "scripts/verify/run-all.sh",
] as const;

const localDeploymentReportPath = resolve(
  workspaceRoot,
  "artifacts/reports/phase-6-deployment-summary.json",
);

const readDeploymentReportScript = String.raw`set -Eeuo pipefail
workdir=$1
case "$workdir" in /*) ;; *) exit 20 ;; esac
test "$(cat "$workdir/.agentnest-project")" = agentnest-demo
report="$workdir/reports/deployment-summary.json"
test -f "$report"
test "$(wc -c < "$report")" -le 32768
cat "$report"
`;

const prepareUploadScript = String.raw`set -Eeuo pipefail
workdir=$1
case "$workdir" in
  /*) ;;
  *) exit 20 ;;
esac
case "$workdir" in
  /|/opt|/srv|/var|/home|*..*|*//* ) exit 21 ;;
esac
if [ ! -f "$workdir/.agentnest-project" ]; then
  printf 'agentnest-demo\n' > "$workdir/.agentnest-project"
fi
if [ "$(cat "$workdir/.agentnest-project")" != agentnest-demo ]; then
  exit 22
fi
install -d -m 0700 "$workdir/incoming"
printf 'UPLOAD_READY=PASS\n'
`;

const stageSourceScript = String.raw`set -Eeuo pipefail
workdir=$1
openclaw_version=$2
image_tag=$3
openclaw_port=$4
control_port=$5
data_port=$6
external_port=$7
postgres_port=$8
case "$workdir" in
  /*) ;;
  *) exit 20 ;;
esac
case "$workdir" in
  /|/opt|/srv|/var|/home|*..*|*//* ) exit 21 ;;
esac
test "$(cat "$workdir/.agentnest-project")" = agentnest-demo
archive="$workdir/incoming/source.tar.gz"
test -f "$archive"
stage="$workdir/source.next.$$"
case "$stage" in "$workdir"/source.next.*) ;; *) exit 22 ;; esac
rm -rf "$stage"
install -d -m 0755 "$stage"
tar -xzf "$archive" -C "$stage"
rm -f "$archive"
for required in Dockerfile compose.yaml package.json pnpm-lock.yaml; do
  test -f "$stage/$required"
done

cd "$stage"
pnpm install --frozen-lockfile
pnpm --filter @agentnest/tenant-runtime-plugin build

env_file="$workdir/config/agentnest.env"
umask 077
install -d -m 0700 "$workdir/config"
existing_value() {
  key=$1
  if [ -f "$env_file" ]; then
    awk -F= -v key="$key" '$1 == key {print substr($0, index($0, "=") + 1)}' "$env_file" | tail -n 1
  fi
}
if docker info >/dev/null 2>&1; then docker_cmd=docker; else sudo -n docker info >/dev/null; docker_cmd='sudo -n docker'; fi
select_official_image() {
  existing=$1
  official=$2
  mirror=$3
  case "$existing" in "$official"|"$mirror") candidates="$existing $official $mirror" ;; *) candidates="$official $mirror" ;; esac
  for candidate in $candidates; do
    if $docker_cmd image inspect "$candidate" >/dev/null 2>&1; then printf '%s\n' "$candidate"; return 0; fi
    if [ "$candidate" = "$official" ]; then pull_timeout=45; else pull_timeout=300; fi
    if timeout "$pull_timeout" $docker_cmd pull "$candidate" >/dev/null 2>&1; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}
node_base_image=$(select_official_image "$(existing_value AGENTNEST_NODE_BASE_IMAGE)" node:24-bookworm-slim docker.m.daocloud.io/library/node:24-bookworm-slim) || {
  printf 'SOURCE_FAILED_STAGE=node_base_image\n'
  exit 24
}
postgres_image=$(select_official_image "$(existing_value AGENTNEST_POSTGRES_IMAGE)" postgres:16-alpine docker.m.daocloud.io/library/postgres:16-alpine) || {
  printf 'SOURCE_FAILED_STAGE=postgres_image\n'
  exit 25
}
postgres_password=$(existing_value POSTGRES_PASSWORD)
demo_api_token=$(existing_value DEMO_API_TOKEN)
if ! printf '%s' "$postgres_password" | grep -Eq '^[a-f0-9]{64}$'; then
  postgres_password=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
fi
if ! printf '%s' "$demo_api_token" | grep -Eq '^[a-f0-9]{64}$'; then
  demo_api_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
fi
temporary="$env_file.tmp.$$"
{
  printf 'AGENTNEST_REMOTE_WORKDIR=%s\n' "$workdir"
  printf 'AGENTNEST_HOST_UID=%s\n' "$(id -u)"
  printf 'AGENTNEST_HOST_GID=%s\n' "$(id -g)"
  printf 'AGENTNEST_IMAGE_TAG=%s\n' "$image_tag"
  printf 'AGENTNEST_NODE_BASE_IMAGE=%s\n' "$node_base_image"
  printf 'AGENTNEST_POSTGRES_IMAGE=%s\n' "$postgres_image"
  printf 'OPENCLAW_VERSION=%s\n' "$openclaw_version"
  printf 'PNPM_VERSION=11.11.0\n'
  printf 'OPENCLAW_GATEWAY_PORT=%s\n' "$openclaw_port"
  printf 'CONTROL_PLANE_PORT=%s\n' "$control_port"
  printf 'DATA_GATEWAY_MOCK_PORT=%s\n' "$data_port"
  printf 'EXTERNAL_GATEWAY_MOCK_PORT=%s\n' "$external_port"
  printf 'POSTGRES_PORT=%s\n' "$postgres_port"
  printf 'POSTGRES_USER=agentnest\n'
  printf 'POSTGRES_DB=agentnest\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
  printf 'DEMO_API_TOKEN=%s\n' "$demo_api_token"
  printf 'L1_IDLE_TTL_SECONDS=86400\n'
  printf 'L2_IDLE_TTL_SECONDS=3600\n'
} > "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$env_file"
install -d -m 0700 "$workdir/openclaw-state"
install -d -m 0755 "$workdir/runtime" "$workdir/runtime-persistence"
install -d -m 0700 "$workdir/runtime/container-home"
if [ ! -f "$workdir/openclaw-state/.env" ]; then
  : > "$workdir/openclaw-state/.env"
  chmod 0600 "$workdir/openclaw-state/.env"
fi

previous="$workdir/source.previous"
case "$previous" in "$workdir"/source.previous) ;; *) exit 23 ;; esac
rm -rf "$previous"
if [ -d "$workdir/source" ]; then
  mv "$workdir/source" "$previous"
fi
mv "$stage" "$workdir/source"
printf 'SOURCE_STAGED=PASS\n'
printf 'REMOTE_ENV_MODE=%s\n' "$(stat -c '%a' "$env_file")"
`;

const startServicesScript = String.raw`set -Eeuo pipefail
workdir=$1
commit=$2
phase=$3
stage=initialization
trap 'printf "START_SERVICES_FAILED_STAGE=%s\n" "$stage"' ERR
case "$workdir" in
  /*) ;;
  *) exit 20 ;;
esac
test "$(cat "$workdir/.agentnest-project")" = agentnest-demo
source_dir="$workdir/source"
env_file="$workdir/config/agentnest.env"
install -d -m 0755 "$workdir/reports"
test -f "$source_dir/compose.yaml"
test "$(stat -c '%a' "$env_file")" = 600
if docker info >/dev/null 2>&1; then
  docker_cmd=docker
else
  sudo -n docker info >/dev/null
  docker_cmd='sudo -n docker'
fi
postgres_dir="$workdir/postgres-data"
case "$postgres_dir" in "$workdir"/postgres-data) ;; *) exit 24 ;; esac
if [ "$(id -u)" = 0 ]; then root_cmd=; else root_cmd='sudo -n'; fi
$root_cmd install -d -m 0700 -o 70 -g 70 "$postgres_dir"
compose() {
  $docker_cmd compose --project-name agentnest-demo --env-file "$env_file" -f "$source_dir/compose.yaml" "$@"
}

if [ "$phase" = dependencies ]; then
  stage=compose_build
  compose build
fi
stage=postgres_start
compose up -d postgres
stage=postgres_readiness
attempt=0
until compose exec -T postgres pg_isready -U agentnest -d agentnest >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 45 ]; then exit 30; fi
  sleep 2
done
for sql in "$source_dir"/infra/postgres/migrations/*.sql "$source_dir"/infra/postgres/seeds/*.sql; do
  test -f "$sql"
  stage="postgres_sql_$(basename "$sql")"
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U agentnest -d agentnest < "$sql" >/dev/null
done
if [ "$phase" = dependencies ]; then
  stage=gateway_mock_start
  compose up -d data-gateway-mock external-gateway-mock
  ports=$(awk -F= '$1 ~ /^(DATA_GATEWAY_MOCK_PORT|EXTERNAL_GATEWAY_MOCK_PORT)$/ {print $2}' "$env_file")
  for port in $ports; do
    stage="gateway_mock_readiness_$port"
    attempt=0
    until curl -fsS -H 'X-Request-Id: deploy-readiness' "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
      attempt=$((attempt + 1))
      if [ "$attempt" -ge 60 ]; then compose ps; exit 31; fi
      sleep 2
    done
  done
  trap - ERR
  printf 'DEPENDENCIES=PASS\n'
  exit 0
fi
if [ "$phase" != final ]; then exit 32; fi
stage=compose_final_start
compose up -d --remove-orphans

ports=$(awk -F= '$1 ~ /^(CONTROL_PLANE_PORT|DATA_GATEWAY_MOCK_PORT|EXTERNAL_GATEWAY_MOCK_PORT)$/ {print $2}' "$env_file")
for port in $ports; do
  stage="final_readiness_$port"
  attempt=0
  until curl -fsS -H 'X-Request-Id: deploy-readiness' "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      compose ps
      exit 31
    fi
    sleep 2
  done
done

set -a
. "$env_file"
set +a
generated_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node_version=$(node --version)
pnpm_version=$(pnpm --version)
docker_version=$($docker_cmd --version)
compose_version=$(compose version --short)
openclaw_version=$(openclaw --version)
previous_deploy_count=0
if [ -f "$workdir/reports/deployment-summary.json" ]; then
  candidate_count=$(jq -r 'if (.successful_deploy_count | type) == "number" then .successful_deploy_count else 0 end' "$workdir/reports/deployment-summary.json" 2>/dev/null || printf 0)
  if printf '%s' "$candidate_count" | grep -Eq '^[0-9]+$'; then previous_deploy_count=$candidate_count; fi
fi
successful_deploy_count=$((previous_deploy_count + 1))
jq -n \
  --arg generated_at "$generated_at" \
  --arg commit "$commit" \
  --arg node "$node_version" \
  --arg pnpm "$pnpm_version" \
  --arg docker "$docker_version" \
  --arg compose "$compose_version" \
  --arg openclaw "$openclaw_version" \
  --arg node_base_image "$AGENTNEST_NODE_BASE_IMAGE" \
  --arg postgres_image "$AGENTNEST_POSTGRES_IMAGE" \
  --argjson successful_deploy_count "$successful_deploy_count" \
  '{schema_version:"1.0",generated_at:$generated_at,status:"PASS",successful_deploy_count:$successful_deploy_count,agentnest_commit:$commit,services:["postgres","control-plane","data-gateway-mock","external-gateway-mock"],bindings:"loopback_or_private",node_version:$node,pnpm_version:$pnpm,docker_version:$docker,compose_version:$compose,openclaw_version:$openclaw,node_base_image:$node_base_image,postgres_image:$postgres_image}' \
  > "$workdir/reports/deployment-summary.json"
chmod 0644 "$workdir/reports/deployment-summary.json"
trap - ERR
printf 'DEPLOYMENT=PASS\n'
printf 'SERVICE_COUNT=%s\n' "$(compose config --services | wc -l | tr -d ' ')"
`;

function runChecked(command: string, arguments_: readonly string[], label: string): void {
  const result = spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
    timeout: 20 * 60 * 1_000,
    maxBuffer: 8 * 1_024 * 1_024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(result.status ?? 1)}`);
  }
}

function readSafeVersion(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n]/u.test(value) ||
    /(?:password|token|secret|api[_-]?key|postgres(?:ql)?:\/\/)/iu.test(value)
  ) {
    throw new Error(`remote deployment summary contains invalid ${field}`);
  }
  return value;
}

function sanitizeDeploymentSummary(
  text: string,
  expectedCommit: string,
  expectedOpenClawVersion: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("remote deployment summary is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("remote deployment summary is not a JSON object");
  }
  const record = parsed as Readonly<Record<string, unknown>>;
  const generatedAt = readSafeVersion(record["generated_at"], "generated_at");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("remote deployment summary has an invalid generated_at");
  }
  const commit = readSafeVersion(record["agentnest_commit"], "agentnest_commit");
  if (commit !== expectedCommit) {
    throw new Error("remote deployment summary commit does not match deployed source");
  }
  const services = record["services"];
  const expectedServices = [
    "postgres",
    "control-plane",
    "data-gateway-mock",
    "external-gateway-mock",
  ];
  if (
    !Array.isArray(services) ||
    services.length !== expectedServices.length ||
    !expectedServices.every((service) => services.includes(service))
  ) {
    throw new Error("remote deployment summary has an invalid service list");
  }
  const openclawVersion = readSafeVersion(record["openclaw_version"], "openclaw_version");
  if (!openclawVersion.includes(expectedOpenClawVersion)) {
    throw new Error("remote deployment summary OpenClaw version does not match stable");
  }
  const nodeBaseImage = readSafeVersion(record["node_base_image"], "node_base_image");
  const postgresImage = readSafeVersion(record["postgres_image"], "postgres_image");
  if (
    !["node:24-bookworm-slim", "docker.m.daocloud.io/library/node:24-bookworm-slim"].includes(
      nodeBaseImage,
    ) ||
    !["postgres:16-alpine", "docker.m.daocloud.io/library/postgres:16-alpine"].includes(
      postgresImage,
    )
  ) {
    throw new Error("remote deployment summary contains an unsupported official-image source");
  }
  if (
    record["schema_version"] !== "1.0" ||
    record["status"] !== "PASS" ||
    record["bindings"] !== "loopback_or_private"
  ) {
    throw new Error("remote deployment summary failed its schema or binding gate");
  }
  const successfulDeployCount = record["successful_deploy_count"];
  if (
    typeof successfulDeployCount !== "number" ||
    !Number.isSafeInteger(successfulDeployCount) ||
    successfulDeployCount < 1
  ) {
    throw new Error("remote deployment summary has an invalid successful deploy count");
  }
  return {
    schema_version: "1.0",
    generated_at: generatedAt,
    status: "PASS",
    successful_deploy_count: successfulDeployCount,
    agentnest_commit: commit,
    services: expectedServices,
    bindings: "loopback_or_private",
    node_version: readSafeVersion(record["node_version"], "node_version"),
    pnpm_version: readSafeVersion(record["pnpm_version"], "pnpm_version"),
    docker_version: readSafeVersion(record["docker_version"], "docker_version"),
    compose_version: readSafeVersion(record["compose_version"], "compose_version"),
    openclaw_version: openclawVersion,
    node_base_image: nodeBaseImage,
    postgres_image: postgresImage,
  };
}

function committedFiles(commit: string): readonly string[] {
  const sourceStatus = spawnSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)artifacts/reports/**",
    ],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      shell: false,
    },
  );
  if (sourceStatus.status !== 0 || sourceStatus.stdout.trim().length > 0) {
    throw new Error(
      "deployment requires committed code/config; generated artifacts/reports evidence may differ",
    );
  }
  const result = spawnSync("git", ["ls-tree", "-r", "--name-only", "-z", commit], {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error("could not enumerate Git-tracked deployment source");
  }
  const files = result.stdout.split("\0").filter((path) => path.length > 0);
  for (const required of requiredTrackedDeploymentFiles) {
    if (!files.includes(required)) {
      throw new Error(`required deployment file is not Git-tracked: ${required}`);
    }
  }
  return files;
}

async function createCommittedSourceArchive(commit: string): Promise<string> {
  committedFiles(commit);
  const directory = resolve(workspaceRoot, "runtime/deploy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const archive = resolve(directory, `agentnest-source-${process.pid.toString()}.tar.gz`);
  const result = spawnSync("git", ["archive", "--format=tar.gz", `--output=${archive}`, commit], {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
    timeout: 2 * 60 * 1_000,
    maxBuffer: 2 * 1_024 * 1_024,
  });
  if (result.status !== 0) {
    throw new Error("could not build a Git-tracked source archive");
  }
  return archive;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const stable = await resolveStableVersion();
  const ports = config.ports;
  if (ports.length !== 5) {
    throw new Error("deployment requires five configured Demo ports");
  }
  await prepareRemoteTransport();

  runChecked("pnpm", ["exec", "tsx", "scripts/deploy/install-openclaw.ts"], "bootstrap");
  const uploadReady = runRemoteScript(config, "upload-prepare", prepareUploadScript, [
    config.remoteWorkdir,
  ]);
  if (
    uploadReady.status !== 0 ||
    parseKeyValueOutput(uploadReady.stdout)["UPLOAD_READY"] !== "PASS"
  ) {
    throw new Error("remote source upload directory could not be prepared");
  }

  const commitResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: false,
  });
  if (commitResult.status !== 0 || !/^[a-f0-9]{40}$/u.test(commitResult.stdout.trim())) {
    throw new Error("could not resolve the AgentNest commit");
  }
  const commit = commitResult.stdout.trim();
  const archive = await createCommittedSourceArchive(commit);
  try {
    copyFileToRemote(
      config,
      "source-upload",
      archive,
      `${config.remoteWorkdir}/incoming/source.tar.gz`,
    );
  } finally {
    await rm(archive, { force: true });
  }

  const staged = runRemoteScript(
    config,
    "source-stage",
    stageSourceScript,
    [config.remoteWorkdir, stable.version, commit.slice(0, 12), ...ports.map(String)],
    { timeoutMs: 20 * 60 * 1_000, maxBufferBytes: 12 * 1_024 * 1_024 },
  );
  const stagedOutput = parseKeyValueOutput(staged.stdout);
  if (
    staged.status !== 0 ||
    stagedOutput["SOURCE_STAGED"] !== "PASS" ||
    stagedOutput["REMOTE_ENV_MODE"] !== "600"
  ) {
    throw new Error("remote source staging or frozen install failed");
  }

  const dependencies = runRemoteScript(
    config,
    "compose-dependencies",
    startServicesScript,
    [config.remoteWorkdir, commit, "dependencies"],
    { timeoutMs: 30 * 60 * 1_000, maxBufferBytes: 12 * 1_024 * 1_024 },
  );
  if (
    dependencies.status !== 0 ||
    parseKeyValueOutput(dependencies.stdout)["DEPENDENCIES"] !== "PASS"
  ) {
    const failedStage = parseKeyValueOutput(dependencies.stdout)["START_SERVICES_FAILED_STAGE"];
    throw new Error(
      `remote PostgreSQL or Gateway Mock deployment failed at ${failedStage ?? "unknown stage"}`,
    );
  }

  runChecked(
    "pnpm",
    ["exec", "tsx", "scripts/deploy/configure-openclaw.ts"],
    "OpenClaw configuration",
  );

  const started = runRemoteScript(
    config,
    "compose-start",
    startServicesScript,
    [config.remoteWorkdir, commit, "final"],
    { timeoutMs: 30 * 60 * 1_000, maxBufferBytes: 12 * 1_024 * 1_024 },
  );
  const startedOutput = parseKeyValueOutput(started.stdout);
  if (
    started.status !== 0 ||
    startedOutput["DEPLOYMENT"] !== "PASS" ||
    startedOutput["SERVICE_COUNT"] !== "4"
  ) {
    throw new Error("remote Compose deployment or health gate failed");
  }
  const remoteReport = runRemoteScript(
    config,
    "deployment-report-read",
    readDeploymentReportScript,
    [config.remoteWorkdir],
  );
  if (remoteReport.status !== 0) {
    throw new Error("remote deployment summary could not be read");
  }
  const deploymentReport = sanitizeDeploymentSummary(remoteReport.stdout, commit, stable.version);
  await mkdir(dirname(localDeploymentReportPath), { recursive: true });
  await writeFile(localDeploymentReportPath, `${JSON.stringify(deploymentReport, null, 2)}\n`, {
    mode: 0o644,
  });
  console.log("AgentNest remote deployment: PASS");
  console.log(`Git-tracked source: ${commit}`);
  console.log(`OpenClaw stable: ${stable.version}`);
  console.log("services: postgres, control-plane, data-gateway-mock, external-gateway-mock");
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown deployment failure";
  console.error(`AgentNest deployment failed: ${message}`);
  process.exitCode = 1;
});
