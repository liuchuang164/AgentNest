import type { ExecutionContext } from "@agentnest/contracts";
import type { ExecutionContextRecord } from "@agentnest/persistence";
import { afterEach, describe, expect, it } from "vitest";

import {
  DataGatewayApplication,
  GatewayDenyReason,
  InMemoryDataGatewayFixtures,
  InMemoryGatewayTraceSink,
  PostgresDataGatewayExecutionContextLookup,
  buildDataGatewayMockServer,
  type DataGatewayResponse,
  type ExecutionContextLookup,
} from "../../apps/data-gateway-mock/src/index.js";
import {
  ExternalGatewayApplication,
  ExternalGatewayDenyReason,
  InMemoryExternalGatewayFixtures,
  InMemoryExternalGatewayTraceSink,
  PostgresExternalGatewayExecutionContextLookup,
  buildExternalGatewayMockServer,
  type ExternalExecutionContextLookup,
  type ExternalGatewayResponse,
} from "../../apps/external-gateway-mock/src/index.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const LEGAL_CONTEXT_ID = "11111111-1111-4111-8111-111111111111";
const ROBOT_CONTEXT_ID = "22222222-2222-4222-8222-222222222222";
const LEGAL_B_CONTEXT_ID = "33333333-3333-4333-8333-333333333333";
const EXPIRED_CONTEXT_ID = "44444444-4444-4444-8444-444444444444";
const OWNERSHIP_CONTEXT_ID = "55555555-5555-4555-8555-555555555555";
class TestExecutionContextLookup implements ExecutionContextLookup, ExternalExecutionContextLookup {
  public readonly contexts = new Map<string, unknown>();
  public readonly calls: string[] = [];
  public fail = false;

  public findExecutionContext(executionContextId: string): Promise<unknown> {
    this.calls.push(executionContextId);
    if (this.fail) {
      return Promise.reject(new Error("lookup unavailable"));
    }
    return Promise.resolve(this.contexts.get(executionContextId) ?? null);
  }
}

class RecordingGatewayExecutionContextRecordLookup {
  public readonly calls: string[] = [];
  public record: ExecutionContextRecord | null;

  public constructor(record: ExecutionContextRecord | null) {
    this.record = record;
  }

  public findByGatewayId(executionContextId: string): Promise<ExecutionContextRecord | null> {
    this.calls.push(executionContextId);
    return Promise.resolve(this.record);
  }
}

function persistenceExecutionContextRecord(): ExecutionContextRecord {
  return {
    executionContextId: LEGAL_CONTEXT_ID,
    tenantId: "tenant_A",
    bizDomain: "LEGAL",
    logicalAgentId: `tb_${"a".repeat(20)}`,
    runtimeInstanceId: "runtime_legal_a_001",
    sessionId: "session_legal_a_001",
    taskId: "task_legal_a_001",
    allowedSkills: ["legal-evidence-check"],
    allowedTools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    },
    resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
    expiresAt: new Date("2030-01-01T01:00:00.000Z"),
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const fixedClock = Object.freeze({ now: (): Date => new Date(NOW) });

function executionContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    execution_context_id: LEGAL_CONTEXT_ID,
    tenant_id: "tenant_A",
    biz_domain: "LEGAL",
    logical_agent_id: `tb_${"a".repeat(20)}`,
    runtime_instance_id: "runtime_legal_a_001",
    session_id: "session_legal_a_001",
    task_id: "task_legal_a_001",
    allowed_skills: ["legal-evidence-check"],
    allowed_tools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    },
    resource_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
    expires_at: "2030-01-01T01:00:00.000Z",
    ...overrides,
  };
}

function robotContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return executionContext({
    execution_context_id: ROBOT_CONTEXT_ID,
    tenant_id: "tenant_A",
    biz_domain: "ROBOT_DOG",
    logical_agent_id: `tb_${"b".repeat(20)}`,
    runtime_instance_id: "runtime_robot_a_001",
    session_id: "session_robot_a_001",
    task_id: "task_robot_a_001",
    allowed_skills: ["robot-dog-health-check"],
    allowed_tools: {
      robot_device_read: ["read"],
      robot_health_write: ["write"],
      robot_telemetry_enrich: ["query"],
    },
    resource_scope: { resource_type: "DEVICE", resource_ids: ["device_001"] },
    ...overrides,
  });
}

function legalRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    request_id: "tool_req_legal_001",
    trace_id: "trace_legal_001",
    execution_context_id: LEGAL_CONTEXT_ID,
    tool_name: "legal_case_read",
    action: "read",
    resource: { resource_type: "CASE", resource_id: "case_001" },
    params: {},
    ...overrides,
  };
}

function robotRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    request_id: "tool_req_robot_001",
    trace_id: "trace_robot_001",
    execution_context_id: ROBOT_CONTEXT_ID,
    tool_name: "robot_device_read",
    action: "read",
    resource: { resource_type: "DEVICE", resource_id: "device_001" },
    params: {},
    ...overrides,
  };
}

interface DataHarness {
  readonly lookup: TestExecutionContextLookup;
  readonly fixtures: InMemoryDataGatewayFixtures;
  readonly traces: InMemoryGatewayTraceSink;
  readonly application: DataGatewayApplication;
}

function dataHarness(): DataHarness {
  const lookup = new TestExecutionContextLookup();
  lookup.contexts.set(LEGAL_CONTEXT_ID, executionContext());
  lookup.contexts.set(ROBOT_CONTEXT_ID, robotContext());
  lookup.contexts.set(
    LEGAL_B_CONTEXT_ID,
    executionContext({
      execution_context_id: LEGAL_B_CONTEXT_ID,
      tenant_id: "tenant_B",
      logical_agent_id: `tb_${"c".repeat(20)}`,
      runtime_instance_id: "runtime_legal_b_001",
      session_id: "session_legal_b_001",
      task_id: "task_legal_b_001",
    }),
  );
  const fixtures = new InMemoryDataGatewayFixtures();
  const traces = new InMemoryGatewayTraceSink();
  return {
    lookup,
    fixtures,
    traces,
    application: new DataGatewayApplication({
      contextLookup: lookup,
      fixtures,
      traceSink: traces,
      clock: fixedClock,
    }),
  };
}

interface ExternalHarness {
  readonly lookup: TestExecutionContextLookup;
  readonly fixtures: InMemoryExternalGatewayFixtures;
  readonly traces: InMemoryExternalGatewayTraceSink;
  readonly application: ExternalGatewayApplication;
}

function externalHarness(): ExternalHarness {
  const lookup = new TestExecutionContextLookup();
  lookup.contexts.set(LEGAL_CONTEXT_ID, executionContext());
  lookup.contexts.set(ROBOT_CONTEXT_ID, robotContext());
  const fixtures = new InMemoryExternalGatewayFixtures();
  const traces = new InMemoryExternalGatewayTraceSink();
  return {
    lookup,
    fixtures,
    traces,
    application: new ExternalGatewayApplication({
      contextLookup: lookup,
      fixtures,
      traceSink: traces,
      clock: fixedClock,
    }),
  };
}

function expectDenied(
  response: DataGatewayResponse | ExternalGatewayResponse,
  reason: string,
): void {
  expect(response).toMatchObject({
    success: false,
    data: null,
    error: { reason },
  });
}

