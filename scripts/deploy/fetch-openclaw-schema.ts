import { spawnSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, resolveStableVersion } from "./preflight.js";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const knownHostsPath = resolve(workspaceRoot, "runtime/ssh/known_hosts");

async function main(): Promise<void> {
  const config = await loadConfig();
  const stable = await resolveStableVersion();
  const destinationDirectory = resolve(workspaceRoot, "artifacts/reports");
  const destination = resolve(destinationDirectory, `openclaw-schema-${stable.version}.json`);
  await mkdir(destinationDirectory, { recursive: true });
  await chmod(askpassPath, 0o755);

  const arguments_ = [
    "-P",
    String(config.sshPort),
    "-o",
    "ConnectTimeout=20",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "LogLevel=ERROR",
  ];
  const environment = { ...process.env };
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
    environment["DISPLAY"] = "agentnest-schema:0";
    environment["AGENTNEST_SSH_PASSWORD"] = config.password ?? "";
  } else {
    arguments_.push("-o", "BatchMode=yes", "-i", config.privateKeyPath ?? "");
  }
  arguments_.push(
    `${config.sshUser}@${config.sshHost}:${config.remoteWorkdir}/reports/openclaw-schema.json`,
    destination,
  );

  const result = spawnSync("scp", arguments_, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: environment,
    shell: false,
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  delete environment["AGENTNEST_SSH_PASSWORD"];
  if (result.status !== 0) {
    throw new Error(`schema fetch failed with exit code ${String(result.status ?? 1)}`);
  }
  console.log(`OpenClaw ${stable.version} schema fetched`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown schema fetch failure";
  console.error(`schema fetch failed: ${message}`);
  process.exitCode = 1;
});
