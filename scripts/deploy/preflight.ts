import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(workspaceRoot, "config.txt");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const reportJsonPath = resolve(workspaceRoot, "artifacts/reports/remote-preflight-summary.json");
const reportMarkdownPath = resolve(workspaceRoot, "artifacts/reports/remote-preflight-summary.md");

const knownConfigKeys = new Set([
  "SSH_HOST",
  "SSH_PORT",
  "SSH_USER",
  "SSH_AUTH_MODE",
  "SSH_PRIVATE_KEY_PATH",
  "SSH_PASSWORD",
  "REMOTE_WORKDIR",
  "OPENCLAW_CHANNEL",
  "OPENCLAW_VERSION",
  "OPENCLAW_GATEWAY_PORT",
  "CONTROL_PLANE_PORT",
  "DATA_GATEWAY_MOCK_PORT",
  "EXTERNAL_GATEWAY_MOCK_PORT",
  "POSTGRES_PORT",
  "MODEL_PROVIDER",
  "MODEL_NAME",
  "MODEL_API_KEY",
]);
const legacyConfigKeys = new Map([
  ["gateway server ip", "SSH_HOST"],
  ["gateway server user", "SSH_USER"],
  ["gateway server password", "SSH_PASSWORD"],
  ["阿里百炼 api key", "MODEL_API_KEY"],
]);

export interface PreflightConfig {
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly authMode: "key" | "password";
  readonly privateKeyPath: string | null;
  readonly password: string | null;
  readonly remoteWorkdir: string;
  readonly ports: readonly number[];
  readonly modelProvider: string;
  readonly modelName: string;
  readonly modelApiKey: string | null;
}

interface CommandResult {
  readonly status: number;
  readonly stdout: string;
}

export interface StableVersionResult {
  readonly version: string;
  readonly source: string;
}

function requiredValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`config.txt is missing required field ${key}`);
  }
  return value;
}

function optionalValue(values: ReadonlyMap<string, string>, key: string): string | null {
  const value = values.get(key)?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function readPort(values: ReadonlyMap<string, string>, key: string, fallback: number): number {
  const rawValue = optionalValue(values, key);
  if (rawValue === null) {
    return fallback;
  }
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`config.txt field ${key} must be a valid TCP port`);
  }
  return port;
}

function validateRemoteWorkdir(value: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.includes("//")) {
    throw new Error("config.txt field REMOTE_WORKDIR is not a normalized absolute path");
  }
  const normalized = value.replace(/\/$/, "");
  if (["", "/", "/home", "/root", "/opt", "/srv", "/var"].includes(normalized)) {
    throw new Error("config.txt field REMOTE_WORKDIR is too broad");
  }
  return normalized;
}

export async function loadConfig(): Promise<PreflightConfig> {
  const configStat = await stat(configPath);
  if ((configStat.mode & 0o777) !== 0o600) {
    throw new Error("config.txt permissions must be 0600");
  }
  const values = new Map<string, string>();
  for (const rawLine of (await readFile(configPath, "utf8")).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separators = [line.indexOf("="), line.indexOf(":"), line.indexOf("：")].filter(
      (index) => index > 0,
    );
    const separator = separators.length === 0 ? -1 : Math.min(...separators);
    if (separator <= 0) {
      throw new Error("config.txt contains an invalid KEY=VALUE line");
    }
    const rawKey = line.slice(0, separator).trim();
    const key = legacyConfigKeys.get(rawKey.toLowerCase()) ?? rawKey;
    if (knownConfigKeys.has(key)) {
      values.set(key, line.slice(separator + 1));
    }
  }

  const privateKeyPath = optionalValue(values, "SSH_PRIVATE_KEY_PATH");
  const password = optionalValue(values, "SSH_PASSWORD");
  const authMode =
    optionalValue(values, "SSH_AUTH_MODE") ?? (password === null ? "key" : "password");
  if (authMode !== "key" && authMode !== "password") {
    throw new Error("config.txt field SSH_AUTH_MODE must be key or password");
  }
  if (authMode === "key" && privateKeyPath === null) {
    throw new Error("config.txt is missing required field SSH_PRIVATE_KEY_PATH");
  }
  if (authMode === "password" && password === null) {
    throw new Error("config.txt is missing required field SSH_PASSWORD");
  }
  const sshHost = requiredValue(values, "SSH_HOST");
  const sshUser = requiredValue(values, "SSH_USER");
  if (!/^[A-Za-z0-9.:-]+$/.test(sshHost)) {
    throw new Error("config.txt field SSH_HOST has an unsupported format");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(sshUser)) {
    throw new Error("config.txt field SSH_USER has an unsupported format");
  }

  return {
    sshHost,
    sshPort: readPort(values, "SSH_PORT", 22),
    sshUser,
    authMode,
    privateKeyPath,
    password,
    remoteWorkdir: validateRemoteWorkdir(
      optionalValue(values, "REMOTE_WORKDIR") ?? "/opt/agentnest-demo",
    ),
    modelProvider: optionalValue(values, "MODEL_PROVIDER") ?? "qwen",
    modelName: optionalValue(values, "MODEL_NAME") ?? "qwen/qwen3.5-plus",
    modelApiKey: optionalValue(values, "MODEL_API_KEY"),
    ports: [
      readPort(values, "OPENCLAW_GATEWAY_PORT", 18_789),
      readPort(values, "CONTROL_PLANE_PORT", 18_080),
      readPort(values, "DATA_GATEWAY_MOCK_PORT", 18_081),
      readPort(values, "EXTERNAL_GATEWAY_MOCK_PORT", 18_082),
      readPort(values, "POSTGRES_PORT", 15_432),
    ],
  };
}