const servers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("ExecutionContext persistence adapters", () => {
  it("maps scoped camelCase repository records into the contracts shape used by both Gateways", async () => {
    const repository = new RecordingGatewayExecutionContextRecordLookup(
      persistenceExecutionContextRecord(),
    );
    const lookupInput = LEGAL_CONTEXT_ID;
    const dataContext = await new PostgresDataGatewayExecutionContextLookup(
      repository,
    ).findExecutionContext(lookupInput);
    const externalContext = await new PostgresExternalGatewayExecutionContextLookup(
      repository,
    ).findExecutionContext(lookupInput);

    for (const context of [dataContext, externalContext]) {
      expect(context).toMatchObject({
        execution_context_id: LEGAL_CONTEXT_ID,
        tenant_id: "tenant_A",
        biz_domain: "LEGAL",
        logical_agent_id: `tb_${"a".repeat(20)}`,
        allowed_skills: ["legal-evidence-check"],
        allowed_tools: { legal_case_read: ["read"] },
        resource_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
        expires_at: "2030-01-01T01:00:00.000Z",
      });
      expect(Object.isFrozen(context)).toBe(true);
    }
    expect(repository.calls).toEqual([lookupInput, lookupInput]);
  });

  it("preserves gateway not-found and integrates the mapped record with authorization", async () => {
    const emptyRepository = new RecordingGatewayExecutionContextRecordLookup(null);
    await expect(
      new PostgresDataGatewayExecutionContextLookup(emptyRepository).findExecutionContext(
        LEGAL_CONTEXT_ID,
      ),
    ).resolves.toBeNull();

    const repository = new RecordingGatewayExecutionContextRecordLookup(
      persistenceExecutionContextRecord(),
    );
    const fixtures = new InMemoryDataGatewayFixtures();
    const traces = new InMemoryGatewayTraceSink();
    const application = new DataGatewayApplication({
      contextLookup: new PostgresDataGatewayExecutionContextLookup(repository),
      fixtures,
      traceSink: traces,
      clock: fixedClock,
    });
    await expect(application.execute(legalRequest())).resolves.toMatchObject({
      success: true,
      data: { title: "Alpha contract evidence" },
    });
    expect(repository.calls[0]).toBe(LEGAL_CONTEXT_ID);
  });
});

