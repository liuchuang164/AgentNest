import {
  ExecutionContextDenyReason,
  ExecutionContextScopeError,
  PostgresExecutionContextRepository,
  authorizeExecutionContext,
  type PostgresClient,
  type PostgresPool,
  type SqlQueryResult,
} from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

const CONTEXT_ID = "0f7e6c1a-9e75-45da-bae7-1d6235f8fd94";
const LOGICAL_AGENT_ID = "tb_aaaaaaaaaaaaaaaaaaaa";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const EXPIRES_AT = new Date("2030-01-01T01:00:00.000Z");

function requiredValue(values: readonly unknown[] | undefined, index: number): unknown {
  const value = values?.[index];
  if (value === undefined) {
    throw new TypeError(`missing SQL value at index ${String(index)}`);
  }
  return value;
}

function requiredString(values: readonly unknown[] | undefined, index: number): string {
  const value = requiredValue(values, index);
  if (typeof value !== "string") {
    throw new TypeError(`SQL value at index ${String(index)} is not a string`);
  }
  return value;
}

function requiredDate(values: readonly unknown[] | undefined, index: number): Date {
  const value = requiredValue(values, index);
  if (!(value instanceof Date)) {
    throw new TypeError(`SQL value at index ${String(index)} is not a Date`);
  }
  return value;
}

function parseJsonValue(values: readonly unknown[] | undefined, index: number): unknown {
  return JSON.parse(requiredString(values, index)) as unknown;
}

function authoritativeRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    execution_context_id: CONTEXT_ID,
    tenant_id: "tenant_A",
    biz_domain: "LEGAL",
    logical_agent_id: LOGICAL_AGENT_ID,
    runtime_instance_id: "ari_01",
    session_id: "session_01",
    task_id: "task_01",
    allowed_skills: ["legal-evidence-check"],
    allowed_tools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
    },
    resource_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
    expires_at: EXPIRES_AT,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

class RecordingExecutionContextClient implements PostgresClient {
  public readonly statements: string[] = [];
  public readonly values: (readonly unknown[] | undefined)[] = [];
  public releaseCount = 0;
  public allowCreate = true;
  public row: Record<string, unknown> | null = null;

  public query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    this.statements.push(text.replaceAll(/\s+/gu, " ").trim());
    this.values.push(values);
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("INSERT INTO execution_context")) {
      if (this.allowCreate) {
        this.row = {
          execution_context_id: requiredString(values, 0),
          tenant_id: requiredString(values, 1),
          biz_domain: requiredString(values, 2),
          logical_agent_id: requiredString(values, 3),
          runtime_instance_id: requiredString(values, 4),
          session_id: requiredString(values, 5),
          task_id: requiredString(values, 6),
          allowed_skills: parseJsonValue(values, 7),
          allowed_tools: parseJsonValue(values, 8),
          resource_scope: parseJsonValue(values, 9),
          expires_at: requiredDate(values, 10),
          created_at: requiredDate(values, 11),
          updated_at: requiredDate(values, 11),
        };
        rows = [this.row];
      }
    } else if (text.includes("FROM execution_context")) {
      const requestedId = requiredString(values, 0);
      const isGatewayLookup = !text.includes("tenant_id = $2");
      const scopeMatches =
        isGatewayLookup ||
        (this.row?.["tenant_id"] === requiredString(values, 1) &&
          this.row["biz_domain"] === requiredString(values, 2));
      if (this.row?.["execution_context_id"] === requestedId && scopeMatches) {
        rows = [this.row];
      }
    }
    return Promise.resolve({ rows: rows as readonly TRow[], rowCount: rows.length });
  }

  public release(): void {
    this.releaseCount += 1;
  }
}

class RecordingExecutionContextPool implements PostgresPool {
  public connectCount = 0;

  public constructor(public readonly client: RecordingExecutionContextClient) {}

  public connect(): Promise<PostgresClient> {
    this.connectCount += 1;
    return Promise.resolve(this.client);
  }
}

function createInput() {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "ari_01",
    sessionId: "session_01",
    taskId: "task_01",
    allowedSkills: ["legal-evidence-check"],
    allowedTools: {
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
    },
    resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
    expiresAt: EXPIRES_AT,
    now: NOW,
  } as const;
}

function authorizationInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    executionContextId: CONTEXT_ID,
    toolName: "legal_case_read",
    action: "read",
    resourceType: "CASE",
    resourceId: "case_001",
    now: new Date("2030-01-01T00:30:00.000Z"),
    ...overrides,
  } as const;
}

