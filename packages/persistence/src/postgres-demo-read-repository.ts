import { normalizeTenantBizScope } from "@agentnest/capability";
import { L1RuntimeStatus, type TenantBizScope } from "@agentnest/contracts";

import {
  PostgresPhase5PersistenceRepository,
  type FindScopedRecordsInput,
  type FindTaskStateInput,
  type MemoryRecord,
  type TaskStateRecord,
} from "./phase5-persistence-repository.js";
import type { PostgresPool, SqlQueryResult } from "./postgres.js";

export interface AgentReadRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly status: L1RuntimeStatus;
  readonly currentRuntimeInstanceId: string | null;
  readonly lastActiveAt: Date;
  readonly capabilityProfileId: string;
  readonly activeL2Count: number;
}

export interface DemoDatabaseHealth {
  readonly postgres: boolean;
  readonly migrations: boolean;
}

export interface FindAgentReadInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
}

interface AgentReadRow extends Record<string, unknown> {
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly status: unknown;
  readonly current_runtime_instance_id: unknown;
  readonly last_active_at: unknown;
  readonly capability_profile_id: unknown;
  readonly active_l2_count: unknown;
}

interface HealthRow extends Record<string, unknown> {
  readonly healthy: unknown;
}

interface MigrationRow extends Record<string, unknown> {
  readonly tenant_biz_agent: unknown;
  readonly execution_context: unknown;
  readonly agent_task: unknown;
  readonly demo_resource: unknown;
  readonly demo_gateway_operation: unknown;
  readonly gateway_trace_event: unknown;
}

function assertLogicalAgentId(value: string): string {
  const normalized = value.trim();
  if (!/^tb_[a-f0-9]{20}$/u.test(normalized)) {
    throw new TypeError("logicalAgentId must be a stable tenant/business hash ID");
  }
  return normalized;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  return parsed;
}

function readStatus(value: unknown): L1RuntimeStatus {
  const status = readString(value, "status");
  if (!Object.values<string>(L1RuntimeStatus).includes(status)) {
    throw new TypeError("PostgreSQL returned invalid status");
  }
  return status as L1RuntimeStatus;
}

function readCount(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("PostgreSQL returned invalid active_l2_count");
  }
  return count;
}

function toAgentReadRecord(row: AgentReadRow): AgentReadRecord {
  return {
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    status: readStatus(row.status),
    currentRuntimeInstanceId:
      row.current_runtime_instance_id === null
        ? null
        : readString(row.current_runtime_instance_id, "current_runtime_instance_id"),
    lastActiveAt: readDate(row.last_active_at, "last_active_at"),
    capabilityProfileId: readString(row.capability_profile_id, "capability_profile_id"),
    activeL2Count: readCount(row.active_l2_count),
  };
}

const AGENT_READ_SELECT = `SELECT agent.tenant_id, agent.biz_domain, agent.logical_agent_id,
       agent.status, agent.current_runtime_instance_id, agent.last_active_at,
       agent.capability_profile_id,
       COUNT(task.task_id) FILTER (
         WHERE task.status IN ('SPAWNING', 'RUNNING', 'WAITING_INPUT')
           AND task.unloaded_at IS NULL
       )::integer AS active_l2_count
  FROM tenant_biz_agent AS agent
  LEFT JOIN agent_task AS task
    ON task.tenant_id = agent.tenant_id
   AND task.biz_domain = agent.biz_domain
   AND task.logical_agent_id = agent.logical_agent_id`;

function firstOrNull<TRow extends Record<string, unknown>>(
  result: SqlQueryResult<TRow>,
): TRow | null {
  return result.rows[0] ?? null;
}

export class PostgresDemoReadRepository {
  readonly #phase5: PostgresPhase5PersistenceRepository;

  public constructor(private readonly pool: PostgresPool) {
    this.#phase5 = new PostgresPhase5PersistenceRepository(pool);
  }

  public async checkHealth(): Promise<DemoDatabaseHealth> {
    let client;
    try {
      client = await this.pool.connect();
      const health = await client.query<HealthRow>("SELECT 1 AS healthy");
      const postgres = health.rows[0]?.healthy === 1;
      if (!postgres) {
        return { postgres: false, migrations: false };
      }
      const migration = await client.query<MigrationRow>(
        `SELECT
           to_regclass('public.tenant_biz_agent') AS tenant_biz_agent,
           to_regclass('public.execution_context') AS execution_context,
           to_regclass('public.agent_task') AS agent_task,
           to_regclass('public.demo_resource') AS demo_resource,
           to_regclass('public.demo_gateway_operation') AS demo_gateway_operation,
           to_regclass('public.gateway_trace_event') AS gateway_trace_event`,
      );
      const row = migration.rows[0];
      const migrations =
        row !== undefined &&
        row.tenant_biz_agent !== null &&
        row.execution_context !== null &&
        row.agent_task !== null &&
        row.demo_resource !== null &&
        row.demo_gateway_operation !== null &&
        row.gateway_trace_event !== null;
      return { postgres: true, migrations };
    } catch {
      return { postgres: false, migrations: false };
    } finally {
      client?.release();
    }
  }

  public async findTask(input: FindTaskStateInput): Promise<TaskStateRecord | null> {
    return this.#phase5.findTaskState(input);
  }

  public async listAgents(scopeInput: TenantBizScope): Promise<readonly AgentReadRecord[]> {
    const scope = normalizeTenantBizScope(scopeInput);
    const client = await this.pool.connect();
    try {
      const result = await client.query<AgentReadRow>(
        `${AGENT_READ_SELECT}
         WHERE agent.tenant_id = $1
           AND agent.biz_domain = $2
         GROUP BY agent.tenant_id, agent.biz_domain, agent.logical_agent_id,
                  agent.status, agent.current_runtime_instance_id, agent.last_active_at,
                  agent.capability_profile_id
         ORDER BY agent.logical_agent_id`,
        [scope.tenantId, scope.bizDomain],
      );
      return result.rows.map(toAgentReadRecord);
    } finally {
      client.release();
    }
  }

  public async findAgent(input: FindAgentReadInput): Promise<AgentReadRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const client = await this.pool.connect();
    try {
      const result = await client.query<AgentReadRow>(
        `${AGENT_READ_SELECT}
         WHERE agent.tenant_id = $1
           AND agent.biz_domain = $2
           AND agent.logical_agent_id = $3
         GROUP BY agent.tenant_id, agent.biz_domain, agent.logical_agent_id,
                  agent.status, agent.current_runtime_instance_id, agent.last_active_at,
                  agent.capability_profile_id
         LIMIT 1`,
        [scope.tenantId, scope.bizDomain, logicalAgentId],
      );
      const row = firstOrNull(result);
      return row === null ? null : toAgentReadRecord(row);
    } finally {
      client.release();
    }
  }

  public listMemories(input: FindScopedRecordsInput): Promise<readonly MemoryRecord[]> {
    return this.#phase5.listMemories(input);
  }
}
