import { DemoTenantCapabilityCatalog, deriveLogicalAgentId } from "@agentnest/capability";
import { ExecutionContextDenyReason } from "@agentnest/persistence";
import type {
  CreateExecutionContextInput,
  ExecutionContextRecord,
  ExecutionContextRepository,
  ExecutionContextAuthorization,
} from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

import { CreateTaskExecutionContext } from "../../apps/control-plane/src/index.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

class RecordingExecutionContextRepository implements ExecutionContextRepository {
  public inputs: CreateExecutionContextInput[] = [];

  public create(input: CreateExecutionContextInput): Promise<ExecutionContextRecord> {
    this.inputs.push(structuredClone(input));
    return Promise.resolve({
      executionContextId: "11111111-1111-4111-8111-111111111111",
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      allowedSkills: input.allowedSkills,
      allowedTools: input.allowedTools,
      resourceScope: input.resourceScope,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  public findById(): Promise<ExecutionContextRecord | null> {
    return Promise.resolve(null);
  }

  public authorize(): Promise<ExecutionContextAuthorization> {
    return Promise.resolve({
      allowed: false,
      reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND,
    });
  }
}

function legalInput() {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    logicalAgentId: deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" }),
    runtimeInstanceId: "ari_legal_001",
    sessionId: "agent:l2_legal:subagent:session_001",
    taskId: "task_legal_001",
    taskType: "LEGAL_EVIDENCE_CHECK",
    resourceType: "CASE",
    resourceId: "case_001",
  } as const;
}

describe("CreateTaskExecutionContext", () => {
  it("creates server-authoritative task capability with the L2 TTL", async () => {
    const repository = new RecordingExecutionContextRepository();
    const service = new CreateTaskExecutionContext(new DemoTenantCapabilityCatalog(), repository, {
      now: () => new Date(NOW),
    });

    const created = await service.execute(legalInput());

    expect(created).toMatchObject({
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      allowedSkills: ["legal-evidence-check"],
      allowedTools: {
        legal_case_read: ["read"],
        legal_analysis_write: ["write"],
        legal_research_query: ["query"],
      },
      resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
      expiresAt: new Date("2030-01-01T01:00:00.000Z"),
    });
    expect(repository.inputs).toHaveLength(1);
  });

  it("rejects a caller-supplied logical agent outside the tenant/business scope", async () => {
    const repository = new RecordingExecutionContextRepository();
    const service = new CreateTaskExecutionContext(new DemoTenantCapabilityCatalog(), repository, {
      now: () => new Date(NOW),
    });

    await expect(
      service.execute({
        ...legalInput(),
        logicalAgentId: deriveLogicalAgentId({ tenantId: "tenant_B", bizDomain: "LEGAL" }),
      }),
    ).rejects.toThrow("does not match");
    expect(repository.inputs).toHaveLength(0);
  });

  it("rejects a task template from another business domain", async () => {
    const repository = new RecordingExecutionContextRepository();
    const service = new CreateTaskExecutionContext(new DemoTenantCapabilityCatalog(), repository, {
      now: () => new Date(NOW),
    });

    await expect(
      service.execute({ ...legalInput(), taskType: "ROBOT_DOG_HEALTH_CHECK" }),
    ).rejects.toThrow("no authorized capability");
    expect(repository.inputs).toHaveLength(0);
  });
});