function run(
  command: string,
  arguments_: readonly string[],
  environment = process.env,
): CommandResult {
  const result = spawnSync(command, arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    shell: false,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
  };
}

export async function resolveStableVersion(): Promise<StableVersionResult> {
  const response = await fetch("https://registry.npmjs.org/openclaw/latest", {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error("could not resolve the official OpenClaw npm latest tag");
  }
  const document: unknown = await response.json();
  if (
    document === null ||
    typeof document !== "object" ||
    !("version" in document) ||
    typeof document.version !== "string"
  ) {
    throw new Error("official OpenClaw npm metadata did not contain a version");
  }
  const version = document.version;
  if (/beta|alpha|rc|dev/i.test(version) || !/^\d{4}\.\d+\.\d+$/.test(version)) {
    throw new Error("official OpenClaw npm latest tag resolved to a prerelease or invalid version");
  }
  return { version, source: "https://registry.npmjs.org/openclaw/latest" };
}

const remoteProbe = String.raw`set -eu
workdir=$1
shift
openclaw_port=$1

value() {
  key=$1
  shift
  output=$("$@" 2>/dev/null | head -n 1 || true)
  output=$(printf '%s' "$output" | tr '\r\n' '  ')
  printf '%s=%s\n' "$key" "$output"
}

os_id=$(awk -F= '$1 == "ID" {gsub(/"/, "", $2); print $2}' /etc/os-release 2>/dev/null || true)
os_version=$(awk -F= '$1 == "VERSION_ID" {gsub(/"/, "", $2); print $2}' /etc/os-release 2>/dev/null || true)
printf 'OS_ID=%s\n' "$os_id"
printf 'OS_VERSION=%s\n' "$os_version"
value ARCH uname -m
value KERNEL uname -r
value REMOTE_USER id -un
value REMOTE_UID id -u
value CPU_COUNT getconf _NPROCESSORS_ONLN
memory_kib=$(awk '/MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
memory_mib=
if [ -n "$memory_kib" ]; then memory_mib=$((memory_kib / 1024)); fi
printf 'MEMORY_MIB=%s\n' "$memory_mib"

probe_path=$workdir
while [ ! -e "$probe_path" ] && [ "$probe_path" != / ]; do
  probe_path=$(dirname "$probe_path")
done
disk_kib=$(df -Pk "$probe_path" 2>/dev/null | awk 'NR == 2 {print $4}' || true)
disk_mib=
if [ -n "$disk_kib" ]; then disk_mib=$((disk_kib / 1024)); fi
printf 'DISK_FREE_MIB=%s\n' "$disk_mib"
printf 'WORKDIR_EXISTS=%s\n' "$([ -e "$workdir" ] && printf yes || printf no)"
printf 'WORKDIR_IS_DIRECTORY=%s\n' "$([ -d "$workdir" ] && printf yes || printf no)"
project_owned=no
if [ -f "$workdir/.agentnest-project" ]; then
  if [ "$(cat "$workdir/.agentnest-project" 2>/dev/null || true)" = agentnest-demo ] && { [ -f "$workdir/config/agentnest.env" ] || { [ -f "$workdir/openclaw-state/openclaw.json" ] && [ -f "$workdir/openclaw-state/.env" ]; }; }; then
    project_owned=yes
  fi
elif [ -f "$workdir/openclaw-state/openclaw.json" ] && [ -f "$workdir/openclaw-state/.env" ]; then
  # Phase 3 created the project-scoped OpenClaw state before Phase 6 introduced
  # the ownership marker. The RPC probe below still has to prove the port.
  project_owned=yes
fi
printf 'PROJECT_OWNERSHIP=%s\n' "$project_owned"
if [ -e "$workdir" ]; then
  printf 'WORKDIR_WRITABLE=%s\n' "$([ -w "$workdir" ] && printf yes || printf no)"
else
  printf 'WORKDIR_WRITABLE=%s\n' "$([ -w "$probe_path" ] && printf parent_yes || printf parent_no)"
fi

if command -v sudo >/dev/null 2>&1; then
  printf 'SUDO_AVAILABLE=yes\n'
  printf 'SUDO_NONINTERACTIVE=%s\n' "$(sudo -n true >/dev/null 2>&1 && printf yes || printf no)"
else
  printf 'SUDO_AVAILABLE=no\n'
  printf 'SUDO_NONINTERACTIVE=no\n'
fi

value NODE_VERSION node --version
value NPM_VERSION npm --version
value PNPM_VERSION pnpm --version
value DOCKER_VERSION docker --version
docker_cmd=
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_cmd=docker
elif command -v docker >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  docker_cmd='sudo -n docker'
fi
if [ -n "$docker_cmd" ]; then
  compose_version=$($docker_cmd compose version 2>/dev/null | head -n 1 || true)
  printf 'COMPOSE_VERSION=%s\n' "$(printf '%s' "$compose_version" | tr '\r\n' '  ')"
  printf 'DOCKER_DAEMON=reachable\n'
  all_agentnest=$($docker_cmd ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^agentnest([_-]|$)' || true)
  owned_agentnest=$($docker_cmd ps -a --filter label=com.docker.compose.project=agentnest-demo --format '{{.Names}}' 2>/dev/null || true)
  if [ "$project_owned" != yes ]; then owned_agentnest=; fi
  conflicts=
  for container in $all_agentnest; do
    if ! printf '%s\n' "$owned_agentnest" | grep -Fxq "$container"; then
      if [ -n "$conflicts" ]; then conflicts="$conflicts,$container"; else conflicts=$container; fi
    fi
  done
  if [ -z "$conflicts" ]; then conflicts=none; fi
  printf 'AGENTNEST_CONTAINER_CONFLICTS=%s\n' "$conflicts"
  owned_count=$(printf '%s\n' "$owned_agentnest" | awk 'NF {count += 1} END {print count + 0}')
  printf 'OWNED_COMPOSE_CONTAINER_COUNT=%s\n' "$owned_count"
else
  printf 'COMPOSE_VERSION=\n'
  printf 'DOCKER_DAEMON=unavailable\n'
  printf 'AGENTNEST_CONTAINER_CONFLICTS=none\n'
  printf 'OWNED_COMPOSE_CONTAINER_COUNT=0\n'
fi
value GIT_VERSION git --version
value CURL_VERSION curl --version
value OPENCLAW_VERSION openclaw --version

for port in "$@"; do
  if command -v ss >/dev/null 2>&1; then
    state=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$port$" && printf occupied || printf free)
  elif command -v netstat >/dev/null 2>&1; then
    state=$(netstat -lnt 2>/dev/null | awk 'NR > 2 {print $4}' | grep -Eq "(^|:)$port$" && printf occupied || printf free)
  else
    state=unknown
  fi
  if [ "$state" = occupied ] && [ "$project_owned" = yes ]; then
    env_file="$workdir/config/agentnest.env"
    port_key=$(awk -F= -v port="$port" '$2 == port && $1 ~ /^(OPENCLAW_GATEWAY_PORT|CONTROL_PLANE_PORT|DATA_GATEWAY_MOCK_PORT|EXTERNAL_GATEWAY_MOCK_PORT|POSTGRES_PORT)$/ {print $1; exit}' "$env_file" 2>/dev/null || true)
    if [ -z "$port_key" ] && [ "$port" = "$openclaw_port" ]; then port_key=OPENCLAW_GATEWAY_PORT; fi
    owned=no
    case "$port_key" in
      OPENCLAW_GATEWAY_PORT)
        if [ -f "$workdir/openclaw-state/openclaw.json" ] && [ -f "$workdir/openclaw-state/.env" ]; then
          if (export OPENCLAW_STATE_DIR="$workdir/openclaw-state"; export OPENCLAW_CONFIG_PATH="$workdir/openclaw-state/openclaw.json"; set -a; . "$workdir/openclaw-state/.env"; set +a; openclaw gateway status --require-rpc --json >/dev/null 2>&1); then owned=yes; fi
        fi
        ;;
      CONTROL_PLANE_PORT)
        if [ -n "$docker_cmd" ] && $docker_cmd ps --filter label=com.docker.compose.project=agentnest-demo --filter label=com.docker.compose.service=control-plane --filter status=running -q | grep -q . && curl -fsS -H 'X-Request-Id: preflight-ownership' "http://127.0.0.1:$port/health" >/dev/null 2>&1; then owned=yes; fi
        ;;
      DATA_GATEWAY_MOCK_PORT)
        if [ -n "$docker_cmd" ] && $docker_cmd ps --filter label=com.docker.compose.project=agentnest-demo --filter label=com.docker.compose.service=data-gateway-mock --filter status=running -q | grep -q . && curl -fsS -H 'X-Request-Id: preflight-ownership' "http://127.0.0.1:$port/health" >/dev/null 2>&1; then owned=yes; fi
        ;;
      EXTERNAL_GATEWAY_MOCK_PORT)
        if [ -n "$docker_cmd" ] && $docker_cmd ps --filter label=com.docker.compose.project=agentnest-demo --filter label=com.docker.compose.service=external-gateway-mock --filter status=running -q | grep -q . && curl -fsS -H 'X-Request-Id: preflight-ownership' "http://127.0.0.1:$port/health" >/dev/null 2>&1; then owned=yes; fi
        ;;
      POSTGRES_PORT)
        if [ -n "$docker_cmd" ] && $docker_cmd ps --filter label=com.docker.compose.project=agentnest-demo --filter label=com.docker.compose.service=postgres --filter status=running -q | grep -q .; then owned=yes; fi
        ;;
    esac
    if [ "$owned" = yes ]; then state=owned; fi
  fi
  printf 'PORT_%s=%s\n' "$port" "$state"
done
`;

function parseProbeOutput(output: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    if (/^[A-Z0-9_]+$/.test(key)) {
      values[key] = line.slice(separator + 1).replaceAll(/[\r\n]/g, " ");
    }
  }
  return values;
}

