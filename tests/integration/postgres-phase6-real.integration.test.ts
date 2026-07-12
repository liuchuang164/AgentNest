import { readFile } from "node:fs/promises";

import {
  NodePostgresPool,
  PostgresDemoGatewayRepository,
  PostgresDemoReadRepository,
  PostgresExecutionContextRepository,
  PostgresGatewayTraceRepository,
  PostgresPhase5PersistenceRepository,
  type PostgresClient,
} from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env["AGENTNEST_TEST_DATABASE_URL"];
const scope = { tenantId: "tenant_phase6_pg", bizDomain: "LEGAL" } as const;
const logicalAgentId = `tb_${"e".repeat(20)}`;
const runtimeInstanceId = "runtime_phase6_pg_001";
const sessionId = "session_phase6_pg_001";
const taskId = "task_phase6_pg_001";
const contextId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const operationId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const traceEventId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const now = new Date("2030-01-01T00:00:00.000Z");

async function applySql(client: PostgresClient, relativePath: string): Promise<void> {
  const sql = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
  await client.query(sql);
}

async function cleanScope(client: PostgresClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("DELETE FROM gateway_trace_event WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query(
      "DELETE FROM demo_gateway_operation WHERE tenant_id = $1 AND biz_domain = $2",
      [scope.tenantId, scope.bizDomain],
    );
    await client.query("DELETE FROM execution_context WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query("DELETE FROM agent_task WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query("DELETE FROM demo_resource WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query("DELETE FROM agent_runtime_instance WHERE logical_agent_id = $1", [
      logicalAgentId,
    ]);
    await client.query("DELETE FROM tenant_biz_agent WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query(
      "DELETE FROM tenant_capability_profile WHERE tenant_id = $1 AND biz_domain = $2",
      [scope.tenantId, scope.bizDomain],
    );
    await client.query("DELETE FROM tenant_business WHERE tenant_id = $1 AND biz_domain = $2", [
      scope.tenantId,
      scope.bizDomain,
    ]);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe.skipIf(databaseUrl === undefined)("Phase 6 real PostgreSQL adapters", () => {
  it("applies migrations/seeds and persists scoped Gateway resource, side effect, and trace data", async () => {
    if (databaseUrl === undefined) {
      throw new Error("AGENTNEST_TEST_DATABASE_URL is required");
    }
    const pool = new NodePostgresPool({
      connectionString: databaseUrl,
      applicationName: "agentnest-phase6-integration",
      max: 2,
    });
    const client = await pool.connect();
    try {
      for (const migration of [
        "infra/postgres/migrations/001_phase2_tenant_registry.sql",
        "infra/postgres/migrations/002_phase4_execution_context.sql",
        "infra/postgres/migrations/003_phase5_lifecycle_persistence.sql",
        "infra/postgres/migrations/004_phase6_demo_gateway.sql",
        "infra/postgres/seeds/001_demo_scopes.sql",
        "infra/postgres/seeds/002_demo_resources.sql",
      ]) {
        await applySql(client, migration);
      }
      await cleanScope(client);
      await client.query(
        `INSERT INTO tenant_business (tenant_id, biz_domain)
         VALUES ($1, $2)`,
        [scope.tenantId, scope.bizDomain],
      );
      await client.query(
        `INSERT INTO tenant_capability_profile (
           tenant_id, biz_domain, profile_id, version, skills, tools,
           memory_scopes, lifecycle
         ) VALUES ($1, $2, $3, 1, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)`,
        [
          scope.tenantId,
          scope.bizDomain,
          "cap_phase6_pg_v1",
          '["legal-evidence-check"]',
          '{"legal_case_read":["read"]}',
          '["TENANT_BIZ_MEMORY"]',
          '{"l1_idle_ttl_seconds":86400,"l2_idle_ttl_seconds":3600}',
        ],
      );
      await client.query(
        `INSERT INTO tenant_biz_agent (
           tenant_id, biz_domain, logical_agent_id, capability_profile_id,
           status, current_runtime_instance_id, last_active_at
         ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6)`,
        [
          scope.tenantId,
          scope.bizDomain,
          logicalAgentId,
          "cap_phase6_pg_v1",
          runtimeInstanceId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO agent_runtime_instance (
           logical_agent_id, runtime_instance_id, openclaw_agent_id,
           status, started_at, last_active_at
         ) VALUES ($1, $2, $3, 'ACTIVE', $4, $4)`,
        [logicalAgentId, runtimeInstanceId, logicalAgentId, now],
      );
      await client.query(
        `INSERT INTO agent_task (
           tenant_id, biz_domain, task_id, logical_agent_id,
           runtime_instance_id, session_id, task_type, status,
           input_json, last_active_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'LEGAL_EVIDENCE_CHECK',
                   'RUNNING', '{}'::jsonb, $7)`,
        [
          scope.tenantId,
          scope.bizDomain,
          taskId,
          logicalAgentId,
          runtimeInstanceId,
          sessionId,
          now,
        ],
      );
      await client.query(
        `INSERT INTO demo_resource (
           tenant_id, biz_domain, resource_type, resource_id, payload_json
         ) VALUES ($1, $2, 'CASE', 'case_001', $3::jsonb)`,
        [
          scope.tenantId,
          scope.bizDomain,
          '{"title":"Phase 6 PostgreSQL case","facts":["real-pg"]}',
        ],
      );

      const contextRepository = new PostgresExecutionContextRepository(pool, {
        createId: () => contextId,
      });
      await contextRepository.create({
        scope,
        logicalAgentId,
        runtimeInstanceId,
        sessionId,
        taskId,
        allowedSkills: ["legal-evidence-check"],
        allowedTools: { legal_case_read: ["read"] },
        resourceScope: { resourceType: "CASE", resourceIds: ["case_001"] },
        expiresAt: new Date("2030-01-01T01:00:00.000Z"),
        now,
      });

      const gatewayRepository = new PostgresDemoGatewayRepository(pool, {
        createId: () => operationId,
      });
      await expect(
        gatewayRepository.ownsResource(scope.tenantId, scope.bizDomain, "CASE", "case_001"),
      ).resolves.toBe(true);
      await expect(
        gatewayRepository.ownsResource("tenant_A", "LEGAL", "CASE", "case_phase6_only"),
      ).resolves.toBe(false);
      await expect(
        gatewayRepository.executeDataOperation({
          requestId: "request_phase6_pg_001",
          traceId: "trace_phase6_pg_001",
          executionContextId: contextId,
          tenantId: scope.tenantId,
          bizDomain: scope.bizDomain,
          logicalAgentId,
          runtimeInstanceId,
          sessionId,
          taskId,
          toolName: "legal_case_read",
          action: "read",
          resourceType: "CASE",
          resourceId: "case_001",
          params: {},
          now,
        }),
      ).resolves.toEqual({
        resource_id: "case_001",
        title: "Phase 6 PostgreSQL case",
        facts: ["real-pg"],
      });
      await expect(gatewayRepository.listOperations({ scope, taskId })).resolves.toHaveLength(1);

      const traceRepository = new PostgresGatewayTraceRepository(pool, {
        gatewayName: "DATA",
        createId: () => traceEventId,
      });
      await traceRepository.append({
        requestId: "request_phase6_pg_001",
        traceId: "trace_phase6_pg_001",
        executionContextId: contextId,
        tenantId: scope.tenantId,
        bizDomain: scope.bizDomain,
        logicalAgentId,
        runtimeInstanceId,
        sessionId,
        taskId,
        toolName: "legal_case_read",
        action: "read",
        resourceType: "CASE",
        resourceId: "case_001",
        decision: "ALLOW",
        reason: "TOOL_EXECUTED",
        createdAt: now.toISOString(),
      });
      await expect(
        traceRepository.listByTrace({ scope, traceId: "trace_phase6_pg_001" }),
      ).resolves.toMatchObject([{ tenantId: scope.tenantId, decision: "ALLOW" }]);
      await expect(new PostgresDemoReadRepository(pool).checkHealth()).resolves.toEqual({
        postgres: true,
        migrations: true,
      });

      const correctPreviousRuntimeId = "runtime_phase6_pg_parent";
      const currentRestoredRuntimeId = "runtime_phase6_pg_restored";
      await client.query(
        `UPDATE agent_runtime_instance
            SET status = 'UNLOADED',
                started_at = '2040-01-01T00:00:00.000Z',
                last_active_at = '2040-01-01T00:00:00.000Z',
                unloaded_at = '2040-01-01T00:00:00.000Z'
          WHERE logical_agent_id = $1
            AND runtime_instance_id = $2`,
        [logicalAgentId, runtimeInstanceId],
      );
      await client.query(
        `INSERT INTO agent_runtime_instance (
           logical_agent_id, runtime_instance_id, openclaw_agent_id,
           status, started_at, last_active_at, unloaded_at
         ) VALUES ($1, $2, $1, 'UNLOADED', $3, $3, $3)`,
        [logicalAgentId, correctPreviousRuntimeId, new Date("2030-01-01T00:00:01.000Z")],
      );
      await client.query(
        `UPDATE tenant_biz_agent
            SET status = 'UNLOADED', current_runtime_instance_id = $3
          WHERE tenant_id = $1 AND biz_domain = $2`,
        [scope.tenantId, scope.bizDomain, correctPreviousRuntimeId],
      );
      const unloadedBundle = await new PostgresPhase5PersistenceRepository(pool).loadRestoreBundle({
        scope,
        logicalAgentId,
      });
      expect(unloadedBundle.previousRuntimeInstanceId).toBe(correctPreviousRuntimeId);

      await client.query(
        `INSERT INTO agent_runtime_instance (
           logical_agent_id, runtime_instance_id, openclaw_agent_id,
           status, started_at, last_active_at, restored_from_runtime_instance_id
         ) VALUES ($1, $2, $1, 'PROVISIONING', $3, $3, $4)`,
        [
          logicalAgentId,
          currentRestoredRuntimeId,
          new Date("2029-01-01T00:00:00.000Z"),
          correctPreviousRuntimeId,
        ],
      );
      await client.query(
        `UPDATE tenant_biz_agent
            SET status = 'PROVISIONING', current_runtime_instance_id = $3
          WHERE tenant_id = $1 AND biz_domain = $2`,
        [scope.tenantId, scope.bizDomain, currentRestoredRuntimeId],
      );
      const restoreBundle = await new PostgresPhase5PersistenceRepository(pool).loadRestoreBundle({
        scope,
        logicalAgentId,
      });
      expect(restoreBundle.previousRuntimeInstanceId).toBe(correctPreviousRuntimeId);
    } finally {
      try {
        await cleanScope(client);
      } finally {
        client.release();
        await pool.end();
      }
    }
  });
});
