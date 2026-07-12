import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import type { LifecycleRepository } from "../../apps/control-plane/src/application/lifecycle-reaper.js";
import {
  PostgresLifecycleRepository,
  PostgresLifecycleRepositoryError,
} from "../../packages/persistence/src/postgres-lifecycle-repository.js";
import { PostgresPhase5PersistenceRepository } from "../../packages/persistence/src/phase5-persistence-repository.js";
import type {
  PostgresClient,
  PostgresPool,
  SqlQueryResult,
} from "../../packages/persistence/src/postgres.js";

const SCOPE = { tenantId: "tenant_A", bizDomain: "LEGAL" } as const satisfies TenantBizScope;
const OTHER_SCOPE = {
  tenantId: "tenant_B",
  bizDomain: "LEGAL",
} as const satisfies TenantBizScope;
const LOGICAL_AGENT_ID = "tb_11111111111111111111";
const RUNTIME_INSTANCE_ID = "ari_previous";
const SESSION_ID = "session_previous";
const TASK_ID = "task_001";
const LAST_ACTIVE_AT = new Date("2030-01-01T00:00:00.000Z");
const UNLOADED_AT = new Date("2030-01-02T00:00:00.000Z");

interface RecordedStatement {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface MutableL1State {
  tenantId: string;
  bizDomain: string;
  logicalAgentId: string;
  runtimeInstanceId: string;
  logicalStatus: L1RuntimeStatus;
  runtimeStatus: L1RuntimeStatus;
  lastActiveAt: Date;
  checkpointedAt: Date | null;
  unloadedAt: Date | null;
}

interface MutableTaskState {
  tenantId: string;
  bizDomain: string;
  logicalAgentId: string;
  runtimeInstanceId: string;
  sessionId: string;
  taskId: string;
  taskType: string;
  status: L2TaskStatus;
  currentStep: string | null;
  input: Readonly<Record<string, unknown>>;
  result: Readonly<Record<string, unknown>> | null;
  lastActiveAt: Date;
  checkpointedAt: Date | null;
  unloadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RecordingClientOptions {
  readonly l1Status?: L1RuntimeStatus;
  readonly taskStatus?: L2TaskStatus;
}

function requiredString(values: readonly unknown[] | undefined, index: number): string {
  const value = values?.[index];
  if (typeof value !== "string") {
    throw new TypeError(`SQL value ${String(index)} must be a string`);
  }
  return value;
}

function requiredDate(values: readonly unknown[] | undefined, index: number): Date {
  const value = values?.[index];
  if (!(value instanceof Date)) {
    throw new TypeError(`SQL value ${String(index)} must be a Date`);
  }
  return new Date(value.getTime());
}

function cloneL1(state: MutableL1State): MutableL1State {
  return {
    ...state,
    lastActiveAt: new Date(state.lastActiveAt.getTime()),
    checkpointedAt: state.checkpointedAt === null ? null : new Date(state.checkpointedAt.getTime()),
    unloadedAt: state.unloadedAt === null ? null : new Date(state.unloadedAt.getTime()),
  };
}

function cloneTask(state: MutableTaskState): MutableTaskState {
  return {
    ...state,
    input: structuredClone(state.input),
    result: state.result === null ? null : structuredClone(state.result),
    lastActiveAt: new Date(state.lastActiveAt.getTime()),
    checkpointedAt: state.checkpointedAt === null ? null : new Date(state.checkpointedAt.getTime()),
    unloadedAt: state.unloadedAt === null ? null : new Date(state.unloadedAt.getTime()),
    createdAt: new Date(state.createdAt.getTime()),
    updatedAt: new Date(state.updatedAt.getTime()),
  };
}

function taskRow(task: MutableTaskState): Record<string, unknown> {
  return {
    tenant_id: task.tenantId,
    biz_domain: task.bizDomain,
    logical_agent_id: task.logicalAgentId,
    runtime_instance_id: task.runtimeInstanceId,
    session_id: task.sessionId,
    task_id: task.taskId,
    task_type: task.taskType,
    status: task.status,
    current_step: task.currentStep,
    input_json: task.input,
    result_json: task.result,
    last_active_at: task.lastActiveAt,
    checkpointed_at: task.checkpointedAt,
    unloaded_at: task.unloadedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

function identityMatchesTask(task: MutableTaskState, values: readonly unknown[] | undefined) {
  return (
    task.tenantId === requiredString(values, 0) &&
    task.bizDomain === requiredString(values, 1) &&
    task.logicalAgentId === requiredString(values, 2) &&
    task.runtimeInstanceId === requiredString(values, 3) &&
    task.sessionId === requiredString(values, 4) &&
    task.taskId === requiredString(values, 5)
  );
}

class RecordingLifecycleClient implements PostgresClient {
  public readonly statements: RecordedStatement[] = [];
  public releaseCount = 0;
  public failLogicalAgentUpdate = false;
  public l1: MutableL1State;
  public task: MutableTaskState;
  #transactionSnapshot: { l1: MutableL1State; task: MutableTaskState } | null = null;

  public constructor(options: RecordingClientOptions = {}) {
    const l1Status = options.l1Status ?? L1RuntimeStatus.IDLE;
    this.l1 = {
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      logicalStatus: l1Status,
      runtimeStatus: l1Status,
      lastActiveAt: new Date(LAST_ACTIVE_AT.getTime()),
      checkpointedAt: null,
      unloadedAt: null,
    };
    this.task = {
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      taskType: "LEGAL_EVIDENCE_CHECK",
      status: options.taskStatus ?? L2TaskStatus.WAITING_INPUT,
      currentStep: "awaiting_source",
      input: { question: "validate evidence" },
      result: null,
      lastActiveAt: new Date(LAST_ACTIVE_AT.getTime()),
      checkpointedAt: null,
      unloadedAt: null,
      createdAt: new Date(LAST_ACTIVE_AT.getTime()),
      updatedAt: new Date(LAST_ACTIVE_AT.getTime()),
    };
  }

  public query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    const normalized = text.replaceAll(/\s+/g, " ").trim();
    this.statements.push({ text: normalized, values });
    let rows: readonly Record<string, unknown>[] = [];

    if (normalized === "BEGIN") {
      this.#transactionSnapshot = { l1: cloneL1(this.l1), task: cloneTask(this.task) };
    } else if (normalized === "COMMIT") {
      this.#transactionSnapshot = null;
    } else if (normalized === "ROLLBACK") {
      if (this.#transactionSnapshot !== null) {
        this.l1 = cloneL1(this.#transactionSnapshot.l1);
        this.task = cloneTask(this.#transactionSnapshot.task);
      }
      this.#transactionSnapshot = null;
    } else if (normalized.startsWith("SELECT EXISTS")) {
      const hasActive =
        this.task.tenantId === requiredString(values, 0) &&
        this.task.bizDomain === requiredString(values, 1) &&
        this.task.logicalAgentId === requiredString(values, 2) &&
        this.task.runtimeInstanceId === requiredString(values, 3) &&
        this.task.unloadedAt === null &&
        [
          L2TaskStatus.QUEUED,
          L2TaskStatus.SPAWNING,
          L2TaskStatus.RUNNING,
          L2TaskStatus.WAITING_INPUT,
        ].includes(this.task.status);
      rows = [{ has_active: hasActive }];
    } else if (
      normalized.includes("FROM agent_task") &&
      normalized.includes("input_json") &&
      normalized.includes("status IN ('QUEUED', 'SPAWNING', 'RUNNING', 'WAITING_INPUT')")
    ) {
      const matches =
        this.task.tenantId === requiredString(values, 0) &&
        this.task.bizDomain === requiredString(values, 1) &&
        this.task.logicalAgentId === requiredString(values, 2) &&
        [
          L2TaskStatus.QUEUED,
          L2TaskStatus.SPAWNING,
          L2TaskStatus.RUNNING,
          L2TaskStatus.WAITING_INPUT,
        ].includes(this.task.status);
      rows = matches ? [taskRow(this.task)] : [];
    } else if (normalized.startsWith("UPDATE agent_task AS task")) {
      const matches =
        this.task.tenantId === requiredString(values, 0) &&
        this.task.bizDomain === requiredString(values, 1) &&
        this.task.logicalAgentId === requiredString(values, 2) &&
        this.task.taskId === requiredString(values, 5) &&
        [
          L2TaskStatus.QUEUED,
          L2TaskStatus.SPAWNING,
          L2TaskStatus.RUNNING,
          L2TaskStatus.WAITING_INPUT,
        ].includes(this.task.status);
      if (matches) {
        this.task.runtimeInstanceId = requiredString(values, 3);
        this.task.sessionId = requiredString(values, 4);
        this.task.lastActiveAt = requiredDate(values, 6);
        this.task.updatedAt = requiredDate(values, 6);
        rows = [taskRow(this.task)];
      }
    } else if (normalized.startsWith("UPDATE agent_task")) {
      const unloadable = [
        L2TaskStatus.WAITING_INPUT,
        L2TaskStatus.COMPLETED,
        L2TaskStatus.FAILED,
        L2TaskStatus.CHECKPOINTED,
      ].includes(this.task.status);
      if (identityMatchesTask(this.task, values) && this.task.unloadedAt === null && unloadable) {
        const unloadedAt = requiredDate(values, 6);
        if (this.task.status !== L2TaskStatus.WAITING_INPUT) {
          this.task.status = L2TaskStatus.UNLOADED;
        }
        this.task.checkpointedAt ??= unloadedAt;
        this.task.unloadedAt = unloadedAt;
        this.task.lastActiveAt = unloadedAt;
        this.task.updatedAt = unloadedAt;
        rows = [{ task_id: this.task.taskId }];
      }
    } else if (normalized.includes("FROM agent_task")) {
      const matches =
        this.task.tenantId === requiredString(values, 0) &&
        this.task.bizDomain === requiredString(values, 1) &&
        this.task.unloadedAt === null;
      rows = matches ? [taskRow(this.task)] : [];
    } else if (normalized.startsWith("SELECT agent.tenant_id")) {
      const matches =
        this.l1.tenantId === requiredString(values, 0) &&
        this.l1.bizDomain === requiredString(values, 1) &&
        this.l1.unloadedAt === null;
      rows = matches
        ? [
            {
              tenant_id: this.l1.tenantId,
              biz_domain: this.l1.bizDomain,
              logical_agent_id: this.l1.logicalAgentId,
              runtime_instance_id: this.l1.runtimeInstanceId,
              status: this.l1.logicalStatus,
              last_active_at: this.l1.lastActiveAt,
            },
          ]
        : [];
    } else if (normalized.startsWith("UPDATE agent_runtime_instance AS runtime")) {
      const matches =
        this.l1.tenantId === requiredString(values, 0) &&
        this.l1.bizDomain === requiredString(values, 1) &&
        this.l1.logicalAgentId === requiredString(values, 2) &&
        this.l1.runtimeInstanceId === requiredString(values, 3) &&
        this.l1.logicalStatus === L1RuntimeStatus.IDLE &&
        this.l1.runtimeStatus === L1RuntimeStatus.IDLE;
      if (matches) {
        const unloadedAt = requiredDate(values, 4);
        this.l1.runtimeStatus = L1RuntimeStatus.UNLOADED;
        this.l1.checkpointedAt ??= unloadedAt;
        this.l1.unloadedAt = unloadedAt;
        this.l1.lastActiveAt = unloadedAt;
        rows = [{ runtime_instance_id: this.l1.runtimeInstanceId }];
      }
    } else if (normalized.startsWith("UPDATE tenant_biz_agent")) {
      const matches =
        !this.failLogicalAgentUpdate &&
        this.l1.tenantId === requiredString(values, 0) &&
        this.l1.bizDomain === requiredString(values, 1) &&
        this.l1.logicalAgentId === requiredString(values, 2) &&
        this.l1.runtimeInstanceId === requiredString(values, 3) &&
        this.l1.logicalStatus === L1RuntimeStatus.IDLE;
      if (matches) {
        this.l1.logicalStatus = L1RuntimeStatus.UNLOADED;
        this.l1.lastActiveAt = requiredDate(values, 4);
        rows = [
          {
            logical_agent_id: this.l1.logicalAgentId,
            current_runtime_instance_id: this.l1.runtimeInstanceId,
          },
        ];
      }
    }

    return Promise.resolve({ rows: rows as readonly TRow[], rowCount: rows.length });
  }

  public release(): void {
    this.releaseCount += 1;
  }
}

class RecordingLifecyclePool implements PostgresPool {
  public constructor(public readonly client: RecordingLifecycleClient) {}

  public connect(): Promise<PostgresClient> {
    return Promise.resolve(this.client);
  }
}

function harness(options: RecordingClientOptions = {}) {
  const client = new RecordingLifecycleClient(options);
  const pool = new RecordingLifecyclePool(client);
  const repository = new PostgresLifecycleRepository(pool);
  return { client, pool, repository };
}

describe("Postgres lifecycle repository adapter", () => {
  it("structurally implements the reaper port and scopes every L1/L2 scan", async () => {
    const { client, repository } = harness();
    const port: LifecycleRepository = repository;

    const [l1, l2, otherL1, otherL2] = await Promise.all([
      port.listL1LifecycleRecords({ tenantId: "tenant_A", bizDomain: "legal" }),
      port.listL2LifecycleRecords({ tenantId: "tenant_A", bizDomain: "legal" }),
      port.listL1LifecycleRecords(OTHER_SCOPE),
      port.listL2LifecycleRecords(OTHER_SCOPE),
    ]);

    expect(l1).toEqual([
      expect.objectContaining({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        status: L1RuntimeStatus.IDLE,
      }),
    ]);
    expect(l2).toEqual([
      expect.objectContaining({
        scope: SCOPE,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        status: L2TaskStatus.WAITING_INPUT,
      }),
    ]);
    expect(otherL1).toEqual([]);
    expect(otherL2).toEqual([]);

    const scopedReads = client.statements.filter((statement) =>
      statement.text.startsWith("SELECT"),
    );
    expect(scopedReads).toHaveLength(4);
    for (const statement of scopedReads) {
      expect(statement.text).toContain("tenant_id = $1");
      expect(statement.text).toContain("biz_domain = $2");
      expect(statement.values).toHaveLength(2);
    }
  });

  it("keeps WAITING_INPUT restorable while excluding its unloaded runtime from scans", async () => {
    const { client, pool, repository } = harness({ taskStatus: L2TaskStatus.WAITING_INPUT });

    await repository.markL2Unloaded({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      unloadedAt: UNLOADED_AT,
    });

    expect(client.task.status).toBe(L2TaskStatus.WAITING_INPUT);
    expect(client.task.unloadedAt).toEqual(UNLOADED_AT);
    expect(await repository.listL2LifecycleRecords(SCOPE)).toEqual([]);
    await expect(
      repository.hasActiveL2({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
      }),
    ).resolves.toBe(false);

    const persistence = new PostgresPhase5PersistenceRepository(pool);
    const unfinished = await persistence.listUnfinishedTasks({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
    });
    expect(unfinished).toEqual([
      expect.objectContaining({ taskId: TASK_ID, status: L2TaskStatus.WAITING_INPUT }),
    ]);

    const rebound = await persistence.rebindTaskForRestore({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      sessionId: "session_restored",
      taskId: TASK_ID,
      now: new Date("2030-01-03T00:00:00.000Z"),
    });
    expect(rebound).toMatchObject({
      taskId: TASK_ID,
      status: L2TaskStatus.WAITING_INPUT,
      runtimeInstanceId: "ari_restored",
      sessionId: "session_restored",
    });

    const unloadStatement = client.statements.find((statement) =>
      statement.text.startsWith("UPDATE agent_task SET status = CASE"),
    );
    expect(unloadStatement?.text).toContain("WHEN status = 'WAITING_INPUT' THEN 'WAITING_INPUT'");
    expect(unloadStatement?.text).toContain("unloaded_at IS NULL");
    expect(unloadStatement?.text).toContain(
      "status IN ('WAITING_INPUT', 'COMPLETED', 'FAILED', 'CHECKPOINTED')",
    );
  });

  it.each([L2TaskStatus.COMPLETED, L2TaskStatus.FAILED, L2TaskStatus.CHECKPOINTED])(
    "marks terminal/checkpointed L2 status %s as UNLOADED",
    async (status) => {
      const { client, repository } = harness({ taskStatus: status });

      await repository.markL2Unloaded({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        unloadedAt: UNLOADED_AT,
      });

      expect(client.task.status).toBe(L2TaskStatus.UNLOADED);
      expect(client.task.unloadedAt).toEqual(UNLOADED_AT);
    },
  );

  it("rejects active or cross-scope L2 updates without changing task state", async () => {
    const active = harness({ taskStatus: L2TaskStatus.RUNNING });
    await expect(
      active.repository.markL2Unloaded({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        unloadedAt: UNLOADED_AT,
      }),
    ).rejects.toThrow(PostgresLifecycleRepositoryError);
    expect(active.client.task.status).toBe(L2TaskStatus.RUNNING);
    expect(active.client.task.unloadedAt).toBeNull();

    const crossScope = harness();
    await expect(
      crossScope.repository.markL2Unloaded({
        scope: OTHER_SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        unloadedAt: UNLOADED_AT,
      }),
    ).rejects.toThrow(PostgresLifecycleRepositoryError);
    expect(crossScope.client.task.status).toBe(L2TaskStatus.WAITING_INPUT);
    expect(crossScope.client.task.unloadedAt).toBeNull();
  });

  it("checks active children with the full tenant/biz/runtime scope", async () => {
    const { client, repository } = harness({ taskStatus: L2TaskStatus.RUNNING });

    await expect(
      repository.hasActiveL2({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.hasActiveL2({
        scope: OTHER_SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
      }),
    ).resolves.toBe(false);

    const checks = client.statements.filter((statement) =>
      statement.text.startsWith("SELECT EXISTS"),
    );
    expect(checks).toHaveLength(2);
    for (const check of checks) {
      expect(check.text).toContain("tenant_id = $1");
      expect(check.text).toContain("biz_domain = $2");
      expect(check.text).toContain("logical_agent_id = $3");
      expect(check.text).toContain("runtime_instance_id = $4");
      expect(check.text).toContain("unloaded_at IS NULL");
    }
  });

  it("marks runtime and logical L1 UNLOADED atomically while preserving current_runtime", async () => {
    const { client, repository } = harness({ l1Status: L1RuntimeStatus.IDLE });

    await repository.markL1Unloaded({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: RUNTIME_INSTANCE_ID,
      unloadedAt: UNLOADED_AT,
    });

    expect(client.l1.runtimeStatus).toBe(L1RuntimeStatus.UNLOADED);
    expect(client.l1.logicalStatus).toBe(L1RuntimeStatus.UNLOADED);
    expect(client.l1.runtimeInstanceId).toBe(RUNTIME_INSTANCE_ID);
    expect(client.l1.unloadedAt).toEqual(UNLOADED_AT);
    expect(client.statements.map((statement) => statement.text)).toContain("BEGIN");
    expect(client.statements.map((statement) => statement.text)).toContain("COMMIT");
    expect(client.statements.map((statement) => statement.text)).not.toContain("ROLLBACK");
    await expect(repository.listL1LifecycleRecords(SCOPE)).resolves.toEqual([]);

    const logicalUpdate = client.statements.find((statement) =>
      statement.text.startsWith("UPDATE tenant_biz_agent"),
    );
    expect(logicalUpdate?.text).toContain("current_runtime_instance_id = $4");
    expect(logicalUpdate?.text.split(" WHERE ")[0]).not.toContain("current_runtime_instance_id");
  });

  it("rolls back both L1 rows when the logical-agent update fails", async () => {
    const { client, repository } = harness({ l1Status: L1RuntimeStatus.IDLE });
    client.failLogicalAgentUpdate = true;

    await expect(
      repository.markL1Unloaded({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: RUNTIME_INSTANCE_ID,
        unloadedAt: UNLOADED_AT,
      }),
    ).rejects.toThrow(PostgresLifecycleRepositoryError);

    expect(client.l1.runtimeStatus).toBe(L1RuntimeStatus.IDLE);
    expect(client.l1.logicalStatus).toBe(L1RuntimeStatus.IDLE);
    expect(client.l1.unloadedAt).toBeNull();
    expect(client.statements.map((statement) => statement.text)).toContain("ROLLBACK");
    expect(client.statements.map((statement) => statement.text)).not.toContain("COMMIT");
    expect(client.releaseCount).toBe(1);
  });
});