function fingerprint(knownHostsPath: string): string {
  const result = run("ssh-keygen", ["-lf", knownHostsPath]);
  if (result.status !== 0) {
    return "unavailable";
  }
  return result.stdout.trim().split(/\s+/)[1] ?? "unavailable";
}

function toolState(value: string | undefined): "present" | "missing" {
  return value === undefined || value.length === 0 ? "missing" : "present";
}

function determineBlockers(
  probe: Readonly<Record<string, string>>,
  config: PreflightConfig,
): readonly string[] {
  const blockers: string[] = [];
  const canElevate = probe["REMOTE_UID"] === "0" || probe["SUDO_NONINTERACTIVE"] === "yes";
  if (probe["WORKDIR_WRITABLE"] === "parent_no" && !canElevate) {
    blockers.push("REMOTE_WORKDIR parent is not writable by the SSH user");
  }
  if (probe["WORKDIR_EXISTS"] === "yes" && probe["WORKDIR_IS_DIRECTORY"] !== "yes") {
    blockers.push("REMOTE_WORKDIR exists but is not a directory");
  }
  if (toolState(probe["GIT_VERSION"]) === "missing" && !canElevate) {
    blockers.push("Git is missing");
  }
  if (toolState(probe["CURL_VERSION"]) === "missing" && !canElevate) {
    blockers.push("curl is missing");
  }
  if (toolState(probe["NODE_VERSION"]) === "missing" && !canElevate) {
    blockers.push("Node.js is missing and non-interactive sudo is unavailable");
  }
  if (toolState(probe["DOCKER_VERSION"]) === "missing" && !canElevate) {
    blockers.push("Docker is missing and non-interactive sudo is unavailable");
  }
  if (
    probe["DOCKER_VERSION"] !== undefined &&
    probe["DOCKER_VERSION"] !== "" &&
    probe["DOCKER_DAEMON"] !== "reachable" &&
    !canElevate
  ) {
    blockers.push("Docker CLI exists but the SSH user cannot reach the daemon");
  }
  for (const port of config.ports) {
    if (probe[`PORT_${String(port)}`] === "occupied") {
      blockers.push(`required Demo port ${String(port)} is already occupied`);
    }
  }
  if (probe["AGENTNEST_CONTAINER_CONFLICTS"] !== "none") {
    blockers.push("unknown AgentNest-named containers require ownership confirmation");
  }
  return blockers;
}