describe("Data Gateway Mock", () => {
  it("executes all LEGAL data tools deterministically within the context scope", async () => {
    const harness = dataHarness();
    const read = await harness.application.execute(legalRequest());
    const write = await harness.application.execute(
      legalRequest({
        request_id: "tool_req_legal_write_001",
        tool_name: "legal_analysis_write",
        action: "write",
        params: { analysis: "The Alpha evidence chain is complete." },
      }),
    );

    expect(read).toMatchObject({
      success: true,
      data: {
        resource_id: "case_001",
        title: "Alpha contract evidence",
        facts: ["alpha-signed-contract", "alpha-payment-record"],
      },
    });
    expect(write).toMatchObject({
      success: true,
      data: { result_id: "legal_analysis_001", stored: true },
    });
    expect(harness.fixtures.snapshot()).toMatchObject({
      legalAnalyses: [
        {
          resultId: "legal_analysis_001",
          tenantId: "tenant_A",
          bizDomain: "LEGAL",
          resourceId: "case_001",
        },
      ],
      operations: [{ toolName: "legal_case_read" }, { toolName: "legal_analysis_write" }],
    });
    expect(harness.traces.records).toHaveLength(2);
    expect(harness.traces.records.every((record) => record.decision === "ALLOW")).toBe(true);
    expect(harness.lookup.calls[0]).toBe(LEGAL_CONTEXT_ID);
  });

  it("executes all ROBOT_DOG data tools deterministically within the context scope", async () => {
    const harness = dataHarness();
    const read = await harness.application.execute(robotRequest());
    const write = await harness.application.execute(
      robotRequest({
        request_id: "tool_req_robot_write_001",
        tool_name: "robot_health_write",
        action: "write",
        params: { health_status: "DEGRADED", note: "left actuator temperature elevated" },
      }),
    );

    expect(read).toMatchObject({
      success: true,
      data: {
        resource_id: "device_001",
        model: "AgentNest-Dog-1",
        firmware: "demo-1.0.0",
      },
    });
    expect(write).toMatchObject({
      success: true,
      data: { result_id: "robot_health_001", stored: true },
    });
    expect(harness.fixtures.snapshot()).toMatchObject({
      robotHealthResults: [
        {
          resultId: "robot_health_001",
          tenantId: "tenant_A",
          bizDomain: "ROBOT_DOG",
          healthStatus: "DEGRADED",
        },
      ],
    });
  });

  it("denies LEGAL-to-ROBOT_DOG tool escalation with no side effect and a DENY trace", async () => {
    const harness = dataHarness();
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      legalRequest({
        tool_name: "robot_device_read",
        action: "read",
        resource: { resource_type: "DEVICE", resource_id: "device_001" },
      }),
    );

    expectDenied(response, GatewayDenyReason.TOOL_ACTION_DENIED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      requestId: "tool_req_legal_001",
      traceId: "trace_legal_001",
      executionContextId: LEGAL_CONTEXT_ID,
      decision: "DENY",
      reason: GatewayDenyReason.TOOL_ACTION_DENIED,
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: `tb_${"a".repeat(20)}`,
      runtimeInstanceId: "runtime_legal_a_001",
      sessionId: "session_legal_a_001",
      taskId: "task_legal_a_001",
      toolName: "robot_device_read",
      action: "read",
      resourceType: "DEVICE",
      resourceId: "device_001",
    });
  });

  it("denies ROBOT_DOG-to-LEGAL tool escalation with no side effect and a DENY trace", async () => {
    const harness = dataHarness();
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      robotRequest({
        tool_name: "legal_case_read",
        action: "read",
        resource: { resource_type: "CASE", resource_id: "case_001" },
      }),
    );

    expectDenied(response, GatewayDenyReason.TOOL_ACTION_DENIED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: GatewayDenyReason.TOOL_ACTION_DENIED,
      bizDomain: "ROBOT_DOG",
    });
  });

  it("denies an ungranted action without a write side effect", async () => {
    const harness = dataHarness();
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      legalRequest({ action: "write", params: { analysis: "forged" } }),
    );

    expectDenied(response, GatewayDenyReason.TOOL_ACTION_DENIED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: GatewayDenyReason.TOOL_ACTION_DENIED,
    });
  });

  it("uses tenant+biz ownership and cannot reach a tenant_B-only resource", async () => {
    const harness = dataHarness();
    harness.lookup.contexts.set(
      OWNERSHIP_CONTEXT_ID,
      executionContext({
        execution_context_id: OWNERSHIP_CONTEXT_ID,
        resource_scope: { resource_type: "CASE", resource_ids: ["case_B_only"] },
      }),
    );
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      legalRequest({
        execution_context_id: OWNERSHIP_CONTEXT_ID,
        resource: { resource_type: "CASE", resource_id: "case_B_only" },
      }),
    );

    expectDenied(response, GatewayDenyReason.RESOURCE_OWNERSHIP_DENIED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: GatewayDenyReason.RESOURCE_OWNERSHIP_DENIED,
      tenantId: "tenant_A",
    });
  });

  it.each([
    ["unknown", "66666666-6666-4666-8666-666666666666", GatewayDenyReason.CONTEXT_UNKNOWN],
    ["expired", EXPIRED_CONTEXT_ID, GatewayDenyReason.CONTEXT_EXPIRED],
  ] as const)("fails closed for an %s execution context", async (_label, contextId, reason) => {
    const harness = dataHarness();
    if (contextId === EXPIRED_CONTEXT_ID) {
      harness.lookup.contexts.set(
        EXPIRED_CONTEXT_ID,
        executionContext({
          execution_context_id: EXPIRED_CONTEXT_ID,
          expires_at: NOW.toISOString(),
        }),
      );
    }
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      legalRequest({ execution_context_id: contextId }),
    );

    expectDenied(response, reason);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({ decision: "DENY", reason });
  });

  it("rejects body scope overrides through Fastify validation and still records DENY", async () => {
    const harness = dataHarness();
    const server = buildDataGatewayMockServer({
      contextLookup: harness.lookup,
      fixtures: harness.fixtures,
      traceSink: harness.traces,
      clock: fixedClock,
    });
    servers.push(server);
    const before = harness.fixtures.snapshot();
    const response = await server.inject({
      method: "POST",
      url: "/v1/tools/execute",
      payload: { ...legalRequest(), tenant_id: "tenant_B", biz_domain: "LEGAL" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      code: "INVALID_REQUEST",
      error: { reason: GatewayDenyReason.INVALID_REQUEST },
    });
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: GatewayDenyReason.INVALID_REQUEST,
      tenantId: null,
    });
  });
});

