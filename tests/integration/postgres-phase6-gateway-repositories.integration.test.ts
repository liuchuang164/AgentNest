import {
  PostgresDemoGatewayRepository,
  PostgresDemoReadRepository,
  PostgresGatewayTraceRepository,
  type DemoGatewayOperationInput,
  type PostgresClient,
  type PostgresPool,
  type SqlQueryResult,
} from "@agentnest/persistence";
import { L1RuntimeStatus } from "@agentnest/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  DataGatewayPersistence,
  GatewayTraceSink,
} from "../../apps/data-gateway-mock/src/index.js";
import type {
  ExternalGatewayPersistence,
  ExternalGatewayTraceSink,
} from "../../apps/external-gateway-mock/src/index.js";

const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TRACE_EVENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTEXT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOGICAL_AGENT_ID = `tb_${"d".repeat(20)}`;
const NOW = new Date("2030-01-01T00:00:00.000Z");

class RecordingPhase6Client implements PostgresClient {
  public readonly statements: string[] = [];
  public readonly values: (readonly unknown[] | undefined)[] = [];
  public releaseCount = 0;
  public resourceOwned = true;

  public query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    const statement = text.replaceAll(/\s+/gu, " ").trim();
    this.statements.push(statement);
    this.values.push(values);
    let rows: readonly Record<string, unknown>[] = [];
    if (statement.includes("SELECT EXISTS") && statement.includes("FROM demo_resource")) {
      rows = [{ owned: this.resourceOwned }];
    } else if (statement.startsWith("SELECT payload_json")) {
      rows = this.resourceOwned
        ? [
            {
              payload_json: {
                title: "Alpha contract evidence",
                facts: ["alpha-signed-contract", "alpha-payment-record"],
              },
            },
          ]
        : [];
    } else if (statement === "SELECT 1 AS healthy") {
      rows = [{ healthy: 1 }];
    } else if (statement.includes("to_regclass('public.tenant_biz_agent')")) {
      rows = [
        {
          tenant_biz_agent: "tenant_biz_agent",
          execution_context: "execution_context",
          agent_task: "agent_task",
          demo_resource: "demo_resource",
          demo_gateway_operation: "demo_gateway_operation",
          gateway_trace_event: "gateway_trace_event",
        },
      ];
    } else if (statement.includes("FROM tenant_biz_agent AS agent")) {
      rows = [
        {
          tenant_id: "tenant_A",
          biz_domain: "LEGAL",
          logical_agent_id: LOGICAL_AGENT_ID,
          status: "ACTIVE",
          current_runtime_instance_id: "runtime_001",
          last_active_at: NOW,
          capability_profile_id: "cap_tenant_a_legal_v1",
          active_l2_count: 1,
        },
      ];
    }
    return Promise.resolve({ rows: rows as readonly TRow[], rowCount: rows.length });
  }

  public release(): void {
    this.releaseCount += 1;
  }
}

class RecordingPhase6Pool implements PostgresPool {
  public constructor(public readonly client: RecordingPhase6Client) {}

  public connect(): Promise<PostgresClient> {
    return Promise.resolve(this.client);
  }
}

function operationInput(
  overrides: Partial<DemoGatewayOperationInput> = {},
): DemoGatewayOperationInput {
  return {
    requestId: "request_001",
    traceId: "trace_001",
    executionContextId: CONTEXT_ID,
    tenantId: "tenant_A",
    bizDomain: "LEGAL",
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "runtime_001",
    sessionId: "session_001",
    taskId: "task_001",
    toolName: "legal_case_read",
    action: "read",
    resourceType: "CASE",
    resourceId: "case_001",
    params: {},
    now: NOW,
    ...overrides,
  };
}