describe("PostgresExecutionContextRepository", () => {
  it("creates a server-authoritative UUID context only through the matching tenant/runtime scope", async () => {
    const client = new RecordingExecutionContextClient();
    const pool = new RecordingExecutionContextPool(client);
    const repository = new PostgresExecutionContextRepository(pool, {
      createId: () => CONTEXT_ID,
    });

    const created = await repository.create(createInput());

    expect(created).toMatchObject({
      executionContextId: CONTEXT_ID,
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_01",
      allowedSkills: ["legal-evidence-check"],
      allowedTools: { legal_case_read: ["read"], legal_analysis_write: ["write"] },
      resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
    });
    expect(client.statements[0]).toContain("JOIN agent_runtime_instance AS runtime");
    expect(client.statements[0]).toContain("WHERE agent.tenant_id = $2");
    expect(client.statements[0]).toContain("AND agent.biz_domain = $3");
    expect(client.statements[0]).toContain("AND agent.logical_agent_id = $4");
    expect(client.releaseCount).toBe(1);
  });

  it("rejects creation when PostgreSQL cannot match logical agent/runtime to the scope", async () => {
    const client = new RecordingExecutionContextClient();
    client.allowCreate = false;
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
      { createId: () => CONTEXT_ID },
    );

    await expect(repository.create(createInput())).rejects.toBeInstanceOf(
      ExecutionContextScopeError,
    );
    expect(client.releaseCount).toBe(1);
  });

  it("requires tenant_id and biz_domain in the SQL lookup and never falls back by UUID", async () => {
    const client = new RecordingExecutionContextClient();
    client.row = authoritativeRow();
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    const found = await repository.findById({
      scope: { tenantId: "tenant_B", bizDomain: "LEGAL" },
      executionContextId: CONTEXT_ID,
    });

    expect(found).toBeNull();
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toContain("execution_context_id = $1::uuid");
    expect(client.statements[0]).toContain("tenant_id = $2");
    expect(client.statements[0]).toContain("biz_domain = $3");
    expect(client.values[0]).toEqual([CONTEXT_ID, "tenant_B", "LEGAL"]);
  });

  it("lets the private Gateway resolve the UUID and treats the stored scope as authoritative", async () => {
    const client = new RecordingExecutionContextClient();
    client.row = authoritativeRow({ tenant_id: "tenant_B" });
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    const found = await repository.findByGatewayId(CONTEXT_ID);

    expect(found).toMatchObject({
      executionContextId: CONTEXT_ID,
      tenantId: "tenant_B",
      bizDomain: "LEGAL",
    });
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]).toContain("execution_context_id = $1::uuid");
    expect(client.statements[0]).not.toContain("tenant_id = $2");
    expect(client.values[0]).toEqual([CONTEXT_ID]);
  });

  it("authorizes only the stored tool, action, and resource scope before expiry", async () => {
    const client = new RecordingExecutionContextClient();
    client.row = authoritativeRow();
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    const authorization = await repository.authorize(authorizationInput());

    expect(authorization).toMatchObject({
      allowed: true,
      context: { executionContextId: CONTEXT_ID, tenantId: "tenant_A", bizDomain: "LEGAL" },
    });
  });

  it("denies an unknown context without a second unscoped lookup", async () => {
    const client = new RecordingExecutionContextClient();
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    await expect(repository.authorize(authorizationInput())).resolves.toEqual({
      allowed: false,
      reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND,
    });
    expect(client.statements).toHaveLength(1);
  });

  it("the pure authorization primitive also rejects a context from another tenant scope", () => {
    const context = {
      executionContextId: CONTEXT_ID,
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_01",
      sessionId: "session_01",
      taskId: "task_01",
      allowedSkills: ["legal-evidence-check"],
      allowedTools: { legal_case_read: ["read"] },
      resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
      expiresAt: EXPIRES_AT,
      createdAt: NOW,
      updatedAt: NOW,
    } as const;

    expect(
      authorizeExecutionContext(context, {
        ...authorizationInput(),
        scope: { tenantId: "tenant_B", bizDomain: "LEGAL" },
      }),
    ).toEqual({
      allowed: false,
      reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND,
    });
  });

  it.each([
    {
      label: "expired context",
      override: { now: EXPIRES_AT },
      reason: ExecutionContextDenyReason.CONTEXT_EXPIRED,
    },
    {
      label: "unknown tool",
      override: { toolName: "robot_device_read" },
      reason: ExecutionContextDenyReason.TOOL_NOT_ALLOWED,
    },
    {
      label: "unknown action",
      override: { action: "write" },
      reason: ExecutionContextDenyReason.ACTION_NOT_ALLOWED,
    },
    {
      label: "wrong resource type",
      override: { resourceType: "DEVICE" },
      reason: ExecutionContextDenyReason.RESOURCE_TYPE_NOT_ALLOWED,
    },
    {
      label: "resource outside scope",
      override: { resourceId: "case_002" },
      reason: ExecutionContextDenyReason.RESOURCE_NOT_ALLOWED,
    },
  ])("denies $label", async ({ override, reason }) => {
    const client = new RecordingExecutionContextClient();
    client.row = authoritativeRow();
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    await expect(repository.authorize(authorizationInput(override))).resolves.toEqual({
      allowed: false,
      reason,
    });
  });

  it("rejects invalid generated IDs and already-expired input before opening PostgreSQL", async () => {
    const invalidIdPool = new RecordingExecutionContextPool(new RecordingExecutionContextClient());
    const invalidIdRepository = new PostgresExecutionContextRepository(invalidIdPool, {
      createId: () => "not-a-uuid",
    });
    await expect(invalidIdRepository.create(createInput())).rejects.toThrow(
      "execution_context_id must be a UUID",
    );
    expect(invalidIdPool.connectCount).toBe(0);

    const expiredPool = new RecordingExecutionContextPool(new RecordingExecutionContextClient());
    const expiredRepository = new PostgresExecutionContextRepository(expiredPool);
    await expect(expiredRepository.create({ ...createInput(), expiresAt: NOW })).rejects.toThrow(
      "expiresAt must be later than now",
    );
    expect(expiredPool.connectCount).toBe(0);
  });

  it("fails closed on malformed authority data returned by PostgreSQL", async () => {
    const client = new RecordingExecutionContextClient();
    client.row = authoritativeRow({
      allowed_tools: { legal_case_read: ["read"], robot_device_read: ["READ"] },
    });
    const repository = new PostgresExecutionContextRepository(
      new RecordingExecutionContextPool(client),
    );

    await expect(repository.authorize(authorizationInput())).rejects.toThrow(
      "invalid actions for robot_device_read",
    );
  });
});
