import { normalizeTenantBizScope } from "@agentnest/capability";
import { L1RuntimeStatus } from "@agentnest/contracts";

import type {
  EnsureActiveRuntimeInput,
  EnsureActiveRuntimeResult,
  LogicalAgentRecord,
  MarkRuntimeReadyInput,
  RuntimeInstanceRecord,
  TenantRuntimeLifecycleRepository,
} from "./runtime-repository.js";

export interface SqlQueryResult<TRow extends Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount: number | null;
}

export interface PostgresClient {
  query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>>;
  release(): void;
}

export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

interface LogicalAgentRow extends Record<string, unknown> {
  readonly logical_agent_id: string;
  readonly tenant_id: string;
  readonly biz_domain: string;
  readonly capability_profile_id: string;
  readonly status: string;
  readonly current_runtime_instance_id: string | null;
  readonly last_active_at: Date | string;
}

interface RuntimeInstanceRow extends Record<string, unknown> {
  readonly runtime_instance_id: string;
  readonly logical_agent_id: string;
  readonly openclaw_agent_id: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly last_active_at: Date | string;
  readonly restored_from_runtime_instance_id: string | null;
}

function readDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("PostgreSQL returned an invalid timestamp");
  }
  return date;
}

function readL1Status(value: string): L1RuntimeStatus {
  const knownStatuses = new Set<string>(Object.values(L1RuntimeStatus));
  if (!knownStatuses.has(value)) {
    throw new TypeError(`PostgreSQL returned an invalid L1 status: ${value}`);
  }
  return value as L1RuntimeStatus;
}

function toLogicalAgent(row: LogicalAgentRow): LogicalAgentRecord {
  return {
    logicalAgentId: row.logical_agent_id,
    tenantId: row.tenant_id,
    bizDomain: row.biz_domain,
    capabilityProfileId: row.capability_profile_id,
    status: readL1Status(row.status),
    currentRuntimeInstanceId: row.current_runtime_instance_id,
    lastActiveAt: readDate(row.last_active_at),
  };
}

function toRuntime(row: RuntimeInstanceRow): RuntimeInstanceRecord {
  return {
    runtimeInstanceId: row.runtime_instance_id,
    logicalAgentId: row.logical_agent_id,
    openclawAgentId: row.openclaw_agent_id,
    status: readL1Status(row.status),
    startedAt: readDate(row.started_at),
    lastActiveAt: readDate(row.last_active_at),
    restoredFromRuntimeInstanceId: row.restored_from_runtime_instance_id,
  };
}

function firstRow<TRow extends Record<string, unknown>>(
  result: SqlQueryResult<TRow>,
  description: string,
): TRow {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`PostgreSQL did not return ${description}`);
  }
  return row;
}

export class PostgresTenantRuntimeRepository implements TenantRuntimeLifecycleRepository {
  public constructor(private readonly pool: PostgresPool) {}