function determineRequiredActions(probe: Readonly<Record<string, string>>): readonly string[] {
  const actions: string[] = [];
  if (probe["WORKDIR_EXISTS"] !== "yes") {
    actions.push("create the project-scoped REMOTE_WORKDIR");
  }
  if (toolState(probe["NODE_VERSION"]) === "missing") {
    actions.push("install Node.js 24 and npm");
  }
  if (toolState(probe["PNPM_VERSION"]) === "missing") {
    actions.push("install pnpm 11");
  }
  if (toolState(probe["DOCKER_VERSION"]) === "missing") {
    actions.push("install Docker Engine and Compose");
  }
  if (toolState(probe["OPENCLAW_VERSION"]) === "missing") {
    actions.push("install the resolved OpenClaw stable version");
  }
  return actions;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const stable = await resolveStableVersion();
  const knownHostsDirectory = resolve(workspaceRoot, "runtime/ssh");
  const knownHostsPath = resolve(knownHostsDirectory, "known_hosts");
  await mkdir(knownHostsDirectory, { recursive: true, mode: 0o700 });
  {
    await chmod(askpassPath, 0o755);
    const sshArguments = [
      "-T",
      "-p",
      String(config.sshPort),
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=1",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "HashKnownHosts=yes",
      "-o",
      "LogLevel=ERROR",
    ];
    const environment = { ...process.env };
    if (config.authMode === "password") {
      sshArguments.push(
        "-o",
        "PreferredAuthentications=password,keyboard-interactive",
        "-o",
        "PubkeyAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=1",
      );
      environment["SSH_ASKPASS"] = askpassPath;
      environment["SSH_ASKPASS_REQUIRE"] = "force";
      environment["DISPLAY"] = "agentnest-preflight:0";
      environment["AGENTNEST_SSH_PASSWORD"] = config.password ?? "";
    } else {
      sshArguments.push("-o", "BatchMode=yes", "-i", config.privateKeyPath ?? "");
    }
    sshArguments.push(
      `${config.sshUser}@${config.sshHost}`,
      "bash",
      "-s",
      "--",
      config.remoteWorkdir,
      ...config.ports.map(String),
    );

    const sshResult = spawnSync("ssh", sshArguments, {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: environment,
      input: remoteProbe,
      shell: false,
      maxBuffer: 2 * 1024 * 1024,
    });
    delete environment["AGENTNEST_SSH_PASSWORD"];
    if (sshResult.status !== 0) {
      throw new Error(
        `SSH read-only preflight failed with exit code ${String(sshResult.status ?? 1)}`,
      );
    }

    const probe = parseProbeOutput(sshResult.stdout);
    const blockers = determineBlockers(probe, config);
    const requiredActions = determineRequiredActions(probe);
    const reportEnvironment = Object.fromEntries(
      Object.entries(probe).filter(([key]) => key !== "REMOTE_USER" && key !== "REMOTE_UID"),
    );
    const generatedAt = new Date().toISOString();
    const report = {
      schema_version: "1.0",
      generated_at: generatedAt,
      target: "redacted",
      ssh: {
        connected: true,
        auth_mode: config.authMode,
        host_key_fingerprint: fingerprint(knownHostsPath),
      },
      environment: reportEnvironment,
      openclaw_stable: stable,
      blockers,
      required_actions: requiredActions,
      read_only: true,
    };
    await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });

    const toolRows: readonly (readonly [string, string | undefined])[] = [
      ["Node", probe["NODE_VERSION"]],
      ["npm", probe["NPM_VERSION"]],
      ["pnpm", probe["PNPM_VERSION"]],
      ["Docker", probe["DOCKER_VERSION"]],
      ["Docker Compose", probe["COMPOSE_VERSION"]],
      ["Git", probe["GIT_VERSION"]],
      ["curl", probe["CURL_VERSION"]],
      ["OpenClaw", probe["OPENCLAW_VERSION"]],
    ];
    const markdown = [
      "# AgentNest 远端只读 Preflight 报告",
      "",
      `- 时间：\`${generatedAt}\``,
      "- 目标：`redacted`",
      `- SSH：PASS（${config.authMode}，host key \`${fingerprint(knownHostsPath)}\`）`,
      `- OS：\`${probe["OS_ID"] ?? "unknown"} ${probe["OS_VERSION"] ?? ""}\``,
      `- 架构/内核：\`${probe["ARCH"] ?? "unknown"} / ${probe["KERNEL"] ?? "unknown"}\``,
      `- CPU：\`${probe["CPU_COUNT"] ?? "unknown"}\``,
      `- Memory：\`${probe["MEMORY_MIB"] ?? "unknown"} MiB\``,
      `- Free disk：\`${probe["DISK_FREE_MIB"] ?? "unknown"} MiB\``,
      `- REMOTE_WORKDIR：exists=\`${probe["WORKDIR_EXISTS"] ?? "unknown"}\`，writable=\`${probe["WORKDIR_WRITABLE"] ?? "unknown"}\``,
      `- OpenClaw official stable：\`${stable.version}\`（npm latest）`,
      "",
      "## 工具",
      "",
      "| Tool | 只读探测结果 |",
      "|---|---|",
      ...toolRows.map(
        ([name, value]) =>
          `| ${name} | \`${value === undefined || value === "" ? "missing" : value}\` |`,
      ),
      "",
      "## 端口",
      "",
      ...config.ports.map(
        (port) => `- \`${String(port)}\`: \`${probe[`PORT_${String(port)}`] ?? "unknown"}\``,
      ),
      "",
      "## 部署阻塞项",
      "",
      ...(blockers.length === 0 ? ["- 无。"] : blockers.map((blocker) => `- ${blocker}`)),
      "",
      "## 部署准备项",
      "",
      ...(requiredActions.length === 0
        ? ["- 无。"]
        : requiredActions.map((action) => `- ${action}`)),
      "",
      "> 本次只执行远端读取命令；未安装、删除或修改服务器服务和项目目录。",
      "",
    ].join("\n");
    await writeFile(reportMarkdownPath, markdown, { mode: 0o644 });

    console.log("remote SSH read-only preflight: PASS");
    console.log(
      `remote environment: ${probe["OS_ID"] ?? "unknown"} ${probe["OS_VERSION"] ?? ""} ${probe["ARCH"] ?? "unknown"}`.trim(),
    );
    console.log(
      `resources: cpu=${probe["CPU_COUNT"] ?? "unknown"} memory_mib=${probe["MEMORY_MIB"] ?? "unknown"} disk_free_mib=${probe["DISK_FREE_MIB"] ?? "unknown"}`,
    );
    console.log(`OpenClaw official stable: ${stable.version}`);
    console.log(`deployment blockers: ${blockers.length === 0 ? "none" : blockers.join("; ")}`);
    console.log(
      `deployment preparation: ${requiredActions.length === 0 ? "none" : requiredActions.join("; ")}`,
    );
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown preflight failure";
    console.error(`remote preflight failed: ${message}`);
    process.exitCode = 1;
  });
}
