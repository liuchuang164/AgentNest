import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const LOGICAL_AGENT_ID_PATTERN = /^tb_[a-f0-9]{20}$/;

export interface TenantRuntimePaths {
  readonly root: string;
  readonly tenantRoot: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly sessions: string;
  readonly memory: string;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function assertWithinRoot(root: string, candidate: string): void {
  if (!isWithinRoot(root, candidate)) {
    throw new TypeError("runtime path escapes the configured root");
  }
}

export function deriveTenantRuntimePaths(
  runtimeRoot: string,
  logicalAgentId: string,
): TenantRuntimePaths {
  if (!LOGICAL_AGENT_ID_PATTERN.test(logicalAgentId)) {
    throw new TypeError("invalid logical_agent_id for runtime path derivation");
  }
  const root = resolve(runtimeRoot);
  const tenantRoot = resolve(root, "tenants", logicalAgentId);
  const paths = {
    root,
    tenantRoot,
    workspace: resolve(tenantRoot, "workspace"),
    agentDir: resolve(tenantRoot, "agent"),
    sessions: resolve(tenantRoot, "sessions"),
    memory: resolve(tenantRoot, "memory"),
  };
  for (const candidate of Object.values(paths)) {
    assertWithinRoot(root, candidate);
  }
  return paths;
}

export async function assertExistingRuntimePathSafe(
  runtimeRoot: string,
  candidate: string,
): Promise<void> {
  const rootPath = resolve(runtimeRoot);
  const candidatePath = resolve(candidate);
  assertWithinRoot(rootPath, candidatePath);
  const rootRealPath = await realpath(rootPath);
  const candidateStats = await lstat(candidatePath);
  if (candidateStats.isSymbolicLink()) {
    throw new TypeError("runtime path must not be a symbolic link");
  }
  const candidateRealPath = await realpath(candidatePath);
  assertWithinRoot(rootRealPath, candidateRealPath);
}
