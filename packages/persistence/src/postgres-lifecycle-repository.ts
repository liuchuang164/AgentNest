import { normalizeTenantBizScope } from "@agentnest/capability";
import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";

import type { PostgresClient, PostgresPool, SqlQueryResult } from "./postgres.js";

const LOGICAL_AGENT_ID = /^tb_[a-f0-9]{20}$/u;

export interface PostgresL1LifecycleRecord {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly status: L1RuntimeStatus;
  readonly lastActiveAt: Date;
}

export interface PostgresL2LifecycleRecord {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: L2TaskStatus;
  readonly lastActiveAt: Date;
}

export interface PostgresL1LifecycleIdentity {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
}

export interface PostgresL2LifecycleIdentity extends PostgresL1LifecycleIdentity {
  readonly sessionId: string;
  readonly taskId: string;
}

interface L1LifecycleRow extends Record<string, unknown> {
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly status: unknown;
  readonly last_active_at: unknown;
}

interface L2LifecycleRow extends Record<string, unknown> {
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly status: unknown;
  readonly last_active_at: unknown;
}

interface ActiveL2Row extends Record<string, unknown> {
  readonly has_active: unknown;
}

export class PostgresLifecycleRepositoryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PostgresLifecycleRepositoryError";
  }
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PostgresLifecycleRepositoryError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new PostgresLifecycleRepositoryError(`PostgreSQL returned invalid ${field}`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PostgresLifecycleRepositoryError(`PostgreSQL returned invalid ${field}`);
  }
  return date;
}

function readL1Status(value: unknown): L1RuntimeStatus {
  if (
    typeof value !== "string" ||
    !Object.values(L1RuntimeStatus).includes(value as L1RuntimeStatus)
  ) {
    throw new PostgresLifecycleRepositoryError("PostgreSQL returned invalid L1 status");
  }
  return value as L1RuntimeStatus;
}

