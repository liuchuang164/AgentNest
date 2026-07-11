import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveStableVersion } from "./preflight.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const knownHostsDirectory = resolve(workspaceRoot, "runtime/ssh");
const knownHostsPath = resolve(knownHostsDirectory, "known_hosts");
const reportPath = resolve(workspaceRoot, "artifacts/reports/remote-bootstrap-summary.json");

const remoteInstallScript = String.raw`set -Eeuo pipefail
workdir=$1
openclaw_version=$2
pnpm_version=$3
export DEBIAN_FRONTEND=noninteractive
stage=initialization
trap 'printf "INSTALL_FAILED_STAGE=%s\n" "$stage"' ERR

stage=apt_prerequisites
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl gnupg git jq

node_major=
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
fi
if [ "$node_major" != 24 ]; then
  stage=node_download
  node_setup=/tmp/agentnest-nodesource-setup.sh
  curl -4 -fsSL --retry 4 --retry-all-errors https://deb.nodesource.com/setup_24.x -o "$node_setup"
  stage=node_install
  sudo -E bash "$node_setup" >/dev/null
  rm -f "$node_setup"
  sudo apt-get install -y -qq nodejs
fi

if ! command -v docker >/dev/null 2>&1; then
  stage=docker_download
  docker_setup=/tmp/agentnest-get-docker.sh
  curl -4 -fsSL --retry 5 --retry-all-errors --retry-delay 2 https://get.docker.com -o "$docker_setup"
  stage=docker_install
  sudo sh "$docker_setup" >/dev/null
  rm -f "$docker_setup"
fi
stage=docker_start
sudo systemctl enable --now docker >/dev/null

stage=node_packages
sudo npm install -g "pnpm@$pnpm_version" "openclaw@$openclaw_version" >/dev/null

stage=project_directories
sudo install -d -m 0755 -o "$(id -u)" -g "$(id -g)" "$workdir"
for directory in source config openclaw-state postgres-data runtime-persistence reports; do
  install -d -m 0755 "$workdir/$directory"
done

export OPENCLAW_STATE_DIR="$workdir/openclaw-state"
export OPENCLAW_CONFIG_PATH="$workdir/openclaw-state/openclaw.json"
stage=qwen_plugin
if ! openclaw plugins list --json 2>/dev/null | grep -q 'qwen'; then
  openclaw plugins install @openclaw/qwen-provider >/dev/null
fi
stage=config_schema
openclaw config schema > "$workdir/reports/openclaw-schema.json"

trap - ERR
printf 'BOOTSTRAP=PASS\n'
printf 'NODE_VERSION=%s\n' "$(node --version)"
printf 'NPM_VERSION=%s\n' "$(npm --version)"
printf 'PNPM_VERSION=%s\n' "$(pnpm --version)"
printf 'DOCKER_VERSION=%s\n' "$(docker --version)"
printf 'COMPOSE_VERSION=%s\n' "$(sudo docker compose version)"
printf 'OPENCLAW_VERSION=%s\n' "$(openclaw --version)"
printf 'OPENCLAW_SCHEMA_SHA256=%s\n' "$(sha256sum "$workdir/reports/openclaw-schema.json" | awk '{print $1}')"
`;

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
  await mkdir(knownHostsDirectory, { recursive: true, mode: 0o700 });
  await chmod(askpassPath, 0o755);

  const sshArguments = [
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
    environment["DISPLAY"] = "agentnest-install:0";
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
    stable.version,
    "11.11.0",
  );

  const result = spawnSync("ssh", sshArguments, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    input: remoteInstallScript,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  delete environment["AGENTNEST_SSH_PASSWORD"];
  if (result.status !== 0) {
    const observed = parseOutput(result.stdout);
    throw new Error(
      `remote prerequisite install failed at ${observed["INSTALL_FAILED_STAGE"] ?? "unknown stage"} with exit code ${String(result.status ?? 1)}`,
    );
  }
  const observed = parseOutput(result.stdout);
  const observedStableVersion = observed["OPENCLAW_VERSION"]?.match(/\d{4}\.\d+\.\d+/)?.[0];
  if (observed["BOOTSTRAP"] !== "PASS" || observedStableVersion !== stable.version) {
    throw new Error("remote prerequisite install did not produce the expected stable versions");
  }
  const report = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    target: "redacted",
    expected_openclaw_version: stable.version,
    observed,
    status: "PASS",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  console.log("remote prerequisite install: PASS");
  console.log(`Node: ${observed["NODE_VERSION"] ?? "unknown"}`);
  console.log(`pnpm: ${observed["PNPM_VERSION"] ?? "unknown"}`);
  console.log(`Docker: ${observed["DOCKER_VERSION"] ?? "unknown"}`);
  console.log(`OpenClaw stable: ${observed["OPENCLAW_VERSION"] ?? "unknown"}`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown remote install failure";
  console.error(`remote install failed: ${message}`);
  process.exitCode = 1;
});