describe("Phase 6 PostgreSQL Gateway repositories", () => {
  it("matches both Gateway persistence ports without an in-memory adapter", () => {
    const repository = new PostgresDemoGatewayRepository(
      new RecordingPhase6Pool(new RecordingPhase6Client()),
    );
    const traceRepository = new PostgresGatewayTraceRepository(
      new RecordingPhase6Pool(new RecordingPhase6Client()),
      { gatewayName: "DATA" },
    );

    expectTypeOf(repository).toExtend<DataGatewayPersistence>();
    expectTypeOf(repository).toExtend<ExternalGatewayPersistence>();
    expectTypeOf(traceRepository).toExtend<GatewayTraceSink>();
    expectTypeOf(traceRepository).toExtend<ExternalGatewayTraceSink>();
  });

  it("reads ownership and executes a Data operation with tenant/business-scoped SQL", async () => {
    const client = new RecordingPhase6Client();
    const repository = new PostgresDemoGatewayRepository(new RecordingPhase6Pool(client), {
      createId: () => OPERATION_ID,
    });

    const owned = await repository.ownsResource("tenant_A", "LEGAL", "CASE", "case_001");
    const result = await repository.executeDataOperation(operationInput());

    expect(owned).toBe(true);
    expect(result).toEqual({
      resource_id: "case_001",
      title: "Alpha contract evidence",
      facts: ["alpha-signed-contract", "alpha-payment-record"],
    });
    const ownershipIndex = client.statements.findIndex((statement) =>
      statement.includes("SELECT EXISTS"),
    );
    const resourceIndex = client.statements.findIndex((statement) =>
      statement.startsWith("SELECT payload_json"),
    );
    const insertIndex = client.statements.findIndex((statement) =>
      statement.includes("INSERT INTO demo_gateway_operation"),
    );
    expect(client.statements[ownershipIndex]).toContain("tenant_id = $1");
    expect(client.statements[ownershipIndex]).toContain("biz_domain = $2");
    expect(client.values[ownershipIndex]).toEqual(["tenant_A", "LEGAL", "CASE", "case_001"]);
    expect(client.statements[resourceIndex]).toContain("tenant_id = $1");
    expect(client.statements[resourceIndex]).toContain("biz_domain = $2");
    expect(client.values[insertIndex]?.slice(0, 4)).toEqual([
      "tenant_A",
      "LEGAL",
      OPERATION_ID,
      "DATA",
    ]);
    expect(client.releaseCount).toBe(2);
  });

  it("persists deterministic External results through the same scoped resource boundary", async () => {
    const client = new RecordingPhase6Client();
    const repository = new PostgresDemoGatewayRepository(new RecordingPhase6Pool(client), {
      createId: () => OPERATION_ID,
    });

    const result = await repository.executeExternalOperation(
      operationInput({
        toolName: "legal_research_query",
        action: "query",
        params: { query: "evidence chain" },
      }),
    );

    expect(result).toEqual({
      query: "evidence chain",
      citations: ["ALPHA-STATUTE-101", "ALPHA-PRECEDENT-7"],
    });
    const insertIndex = client.statements.findIndex((statement) =>
      statement.includes("INSERT INTO demo_gateway_operation"),
    );
    expect(client.values[insertIndex]?.[3]).toBe("EXTERNAL");
  });

  it("writes ALLOW/DENY Gateway traces and keeps scoped trace reads tenant-prefixed", async () => {
    const client = new RecordingPhase6Client();
    const repository = new PostgresGatewayTraceRepository(new RecordingPhase6Pool(client), {
      gatewayName: "DATA",
      createId: () => TRACE_EVENT_ID,
    });

    await repository.append({
      requestId: "request_001",
      traceId: "trace_001",
      executionContextId: CONTEXT_ID,
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "runtime_001",
      sessionId: "session_001",
      taskId: "task_001",
      toolName: "legal_case_read",
      action: "read",
      resourceType: "CASE",
      resourceId: "case_001",
      decision: "ALLOW",
      reason: "TOOL_EXECUTED",
      createdAt: NOW.toISOString(),
    });
    await repository.listByTrace({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      traceId: "trace_001",
    });

    expect(client.statements[0]).toContain("INSERT INTO gateway_trace_event");
    expect(client.values[0]?.slice(0, 4)).toEqual([
      TRACE_EVENT_ID,
      "DATA",
      "request_001",
      "trace_001",
    ]);
    expect(client.statements[1]).toContain("tenant_id = $1");
    expect(client.statements[1]).toContain("biz_domain = $2");
    expect(client.values[1]).toEqual(["tenant_A", "LEGAL", "trace_001"]);
  });

  it("provides scoped Control Plane health and Agent reads", async () => {
    const client = new RecordingPhase6Client();
    const repository = new PostgresDemoReadRepository(new RecordingPhase6Pool(client));

    await expect(repository.checkHealth()).resolves.toEqual({
      postgres: true,
      migrations: true,
    });
    await expect(
      repository.listAgents({ tenantId: "tenant_A", bizDomain: "LEGAL" }),
    ).resolves.toEqual([
      {
        tenantId: "tenant_A",
        bizDomain: "LEGAL",
        logicalAgentId: LOGICAL_AGENT_ID,
        status: L1RuntimeStatus.ACTIVE,
        currentRuntimeInstanceId: "runtime_001",
        lastActiveAt: NOW,
        capabilityProfileId: "cap_tenant_a_legal_v1",
        activeL2Count: 1,
      },
    ]);
    const agentStatementIndex = client.statements.findIndex((statement) =>
      statement.includes("FROM tenant_biz_agent AS agent"),
    );
    expect(client.statements[agentStatementIndex]).toContain("agent.tenant_id = $1");
    expect(client.statements[agentStatementIndex]).toContain("agent.biz_domain = $2");
    expect(client.values[agentStatementIndex]).toEqual(["tenant_A", "LEGAL"]);
  });
});