function readL2Status(value: unknown): L2TaskStatus {
  if (typeof value !== "string" || !Object.values(L2TaskStatus).includes(value as L2TaskStatus)) {
    throw new PostgresLifecycleRepositoryError("PostgreSQL returned invalid L2 status");
  }
  return value as L2TaskStatus;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function assertIdentifier(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return normalized;
}

function assertLogicalAgentId(value: string): string {
  if (!LOGICAL_AGENT_ID.test(value)) {
    throw new TypeError("logicalAgentId must be a stable tenant/business hash ID");
  }
  return value;
}

function identityValues(input: PostgresL1LifecycleIdentity): {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
} {
  const scope = normalizeTenantBizScope(input.scope);
  return {
    tenantId: scope.tenantId,
    bizDomain: scope.bizDomain,
    logicalAgentId: assertLogicalAgentId(input.logicalAgentId),
    runtimeInstanceId: assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId"),
  };
}

function l2IdentityValues(input: PostgresL2LifecycleIdentity): {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
} {
  return {
    ...identityValues(input),
    sessionId: assertIdentifier(input.sessionId, "sessionId"),
    taskId: assertIdentifier(input.taskId, "taskId"),
  };
}

function firstRow<TRow extends Record<string, unknown>>(result: SqlQueryResult<TRow>): TRow | null {
  return result.rows[0] ?? null;
}

function requireUpdatedRow<TRow extends Record<string, unknown>>(
  result: SqlQueryResult<TRow>,
  target: string,
): TRow {
  const row = firstRow(result);
  if (row === null) {
    throw new PostgresLifecycleRepositoryError(
      `${target} is missing, outside the tenant/business scope, or not unloadable`,
    );
  }
  return row;
}

function toL1Record(row: L1LifecycleRow): PostgresL1LifecycleRecord {
  return {
    scope: {
      tenantId: readString(row.tenant_id, "tenant_id"),
      bizDomain: readString(row.biz_domain, "biz_domain"),
    },
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    status: readL1Status(row.status),
    lastActiveAt: readDate(row.last_active_at, "last_active_at"),
  };
}

function toL2Record(row: L2LifecycleRow): PostgresL2LifecycleRecord {
  return {
    scope: {
      tenantId: readString(row.tenant_id, "tenant_id"),
      bizDomain: readString(row.biz_domain, "biz_domain"),
    },
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    status: readL2Status(row.status),
    lastActiveAt: readDate(row.last_active_at, "last_active_at"),
  };
}

function assertRecordsMatchScope(
  records: readonly (PostgresL1LifecycleRecord | PostgresL2LifecycleRecord)[],
  scope: TenantBizScope,
): void {
  if (
    records.some(
      (record) =>
        record.scope.tenantId !== scope.tenantId || record.scope.bizDomain !== scope.bizDomain,
    )
  ) {
    throw new PostgresLifecycleRepositoryError(
      "PostgreSQL returned lifecycle data outside the requested tenant/business scope",
    );
  }
}

/**
 * PostgreSQL-backed lifecycle state adapter for the Demo reaper.
 *
 * WAITING_INPUT is deliberately retained as the persisted task status after an
 * L2 runtime unload. The unloaded_at marker removes it from subsequent reaper
 * scans while keeping it visible to Phase 5 restore queries as unfinished work.
 */
export class PostgresLifecycleRepository {
  public constructor(private readonly pool: PostgresPool) {}

  public async listL2LifecycleRecords(
    requestedScope: TenantBizScope,
  ): Promise<readonly PostgresL2LifecycleRecord[]> {
    const scope = normalizeTenantBizScope(requestedScope);
    return this.withClient(async (client) => {
      const result = await client.query<L2LifecycleRow>(
        `SELECT tenant_id, biz_domain, logical_agent_id, runtime_instance_id,
                session_id, task_id, status, last_active_at
           FROM agent_task
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND unloaded_at IS NULL
          ORDER BY last_active_at, logical_agent_id, task_id`,
        [scope.tenantId, scope.bizDomain],
      );
      const records = result.rows.map(toL2Record);
      assertRecordsMatchScope(records, scope);
      return records;
    });
  }

  public async listL1LifecycleRecords(
    requestedScope: TenantBizScope,
  ): Promise<readonly PostgresL1LifecycleRecord[]> {
    const scope = normalizeTenantBizScope(requestedScope);
    return this.withClient(async (client) => {
      const result = await client.query<L1LifecycleRow>(
        `SELECT agent.tenant_id, agent.biz_domain, agent.logical_agent_id,
                runtime.runtime_instance_id, agent.status,
                GREATEST(agent.last_active_at, runtime.last_active_at) AS last_active_at
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS runtime
             ON runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = agent.current_runtime_instance_id
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND runtime.unloaded_at IS NULL
          ORDER BY last_active_at, agent.logical_agent_id`,
        [scope.tenantId, scope.bizDomain],
      );
      const records = result.rows.map(toL1Record);
      assertRecordsMatchScope(records, scope);
      return records;
    });
  }

  public async hasActiveL2(input: PostgresL1LifecycleIdentity): Promise<boolean> {
    const identity = identityValues(input);
    return this.withClient(async (client) => {
      const result = await client.query<ActiveL2Row>(
        `SELECT EXISTS (
           SELECT 1
             FROM agent_task
            WHERE tenant_id = $1
              AND biz_domain = $2
              AND logical_agent_id = $3
              AND runtime_instance_id = $4
              AND unloaded_at IS NULL
              AND status IN ('QUEUED', 'SPAWNING', 'RUNNING', 'WAITING_INPUT')
         ) AS has_active`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
        ],
      );
      const row = firstRow(result);
      if (row === null || typeof row.has_active !== "boolean") {
        throw new PostgresLifecycleRepositoryError(
          "PostgreSQL did not return the active L2 result",
        );
      }
      return row.has_active;
    });
  }

  public async markL2Unloaded(
    input: PostgresL2LifecycleIdentity & { readonly unloadedAt: Date },
  ): Promise<void> {
    const identity = l2IdentityValues(input);
    const unloadedAt = assertDate(input.unloadedAt, "unloadedAt");
    await this.withClient(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE agent_task
            SET status = CASE
                           WHEN status = 'WAITING_INPUT' THEN 'WAITING_INPUT'
                           ELSE 'UNLOADED'
                         END,
                checkpointed_at = COALESCE(checkpointed_at, $7),
                unloaded_at = $7,
                last_active_at = $7,
                updated_at = $7
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND runtime_instance_id = $4
            AND session_id = $5
            AND task_id = $6
            AND unloaded_at IS NULL
            AND status IN ('WAITING_INPUT', 'COMPLETED', 'FAILED', 'CHECKPOINTED')
        RETURNING task_id`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          unloadedAt,
        ],
      );
      requireUpdatedRow(result, "L2 task");
    });
  }

  public async markL1Unloaded(
    input: PostgresL1LifecycleIdentity & { readonly unloadedAt: Date },
  ): Promise<void> {
    const identity = identityValues(input);
    const unloadedAt = assertDate(input.unloadedAt, "unloadedAt");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const runtimeResult = await client.query<Record<string, unknown>>(
        `UPDATE agent_runtime_instance AS runtime
            SET status = 'UNLOADED',
                checkpointed_at = COALESCE(runtime.checkpointed_at, $5),
                unloaded_at = $5,
                last_active_at = $5
           FROM tenant_biz_agent AS agent
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
            AND agent.current_runtime_instance_id = $4
            AND agent.status = 'IDLE'
            AND runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $4
            AND runtime.status = 'IDLE'
        RETURNING runtime.runtime_instance_id`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          unloadedAt,
        ],
      );
      requireUpdatedRow(runtimeResult, "L1 runtime");

      const logicalResult = await client.query<Record<string, unknown>>(
        `UPDATE tenant_biz_agent
            SET status = 'UNLOADED',
                last_active_at = $5,
                updated_at = $5
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND current_runtime_instance_id = $4
            AND status = 'IDLE'
        RETURNING logical_agent_id, current_runtime_instance_id`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          unloadedAt,
        ],
      );
      requireUpdatedRow(logicalResult, "logical L1 agent");
      await client.query("COMMIT");
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async withClient<TResult>(operation: (client: PostgresClient) => Promise<TResult>) {
    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}
