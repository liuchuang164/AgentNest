import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import {
  assertExistingRuntimePathSafe,
  deriveLogicalAgentId,
  deriveTenantRuntimePaths,
} from "@agentnest/capability";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tenant runtime paths", () => {
  it("derives every directory below the configured root from the logical ID only", () => {
    const root = resolve("runtime-test-root");
    const logicalAgentId = deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    const paths = deriveTenantRuntimePaths(root, logicalAgentId);
    for (const path of [
      paths.tenantRoot,
      paths.workspace,
      paths.agentDir,
      paths.sessions,
      paths.memory,
    ]) {
      const fromRoot = relative(root, path);
      expect(fromRoot.startsWith("..")).toBe(false);
      expect(isAbsolute(fromRoot)).toBe(false);
      expect(path).toContain(logicalAgentId);
    }
  });

  it("rejects absolute and traversal-shaped logical IDs", () => {
    for (const logicalAgentId of ["../tb_aaaaaaaaaaaaaaaaaaaa", "/tmp/escape", "tb_bad"] as const) {
      expect(() => deriveTenantRuntimePaths("runtime", logicalAgentId)).toThrow(TypeError);
    }
  });

  it("rejects an existing symlink that escapes the runtime root", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentnest-runtime-"));
    temporaryRoots.push(root);
    const outside = await mkdtemp(resolve(tmpdir(), "agentnest-outside-"));
    temporaryRoots.push(outside);
    await mkdir(resolve(root, "tenants"));
    const link = resolve(root, "tenants", "tb_aaaaaaaaaaaaaaaaaaaa");
    await symlink(outside, link);
    await expect(assertExistingRuntimePathSafe(root, link)).rejects.toThrow(TypeError);
  });
});