describe("External Gateway Mock", () => {
  it("executes LEGAL research and ROBOT_DOG telemetry deterministically", async () => {
    const harness = externalHarness();
    const legal = await harness.application.execute(
      legalRequest({
        tool_name: "legal_research_query",
        action: "query",
        params: { query: "evidence chain" },
      }),
    );
    const robot = await harness.application.execute(
      robotRequest({
        tool_name: "robot_telemetry_enrich",
        action: "query",
        params: { telemetry: [2, 4, 6] },
      }),
    );

    expect(legal).toMatchObject({
      success: true,
      data: {
        query: "evidence chain",
        citations: ["ALPHA-STATUTE-101", "ALPHA-PRECEDENT-7"],
      },
    });
    expect(robot).toMatchObject({
      success: true,
      data: { sample_count: 3, average: 4, health_band: "NOMINAL" },
    });
    expect(harness.fixtures.snapshot().operations).toHaveLength(2);
    expect(harness.traces.records.every((record) => record.decision === "ALLOW")).toBe(true);
  });

  it("denies cross-business external tools with no operation and a DENY trace", async () => {
    const harness = externalHarness();
    const before = harness.fixtures.snapshot();
    const response = await harness.application.execute(
      legalRequest({
        tool_name: "robot_telemetry_enrich",
        action: "query",
        resource: { resource_type: "DEVICE", resource_id: "device_001" },
        params: { telemetry: [1] },
      }),
    );

    expectDenied(response, ExternalGatewayDenyReason.TOOL_ACTION_DENIED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: ExternalGatewayDenyReason.TOOL_ACTION_DENIED,
    });
  });

  it("fails closed for malformed authoritative context and lookup failure", async () => {
    const harness = externalHarness();
    harness.lookup.contexts.set(LEGAL_CONTEXT_ID, {
      execution_context_id: LEGAL_CONTEXT_ID,
      tenant_id: "tenant_A",
      biz_domain: "LEGAL",
    });
    const before = harness.fixtures.snapshot();
    const invalidContext = await harness.application.execute(
      legalRequest({
        tool_name: "legal_research_query",
        action: "query",
        params: { query: "test" },
      }),
    );
    expectDenied(invalidContext, ExternalGatewayDenyReason.CONTEXT_INVALID);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: ExternalGatewayDenyReason.CONTEXT_INVALID,
    });

    harness.lookup.fail = true;
    const lookupFailure = await harness.application.execute(
      legalRequest({
        tool_name: "legal_research_query",
        action: "query",
        params: { query: "test" },
      }),
    );
    expectDenied(lookupFailure, ExternalGatewayDenyReason.CONTEXT_LOOKUP_FAILED);
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: ExternalGatewayDenyReason.CONTEXT_LOOKUP_FAILED,
    });
  });

  it("rejects invalid tool params over Fastify with no side effect and a DENY trace", async () => {
    const harness = externalHarness();
    const server = buildExternalGatewayMockServer({
      contextLookup: harness.lookup,
      fixtures: harness.fixtures,
      traceSink: harness.traces,
      clock: fixedClock,
    });
    servers.push(server);
    const before = harness.fixtures.snapshot();
    const response = await server.inject({
      method: "POST",
      url: "/v1/tools/execute",
      payload: legalRequest({
        tool_name: "legal_research_query",
        action: "query",
        params: {},
      }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      success: false,
      error: { reason: ExternalGatewayDenyReason.INVALID_TOOL_PARAMS },
    });
    expect(harness.fixtures.snapshot()).toEqual(before);
    expect(harness.traces.records.at(-1)).toMatchObject({
      decision: "DENY",
      reason: ExternalGatewayDenyReason.INVALID_TOOL_PARAMS,
    });
  });
});
