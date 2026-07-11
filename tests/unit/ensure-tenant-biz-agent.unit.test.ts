import { DemoTenantCapabilityCatalog } from "@agentnest/capability";
import { L1RuntimeStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  EnsureActiveRuntimeInput,
  EnsureActiveRuntimeResult,
  LogicalAgentRecord,
  RuntimeInstanceRecord,
  TenantRuntimeRepository,
} from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

import { EnsureTenantBizAgent } from "../../apps/control-plane/src/application/ensure-tenant-biz-agent.js";

class InMemoryTenantRuntimeRepository implements TenantRuntimeRepository {
  readonly #logicalAgents = new Map<string, LogicalAgentRecord>();
  readonly #runtimes = new Map<string, RuntimeInstanceRecord>();
  public createCount = 0;

  public async ensureActiveRuntime(
    input: EnsureActiveRuntimeInput,
  ): Promise<EnsureActiveRuntimeResult> {
    await Promise.resolve();
    const existingLogical = this.#logicalAgents.get(input.logicalAgentId);
    const existingRuntime = [...this.#runtimes.values()].find(
      (runtime) =>
        runtime.logicalAgentId === input.logicalAgentId &&
        [L1RuntimeStatus.PROVISIONING, L1RuntimeStatus.ACTIVE, L1RuntimeStatus.IDLE].includes(
          runtime.status,
        ),
    );
    if (existingLogical !== undefined && existingRuntime !== undefined) {
      return { logicalAgent: existingLogical, runtime: existingRuntime, reused: true };
    }

    const runtime: RuntimeInstanceRecord = {
      runtimeInstanceId: input.candidateRuntimeInstanceId,
      logicalAgentId: input.logicalAgentId,
      openclawAgentId: input.openclawAgentId,
      status: L1RuntimeStatus.PROVISIONING,
      startedAt: input.now,
      lastActiveAt: input.now,
      restoredFromRuntimeInstanceId: existingLogical?.currentRuntimeInstanceId ?? null,
    };
    const logicalAgent: LogicalAgentRecord = {
      logicalAgentId: input.logicalAgentId,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      capabilityProfileId: input.capabilityProfileId,
      status: L1RuntimeStatus.PROVISIONING,
      currentRuntimeInstanceId: runtime.runtimeInstanceId,
      lastActiveAt: input.now,
    };
    this.#logicalAgents.set(input.logicalAgentId, logicalAgent);
    this.#runtimes.set(runtime.runtimeInstanceId, runtime);
    this.createCount += 1;
    return { logicalAgent, runtime, reused: false };
  }

  public unload(logicalAgentId: string): void {
    const logicalAgent = this.#logicalAgents.get(logicalAgentId);
    if (logicalAgent === undefined) {
      throw new Error("logical agent has no runtime to unload");
    }
    const currentRuntimeInstanceId = logicalAgent.currentRuntimeInstanceId;
    if (currentRuntimeInstanceId === null) {
      throw new Error("logical agent has no runtime to unload");
    }
    const runtime = this.#runtimes.get(currentRuntimeInstanceId);
    if (runtime === undefined) {
      throw new Error("runtime not found");
    }
    this.#runtimes.set(runtime.runtimeInstanceId, {
      ...runtime,
      status: L1RuntimeStatus.UNLOADED,
    });
    this.#logicalAgents.set(logicalAgentId, {
      ...logicalAgent,
      status: L1RuntimeStatus.UNLOADED,
    });
  }
}

function runtimeIds(...ids: readonly string[]): () => string {
  const remaining = [...ids];
  return () => remaining.shift() ?? `ari_extra_${String(remaining.length)}`;
}

describe("ensureTenantBizAgent", () => {
  const now = () => new Date("2030-01-01T00:00:00.000Z");

  it("reuses the same logical and active runtime for the same tenant/biz scope", async () => {
    const repository = new InMemoryTenantRuntimeRepository();
    const useCase = new EnsureTenantBizAgent(new DemoTenantCapabilityCatalog(), repository, {
      runtimeRoot: "/tmp/agentnest-runtime",
      now,
      createRuntimeId: runtimeIds("ari_01", "ari_02"),
    });
    const first = await useCase.execute({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    const second = await useCase.execute({ tenantId: "tenant_A", bizDomain: "LEGAL" });
    expect(second.logicalAgent.logicalAgentId).toBe(first.logicalAgent.logicalAgentId);
    expect(second.runtime.runtimeInstanceId).toBe(first.runtime.runtimeInstanceId);
    expect(second.reused).toBe(true);
    expect(repository.createCount).toBe(1);
    expect(useCase.cachedRuntime(first.logicalAgent.logicalAgentId)).toEqual(first.runtime);
  });

  it("serializes concurrent ensure calls and creates one runtime", async () => {
    const repository = new InMemoryTenantRuntimeRepository();
    const useCase = new EnsureTenantBizAgent(new DemoTenantCapabilityCatalog(), repository, {
      runtimeRoot: "/tmp/agentnest-runtime",
      now,
      createRuntimeId: runtimeIds("ari_01", "ari_02"),
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        useCase.execute({ tenantId: "tenant_A", bizDomain: "ROBOT_DOG" }),
      ),
    );
    expect(new Set(results.map((result) => result.runtime.runtimeInstanceId)).size).toBe(1);
    expect(repository.createCount).toBe(1);
  });

  it("uses different logical IDs for each Demo scope", async () => {
    const repository = new InMemoryTenantRuntimeRepository();
    const useCase = new EnsureTenantBizAgent(new DemoTenantCapabilityCatalog(), repository, {
      runtimeRoot: "/tmp/agentnest-runtime",
      now,
      createRuntimeId: runtimeIds("ari_01", "ari_02", "ari_03"),
    });
    const scopes: readonly TenantBizScope[] = [
      { tenantId: "tenant_A", bizDomain: "LEGAL" },
      { tenantId: "tenant_A", bizDomain: "ROBOT_DOG" },
      { tenantId: "tenant_B", bizDomain: "LEGAL" },
    ];
    const results = await Promise.all(scopes.map((scope) => useCase.execute(scope)));
    expect(new Set(results.map((result) => result.logicalAgent.logicalAgentId)).size).toBe(3);
    expect(new Set(results.map((result) => result.paths.agentDir)).size).toBe(3);
  });

  it("creates a new runtime after unload while preserving the logical ID", async () => {
    const repository = new InMemoryTenantRuntimeRepository();
    const useCase = new EnsureTenantBizAgent(new DemoTenantCapabilityCatalog(), repository, {
      runtimeRoot: "/tmp/agentnest-runtime",
      now,
      createRuntimeId: runtimeIds("ari_01", "ari_02"),
    });
    const first = await useCase.execute({ tenantId: "tenant_B", bizDomain: "LEGAL" });
    repository.unload(first.logicalAgent.logicalAgentId);
    const restored = await useCase.execute({ tenantId: "tenant_B", bizDomain: "LEGAL" });
    expect(restored.logicalAgent.logicalAgentId).toBe(first.logicalAgent.logicalAgentId);
    expect(restored.runtime.runtimeInstanceId).not.toBe(first.runtime.runtimeInstanceId);
    expect(restored.runtime.restoredFromRuntimeInstanceId).toBe(first.runtime.runtimeInstanceId);
  });
});
