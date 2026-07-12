import { spawnSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PreflightConfig } from "./preflight.js";

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const askpassPath = resolve(workspaceRoot, "scripts/deploy/ssh-askpass.sh");
const knownHostsPath = resolve(workspaceRoot, "runtime/ssh/known_hosts");

export interface RemoteCommandResult {
  readonly status: number;
  readonly stdout: string;
}

interface RemoteRunOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

function authentication(
  config: PreflightConfig,
  purpose: string,
): { readonly arguments: string[]; readonly environment: NodeJS.ProcessEnv } {
  const arguments_: string[] = [];
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
    environment["DISPLAY"] = `agentnest-${purpose}:0`;
    environment["AGENTNEST_SSH_PASSWORD"] = config.password ?? "";
  } else {
    arguments_.push("-o", "BatchMode=yes", "-i", config.privateKeyPath ?? "");
  }
  return { arguments: arguments_, environment };
}

function sharedOptions(): string[] {
  return [
    "-o",
    "ConnectTimeout=20",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "HashKnownHosts=yes",
    "-o",
    "LogLevel=ERROR",
  ];
}

export async function prepareRemoteTransport(): Promise<void> {
  await mkdir(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  await chmod(askpassPath, 0o755);
}

export function runRemoteScript(
  config: PreflightConfig,
  purpose: string,
  script: string,
  arguments_: readonly string[],
  options: RemoteRunOptions = {},
): RemoteCommandResult {
  const auth = authentication(config, purpose);
  const sshArguments = [
    "-T",
    "-p",
    String(config.sshPort),
    ...sharedOptions(),
    ...auth.arguments,
    `${config.sshUser}@${config.sshHost}`,
    "bash",
    "-s",
    "--",
    ...arguments_,
  ];
  const result = spawnSync("ssh", sshArguments, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: auth.environment,
    input: script,
    shell: false,
    timeout: options.timeoutMs ?? 10 * 60 * 1_000,
    maxBuffer: options.maxBufferBytes ?? 8 * 1_024 * 1_024,
  });
  delete auth.environment["AGENTNEST_SSH_PASSWORD"];
  return { status: result.status ?? 1, stdout: result.stdout };
}

export function copyFileToRemote(
  config: PreflightConfig,
  purpose: string,
  localPath: string,
  remotePath: string,
): void {
  const auth = authentication(config, purpose);
  const scpArguments = [
    "-P",
    String(config.sshPort),
    ...sharedOptions(),
    ...auth.arguments,
    localPath,
    `${config.sshUser}@${config.sshHost}:${remotePath}`,
  ];
  const result = spawnSync("scp", scpArguments, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: auth.environment,
    shell: false,
    timeout: 10 * 60 * 1_000,
    maxBuffer: 2 * 1_024 * 1_024,
  });
  delete auth.environment["AGENTNEST_SSH_PASSWORD"];
  if (result.status !== 0) {
    throw new Error(`source upload failed with exit code ${String(result.status ?? 1)}`);
  }
}

export function parseKeyValueOutput(output: string): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator);
    if (/^[A-Z0-9_]+$/u.test(key)) {
      values[key] = line.slice(separator + 1).replaceAll(/[\r\n]/gu, " ");
    }
  }
  return values;
}