  public async ensureActiveRuntime(
    input: EnsureActiveRuntimeInput,
  ): Promise<EnsureActiveRuntimeResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        input.logicalAgentId,
      ]);

      const logicalResult = await client.query<LogicalAgentRow>(
        `INSERT INTO tenant_biz_agent (
           logical_agent_id, tenant_id, biz_domain, capability_profile_id, status,
           current_runtime_instance_id, last_active_at
         ) VALUES ($1, $2, $3, $4, 'PROVISIONING', NULL, $5)
         ON CONFLICT (tenant_id, biz_domain) DO UPDATE
           SET capability_profile_id = EXCLUDED.capability_profile_id,
               updated_at = now()
         RETURNING logical_agent_id, tenant_id, biz_domain, capability_profile_id,
                   status, current_runtime_instance_id, last_active_at`,
        [
          input.logicalAgentId,
          input.scope.tenantId,
          input.scope.bizDomain,
          input.capabilityProfileId,
          input.now,
        ],
      );
      const logicalAgent = toLogicalAgent(firstRow(logicalResult, "the logical agent"));
      if (logicalAgent.logicalAgentId !== input.logicalAgentId) {
        throw new Error("tenant/biz scope is already bound to a different logical_agent_id");
      }

      const activeResult = await client.query<RuntimeInstanceRow>(
        `SELECT runtime_instance_id, logical_agent_id, openclaw_agent_id, status,
                started_at, last_active_at, restored_from_runtime_instance_id
           FROM agent_runtime_instance
          WHERE logical_agent_id = $1
            AND status IN ('PROVISIONING', 'ACTIVE', 'IDLE')
          ORDER BY started_at DESC
          LIMIT 1
          FOR UPDATE`,
        [input.logicalAgentId],
      );
      const activeRow = activeResult.rows[0];
      if (activeRow !== undefined) {
        await client.query("COMMIT");
        return { logicalAgent, runtime: toRuntime(activeRow), reused: true };
      }

      const previousRuntimeId = logicalAgent.currentRuntimeInstanceId;
      const runtimeResult = await client.query<RuntimeInstanceRow>(
        `INSERT INTO agent_runtime_instance (
           runtime_instance_id, logical_agent_id, openclaw_agent_id, status,
           started_at, last_active_at, restored_from_runtime_instance_id
         ) VALUES ($1, $2, $3, 'PROVISIONING', $4, $4, $5)
         RETURNING runtime_instance_id, logical_agent_id, openclaw_agent_id, status,
                   started_at, last_active_at, restored_from_runtime_instance_id`,
        [
          input.candidateRuntimeInstanceId,
          input.logicalAgentId,
          input.openclawAgentId,
          input.now,
          previousRuntimeId,
        ],
      );
      const runtime = toRuntime(firstRow(runtimeResult, "the runtime instance"));
      const updatedLogicalResult = await client.query<LogicalAgentRow>(
        `UPDATE tenant_biz_agent
            SET status = 'PROVISIONING', current_runtime_instance_id = $2,
                last_active_at = $3, updated_at = now()
          WHERE logical_agent_id = $1
        RETURNING logical_agent_id, tenant_id, biz_domain, capability_profile_id,
                  status, current_runtime_instance_id, last_active_at`,
        [input.logicalAgentId, runtime.runtimeInstanceId, input.now],
      );
      await client.query("COMMIT");
      return {
        logicalAgent: toLogicalAgent(firstRow(updatedLogicalResult, "the updated logical agent")),
        runtime,
        reused: false,
      };
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async markRuntimeReady(input: MarkRuntimeReadyInput): Promise<void> {
    const scope = normalizeTenantBizScope(input.scope);
    if (![L1RuntimeStatus.ACTIVE, L1RuntimeStatus.IDLE].includes(input.status)) {
      throw new TypeError("ready runtime status must be ACTIVE or IDLE");
    }
    if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) {
      throw new TypeError("now must be a valid Date");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runtimeResult = await client.query<Record<string, unknown>>(
        `UPDATE agent_runtime_instance AS runtime
            SET status = $5,
                last_active_at = $6,
                failure_reason = NULL
           FROM tenant_biz_agent AS agent
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
            AND agent.current_runtime_instance_id = $4
            AND runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $4
            AND runtime.status IN ('PROVISIONING', 'ACTIVE', 'IDLE')
        RETURNING runtime.runtime_instance_id`,
        [
          scope.tenantId,
          scope.bizDomain,
          input.logicalAgentId,
          input.runtimeInstanceId,
          input.status,
          input.now,
        ],
      );
      firstRow(runtimeResult, "the ready runtime instance");
      const logicalResult = await client.query<Record<string, unknown>>(
        `UPDATE tenant_biz_agent
            SET status = $5,
                last_active_at = $6,
                updated_at = $6
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND current_runtime_instance_id = $4
            AND status IN ('PROVISIONING', 'ACTIVE', 'IDLE')
        RETURNING logical_agent_id`,
        [
          scope.tenantId,
          scope.bizDomain,
          input.logicalAgentId,
          input.runtimeInstanceId,
          input.status,
          input.now,
        ],
      );
      firstRow(logicalResult, "the ready logical agent");
      await client.query("COMMIT");
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
