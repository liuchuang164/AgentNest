import { L2TaskStatus } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import {
  CheckpointLevel,
  PersistedTraceDecision,
  Phase5ScopeError,
  PostgresPhase5PersistenceRepository,
  type SaveTaskStateInput,
  type TaskPersistenceIdentity,
} from "../../packages/persistence/src/phase5-persistence-repository.js";
import type {
  PostgresClient,
  PostgresPool,
  SqlQueryResult,
} from "../../packages/persistence/src/postgres.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const LATER = new Date("2030-01-01T00:10:00.000Z");
const TENANT_A_LEGAL_AGENT = "tb_aaaaaaaaaaaaaaaaaaaa";
const TENANT_A_ROBOT_AGENT = "tb_bbbbbbbbbbbbbbbbbbbb";
const TENANT_B_LEGAL_AGENT = "tb_cccccccccccccccccccc";

interface RuntimeScope {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  lastActiveAt: Date;
}

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

function requiredJson(values: readonly unknown[] | undefined, index: number): unknown {
  const value = requiredValue(values, index);
  if (typeof value !== "string") {
    throw new TypeError(`SQL value at index ${String(index)} is not serialized JSON`);
  }
  return JSON.parse(value) as unknown;
}

function nullableJson(values: readonly unknown[] | undefined, index: number): unknown {
  const value = requiredValue(values, index);
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(`SQL value at index ${String(index)} is not nullable JSON`);
  }
  return JSON.parse(value) as unknown;
}

function sameIdentity(
  row: Readonly<Record<string, unknown>>,
  values: readonly unknown[] | undefined,
): boolean {
  return (
    row["tenant_id"] === requiredString(values, 0) &&
    row["biz_domain"] === requiredString(values, 1) &&
    row["logical_agent_id"] === requiredString(values, 2) &&
    row["runtime_instance_id"] === requiredString(values, 3) &&
    row["session_id"] === requiredString(values, 4) &&
    row["task_id"] === requiredString(values, 5)
  );
}

class RecordingPhase5PostgresClient implements PostgresClient {
  public readonly statements: string[] = [];
  public readonly values: (readonly unknown[] | undefined)[] = [];
  public readonly tasks: Record<string, unknown>[] = [];
  public readonly memories: Record<string, unknown>[] = [];
  public readonly summaries: Record<string, unknown>[] = [];
  public readonly traces: Record<string, unknown>[] = [];
  public readonly checkpoints: Record<string, unknown>[] = [];
  public readonly toolCompletions: Record<string, unknown>[] = [];
  public releaseCount = 0;

  public constructor(public readonly runtimeScopes: RuntimeScope[]) {}

  public query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    const statement = text.replaceAll(/\s+/gu, " ").trim();
    this.statements.push(statement);
    this.values.push(values);
    let rows: readonly Record<string, unknown>[] = [];

    if (text.includes("INSERT INTO agent_task")) {
      rows = this.#saveTask(values);
    } else if (text.includes("INSERT INTO agent_memory")) {
      rows = this.#saveMemory(values);
    } else if (text.includes("INSERT INTO agent_session_summary")) {
      rows = this.#saveSummary(values);
    } else if (text.includes("INSERT INTO agent_trace")) {
      rows = this.#saveTrace(values);
    } else if (text.includes("INSERT INTO agent_checkpoint_artifact")) {
      rows = this.#saveCheckpoint(values);
    } else if (text.includes("INSERT INTO demo_tool_completion_marker")) {
      rows = this.#insertToolCompletion(values);
    } else if (text.includes("UPDATE agent_task AS task")) {
      rows = this.#rebindTask(values);
    } else if (text.includes("UPDATE agent_task")) {
      rows = this.#touchTask(values);
    } else if (text.includes("UPDATE agent_runtime_instance")) {
      rows = this.#touchRuntime(values);
    } else if (text.includes("UPDATE tenant_biz_agent")) {
      rows = this.#touchLogicalAgent(values);
    } else if (text.includes("FROM agent_task") && text.includes("status IN")) {
      rows = this.#listUnfinishedTasks(values);
    } else if (text.includes("FROM agent_task")) {
      rows = this.tasks.filter(
        (task) =>
          task["tenant_id"] === requiredString(values, 0) &&
          task["biz_domain"] === requiredString(values, 1) &&
          task["task_id"] === requiredString(values, 2),
      );
    } else if (text.includes("FROM agent_memory")) {
      rows = this.#listForScope(this.memories, values);
    } else if (text.includes("FROM agent_session_summary")) {
      rows =
        values?.length === 6
          ? this.summaries.filter((summary) => sameIdentity(summary, values)).slice(0, 1)
          : this.#listForScope(this.summaries, values).slice(0, 1);
    } else if (text.includes("FROM agent_trace")) {
      rows = this.#listForScope(this.traces, values);
    } else if (text.includes("FROM agent_checkpoint_artifact")) {
      rows = this.#listForScope(this.checkpoints, values).slice(0, 1);
    } else if (text.includes("FROM demo_tool_completion_marker")) {
      rows = this.#findToolCompletion(values);
    } else if (text.includes("FROM agent_runtime_instance AS runtime")) {
      rows = this.runtimeScopes
        .filter(
          (runtime) =>
            runtime.tenantId === requiredString(values, 0) &&
            runtime.bizDomain === requiredString(values, 1) &&
            runtime.logicalAgentId === requiredString(values, 2),
        )
        .map((runtime) => ({ runtime_instance_id: runtime.runtimeInstanceId }))
        .slice(-1);
    }

    return Promise.resolve({ rows: rows as readonly TRow[], rowCount: rows.length });
  }

  public release(): void {
    this.releaseCount += 1;
  }

  #saveTask(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const runtimeMatches = this.runtimeScopes.some(
      (runtime) =>
        runtime.tenantId === requiredString(values, 0) &&
        runtime.bizDomain === requiredString(values, 1) &&
        runtime.logicalAgentId === requiredString(values, 3) &&
        runtime.runtimeInstanceId === requiredString(values, 4),
    );
    if (!runtimeMatches) {
      return [];
    }
    const now = requiredDate(values, 11);
    const existing = this.tasks.find(
      (task) =>
        task["tenant_id"] === requiredString(values, 0) &&
        task["biz_domain"] === requiredString(values, 1) &&
        task["task_id"] === requiredString(values, 2),
    );
    if (existing !== undefined) {
      if (
        !sameIdentity(existing, [
          values?.[0],
          values?.[1],
          values?.[3],
          values?.[4],
          values?.[5],
          values?.[2],
        ])
      ) {
        return [];
      }
      existing["status"] = requiredString(values, 7);
      existing["current_step"] = values?.[8] ?? null;
      existing["result_json"] = nullableJson(values, 10);
      existing["last_active_at"] = now;
      if (["CHECKPOINTED", "UNLOADED"].includes(requiredString(values, 7))) {
        existing["checkpointed_at"] ??= now;
      }
      if (requiredString(values, 7) === "UNLOADED") {
        existing["unloaded_at"] ??= now;
      }
      existing["updated_at"] = now;
      return [existing];
    }
    const row: Record<string, unknown> = {
      tenant_id: requiredString(values, 0),
      biz_domain: requiredString(values, 1),
      task_id: requiredString(values, 2),
      logical_agent_id: requiredString(values, 3),
      runtime_instance_id: requiredString(values, 4),
      session_id: requiredString(values, 5),
      task_type: requiredString(values, 6),
      status: requiredString(values, 7),
      current_step: values?.[8] ?? null,
      input_json: requiredJson(values, 9),
      result_json: nullableJson(values, 10),
      last_active_at: now,
      checkpointed_at: ["CHECKPOINTED", "UNLOADED"].includes(requiredString(values, 7))
        ? now
        : null,
      unloaded_at: requiredString(values, 7) === "UNLOADED" ? now : null,
      created_at: now,
      updated_at: now,
    };
    this.tasks.push(row);
    return [row];
  }

  #listUnfinishedTasks(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const unfinished = new Set(["QUEUED", "SPAWNING", "RUNNING", "WAITING_INPUT"]);
    return this.#listForScope(this.tasks, values).filter((task) =>
      unfinished.has(String(task["status"])),
    );
  }

  #touchTask(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    task["last_active_at"] = requiredDate(values, 6);
    task["updated_at"] = requiredDate(values, 6);
    return [{ task_id: task["task_id"] }];
  }

  #rebindTask(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const runtimeMatches = this.runtimeScopes.some(
      (runtime) =>
        runtime.tenantId === requiredString(values, 0) &&
        runtime.bizDomain === requiredString(values, 1) &&
        runtime.logicalAgentId === requiredString(values, 2) &&
        runtime.runtimeInstanceId === requiredString(values, 3),
    );
    const task = this.tasks.find(
      (candidate) =>
        candidate["tenant_id"] === requiredString(values, 0) &&
        candidate["biz_domain"] === requiredString(values, 1) &&
        candidate["logical_agent_id"] === requiredString(values, 2) &&
        candidate["task_id"] === requiredString(values, 5) &&
        ["QUEUED", "SPAWNING", "RUNNING", "WAITING_INPUT"].includes(String(candidate["status"])),
    );
    if (!runtimeMatches || task === undefined) {
      return [];
    }
    task["runtime_instance_id"] = requiredString(values, 3);
    task["session_id"] = requiredString(values, 4);
    task["last_active_at"] = requiredDate(values, 6);
    task["unloaded_at"] = null;
    task["updated_at"] = requiredDate(values, 6);
    return [task];
  }

  #touchRuntime(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const runtime = this.runtimeScopes.find(
      (candidate) =>
        candidate.tenantId === requiredString(values, 0) &&
        candidate.bizDomain === requiredString(values, 1) &&
        candidate.logicalAgentId === requiredString(values, 2) &&
        candidate.runtimeInstanceId === requiredString(values, 3),
    );
    if (runtime === undefined) {
      return [];
    }
    runtime.lastActiveAt = requiredDate(values, 4);
    return [{ runtime_instance_id: runtime.runtimeInstanceId }];
  }

  #touchLogicalAgent(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const matches = this.runtimeScopes.some(
      (runtime) =>
        runtime.tenantId === requiredString(values, 0) &&
        runtime.bizDomain === requiredString(values, 1) &&
        runtime.logicalAgentId === requiredString(values, 2) &&
        runtime.runtimeInstanceId === requiredString(values, 4),
    );
    return matches ? [{ logical_agent_id: requiredString(values, 2) }] : [];
  }

  #saveMemory(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    const now = requiredDate(values, 12);
    const existing = this.memories.find(
      (memory) =>
        memory["tenant_id"] === requiredString(values, 0) &&
        memory["biz_domain"] === requiredString(values, 1) &&
        memory["logical_agent_id"] === requiredString(values, 2) &&
        memory["task_id"] === requiredString(values, 5) &&
        memory["dedupe_key"] === requiredString(values, 7),
    );
    if (existing !== undefined) {
      existing["runtime_instance_id"] = task["runtime_instance_id"];
      existing["session_id"] = task["session_id"];
      existing["memory_type"] = requiredString(values, 8);
      existing["resource_type"] = values?.[9] ?? null;
      existing["resource_id"] = values?.[10] ?? null;
      existing["content"] = requiredString(values, 11);
      existing["updated_at"] = now;
      return [existing];
    }
    const row: Record<string, unknown> = {
      memory_id: requiredString(values, 6),
      tenant_id: task["tenant_id"],
      biz_domain: task["biz_domain"],
      logical_agent_id: task["logical_agent_id"],
      runtime_instance_id: task["runtime_instance_id"],
      session_id: task["session_id"],
      task_id: task["task_id"],
      dedupe_key: requiredString(values, 7),
      memory_type: requiredString(values, 8),
      resource_type: values?.[9] ?? null,
      resource_id: values?.[10] ?? null,
      content: requiredString(values, 11),
      created_at: now,
      updated_at: now,
    };
    this.memories.push(row);
    return [row];
  }

  #saveSummary(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    const now = requiredDate(values, 9);
    const existing = this.summaries.find(
      (summary) =>
        summary["tenant_id"] === requiredString(values, 0) &&
        summary["biz_domain"] === requiredString(values, 1) &&
        summary["logical_agent_id"] === requiredString(values, 2) &&
        summary["session_id"] === requiredString(values, 4) &&
        summary["task_id"] === requiredString(values, 5),
    );
    if (existing !== undefined) {
      existing["summary"] = requiredString(values, 7);
      existing["transcript_path"] = requiredString(values, 8);
      existing["updated_at"] = now;
      return [existing];
    }
    const row: Record<string, unknown> = {
      summary_id: requiredString(values, 6),
      tenant_id: task["tenant_id"],
      biz_domain: task["biz_domain"],
      logical_agent_id: task["logical_agent_id"],
      runtime_instance_id: task["runtime_instance_id"],
      session_id: task["session_id"],
      task_id: task["task_id"],
      summary: requiredString(values, 7),
      transcript_path: requiredString(values, 8),
      created_at: now,
      updated_at: now,
    };
    this.summaries.push(row);
    return [row];
  }

  #saveTrace(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    const existing = this.traces.find(
      (trace) =>
        trace["tenant_id"] === requiredString(values, 0) &&
        trace["biz_domain"] === requiredString(values, 1) &&
        trace["task_id"] === requiredString(values, 5) &&
        trace["event_key"] === requiredString(values, 8),
    );
    if (existing !== undefined) {
      existing["runtime_instance_id"] = task["runtime_instance_id"];
      existing["session_id"] = task["session_id"];
      existing["trace_id"] = requiredString(values, 7);
      existing["event_type"] = requiredString(values, 9);
      existing["decision"] = values?.[10] ?? null;
      existing["reason"] = values?.[11] ?? null;
      existing["event_json"] = requiredJson(values, 12);
      return [existing];
    }
    const row: Record<string, unknown> = {
      trace_event_id: requiredString(values, 6),
      trace_id: requiredString(values, 7),
      tenant_id: task["tenant_id"],
      biz_domain: task["biz_domain"],
      logical_agent_id: task["logical_agent_id"],
      runtime_instance_id: task["runtime_instance_id"],
      session_id: task["session_id"],
      task_id: task["task_id"],
      event_key: requiredString(values, 8),
      event_type: requiredString(values, 9),
      decision: values?.[10] ?? null,
      reason: values?.[11] ?? null,
      event_json: requiredJson(values, 12),
      created_at: requiredDate(values, 13),
    };
    this.traces.push(row);
    return [row];
  }

  #saveCheckpoint(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    if (values?.length === 8) {
      const runtimeMatches = this.runtimeScopes.some(
        (runtime) =>
          runtime.tenantId === requiredString(values, 0) &&
          runtime.bizDomain === requiredString(values, 1) &&
          runtime.logicalAgentId === requiredString(values, 2) &&
          runtime.runtimeInstanceId === requiredString(values, 3),
      );
      if (!runtimeMatches) {
        return [];
      }
      const now = requiredDate(values, 7);
      const existing = this.checkpoints.find(
        (checkpoint) =>
          checkpoint["tenant_id"] === requiredString(values, 0) &&
          checkpoint["biz_domain"] === requiredString(values, 1) &&
          checkpoint["logical_agent_id"] === requiredString(values, 2) &&
          checkpoint["runtime_instance_id"] === requiredString(values, 3) &&
          checkpoint["session_id"] === null &&
          checkpoint["task_id"] === null &&
          checkpoint["checkpoint_level"] === "L1",
      );
      if (existing !== undefined) {
        existing["snapshot_path"] = requiredString(values, 5);
        existing["transcript_path"] = requiredString(values, 6);
        existing["updated_at"] = now;
        return [existing];
      }
      const row: Record<string, unknown> = {
        checkpoint_id: requiredString(values, 4),
        checkpoint_level: "L1",
        tenant_id: requiredString(values, 0),
        biz_domain: requiredString(values, 1),
        logical_agent_id: requiredString(values, 2),
        runtime_instance_id: requiredString(values, 3),
        session_id: null,
        task_id: null,
        snapshot_path: requiredString(values, 5),
        transcript_path: requiredString(values, 6),
        created_at: now,
        updated_at: now,
      };
      this.checkpoints.push(row);
      return [row];
    }
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    const now = requiredDate(values, 10);
    const existing = this.checkpoints.find(
      (checkpoint) =>
        checkpoint["tenant_id"] === requiredString(values, 0) &&
        checkpoint["biz_domain"] === requiredString(values, 1) &&
        checkpoint["logical_agent_id"] === requiredString(values, 2) &&
        checkpoint["runtime_instance_id"] === requiredString(values, 3) &&
        checkpoint["session_id"] === requiredString(values, 4) &&
        checkpoint["task_id"] === requiredString(values, 5) &&
        checkpoint["checkpoint_level"] === requiredString(values, 7),
    );
    if (existing !== undefined) {
      existing["snapshot_path"] = requiredString(values, 8);
      existing["transcript_path"] = requiredString(values, 9);
      existing["updated_at"] = now;
      return [existing];
    }
    const row: Record<string, unknown> = {
      checkpoint_id: requiredString(values, 6),
      checkpoint_level: requiredString(values, 7),
      tenant_id: task["tenant_id"],
      biz_domain: task["biz_domain"],
      logical_agent_id: task["logical_agent_id"],
      runtime_instance_id: task["runtime_instance_id"],
      session_id: task["session_id"],
      task_id: task["task_id"],
      snapshot_path: requiredString(values, 8),
      transcript_path: requiredString(values, 9),
      created_at: now,
      updated_at: now,
    };
    this.checkpoints.push(row);
    return [row];
  }

  #insertToolCompletion(
    values: readonly unknown[] | undefined,
  ): readonly Record<string, unknown>[] {
    const task = this.tasks.find((candidate) => sameIdentity(candidate, values));
    if (task === undefined) {
      return [];
    }
    const existing = this.toolCompletions.find((completion) =>
      this.#sameToolKey(completion, values),
    );
    if (existing !== undefined) {
      return [];
    }
    const row: Record<string, unknown> = {
      marker_id: requiredString(values, 6),
      tenant_id: task["tenant_id"],
      biz_domain: task["biz_domain"],
      logical_agent_id: task["logical_agent_id"],
      runtime_instance_id: task["runtime_instance_id"],
      session_id: task["session_id"],
      task_id: task["task_id"],
      tool_name: requiredString(values, 7),
      action: requiredString(values, 8),
      resource_type: requiredString(values, 9),
      resource_id: requiredString(values, 10),
      result_json: requiredJson(values, 11),
      completed_at: requiredDate(values, 12),
    };
    this.toolCompletions.push(row);
    return [row];
  }

  #findToolCompletion(values: readonly unknown[] | undefined): readonly Record<string, unknown>[] {
    return this.toolCompletions.filter(
      (completion) =>
        completion["tenant_id"] === requiredString(values, 0) &&
        completion["biz_domain"] === requiredString(values, 1) &&
        completion["logical_agent_id"] === requiredString(values, 2) &&
        completion["task_id"] === requiredString(values, 3) &&
        completion["tool_name"] === requiredString(values, 4) &&
        completion["action"] === requiredString(values, 5) &&
        completion["resource_type"] === requiredString(values, 6) &&
        completion["resource_id"] === requiredString(values, 7),
    );
  }

  #sameToolKey(
    completion: Readonly<Record<string, unknown>>,
    values: readonly unknown[] | undefined,
    offset = 7,
  ): boolean {
    return (
      completion["tenant_id"] === requiredString(values, 0) &&
      completion["biz_domain"] === requiredString(values, 1) &&
      completion["task_id"] === requiredString(values, 5) &&
      completion["tool_name"] === requiredString(values, offset) &&
      completion["action"] === requiredString(values, offset + 1) &&
      completion["resource_type"] === requiredString(values, offset + 2) &&
      completion["resource_id"] === requiredString(values, offset + 3)
    );
  }

  #listForScope(
    records: readonly Record<string, unknown>[],
    values: readonly unknown[] | undefined,
  ): readonly Record<string, unknown>[] {
    return records
      .filter(
        (record) =>
          record["tenant_id"] === requiredString(values, 0) &&
          record["biz_domain"] === requiredString(values, 1) &&
          record["logical_agent_id"] === requiredString(values, 2),
      )
      .toReversed();
  }
}

class RecordingPhase5PostgresPool implements PostgresPool {
  public connectCount = 0;

  public constructor(public readonly client: RecordingPhase5PostgresClient) {}

  public connect(): Promise<PostgresClient> {
    this.connectCount += 1;
    return Promise.resolve(this.client);
  }
}

function runtimeScopes(): RuntimeScope[] {
  return [
    {
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: TENANT_A_LEGAL_AGENT,
      runtimeInstanceId: "ari_a_01",
      lastActiveAt: NOW,
    },
    {
      tenantId: "tenant_A",
      bizDomain: "ROBOT_DOG",
      logicalAgentId: TENANT_A_ROBOT_AGENT,
      runtimeInstanceId: "ari_robot_01",
      lastActiveAt: NOW,
    },
    {
      tenantId: "tenant_B",
      bizDomain: "LEGAL",
      logicalAgentId: TENANT_B_LEGAL_AGENT,
      runtimeInstanceId: "ari_b_01",
      lastActiveAt: NOW,
    },
  ];
}

function uuidFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
}

function identity(overrides: Partial<TaskPersistenceIdentity> = {}): TaskPersistenceIdentity {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    logicalAgentId: TENANT_A_LEGAL_AGENT,
    runtimeInstanceId: "ari_a_01",
    sessionId: "session_a_01",
    taskId: "task_001",
    ...overrides,
  };
}

function taskInput(overrides: Partial<SaveTaskStateInput> = {}): SaveTaskStateInput {
  return {
    ...identity(),
    taskType: "LEGAL_EVIDENCE_CHECK",
    status: L2TaskStatus.RUNNING,
    currentStep: "READ_CASE",
    input: { resource_id: "case_001" },
    result: null,
    now: NOW,
    ...overrides,
  };
}

describe("PostgresPhase5PersistenceRepository recording adapter", () => {
  it("persists and retries an L1 checkpoint without inventing an L2 task or session", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    const input = {
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_A_LEGAL_AGENT,
      runtimeInstanceId: "ari_a_01",
      snapshotPath: `${TENANT_A_LEGAL_AGENT}/runtimes/ari_a_01/l1.snapshot.json`,
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/runtimes/ari_a_01/l1.transcript.jsonl`,
      now: NOW,
    } as const;

    const first = await repository.saveL1CheckpointArtifact(input);
    const retried = await repository.saveL1CheckpointArtifact({ ...input, now: LATER });

    expect(first).toMatchObject({
      checkpointLevel: CheckpointLevel.L1,
      sessionId: null,
      taskId: null,
    });
    expect(retried.checkpointId).toBe(first.checkpointId);
    expect(retried.updatedAt).toEqual(LATER);
    expect(client.checkpoints).toHaveLength(1);
    const statements = client.statements.filter((statement) =>
      statement.startsWith("INSERT INTO agent_checkpoint_artifact"),
    );
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => statement.includes("FROM tenant_biz_agent"))).toBe(true);
  });

  it("persists retry-safe task, memory, summary, trace, checkpoint, and tool completion records", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );

    const task = await repository.saveTaskState(taskInput());
    const firstMemory = await repository.saveMemory({
      ...identity(),
      dedupeKey: "task-result",
      memoryType: "RESOURCE_MEMORY",
      resourceType: "CASE",
      resourceId: "case_001",
      content: "ALPHA_LEGAL_MEMORY",
      now: NOW,
    });
    const retriedMemory = await repository.saveMemory({
      ...identity(),
      dedupeKey: "task-result",
      memoryType: "RESOURCE_MEMORY",
      resourceType: "CASE",
      resourceId: "case_001",
      content: "ALPHA_LEGAL_MEMORY_UPDATED",
      now: LATER,
    });
    const summary = await repository.saveSessionSummary({
      ...identity(),
      summary: "case evidence task is awaiting final write",
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_01.jsonl`,
      now: NOW,
    });
    const trace = await repository.appendTrace({
      ...identity(),
      traceId: "trace_001",
      eventKey: "tool-read-case",
      eventType: "TOOL_CALL_ALLOWED",
      decision: PersistedTraceDecision.ALLOW,
      reason: "TOOL_EXECUTED",
      event: { tool_name: "legal_case_read" },
      now: NOW,
    });
    const checkpoint = await repository.saveCheckpointArtifact({
      ...identity(),
      checkpointLevel: CheckpointLevel.L2,
      snapshotPath: `${TENANT_A_LEGAL_AGENT}/tasks/task_001.checkpoint.json`,
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_01.jsonl`,
      now: NOW,
    });
    const firstCompletion = await repository.recordToolCompletion({
      ...identity(),
      toolName: "legal_analysis_write",
      action: "write",
      resourceType: "CASE",
      resourceId: "case_001",
      result: { analysis_id: "analysis_001" },
      completedAt: NOW,
    });
    const retriedCompletion = await repository.recordToolCompletion({
      ...identity(),
      toolName: "legal_analysis_write",
      action: "write",
      resourceType: "CASE",
      resourceId: "case_001",
      result: { analysis_id: "analysis_ignored" },
      completedAt: LATER,
    });
    const completionVisibleAfterRuntimeChange = await repository.findToolCompletion({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_A_LEGAL_AGENT,
      taskId: "task_001",
      toolName: "legal_analysis_write",
      action: "write",
      resourceType: "CASE",
      resourceId: "case_001",
    });

    expect(task.status).toBe(L2TaskStatus.RUNNING);
    expect(retriedMemory.memoryId).toBe(firstMemory.memoryId);
    expect(retriedMemory.content).toBe("ALPHA_LEGAL_MEMORY_UPDATED");
    expect(client.memories).toHaveLength(1);
    expect(summary.transcriptPath).toContain("/sessions/session_a_01.jsonl");
    expect(trace.decision).toBe(PersistedTraceDecision.ALLOW);
    expect(checkpoint.checkpointLevel).toBe(CheckpointLevel.L2);
    expect(firstCompletion.created).toBe(true);
    expect(retriedCompletion.created).toBe(false);
    expect(retriedCompletion.record.result).toEqual({ analysis_id: "analysis_001" });
    expect(completionVisibleAfterRuntimeChange?.markerId).toBe(firstCompletion.record.markerId);
    expect(client.toolCompletions).toHaveLength(1);
  });

  it("loads the exact task Session Summary when another L2 has a newer summary", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    await repository.saveTaskState(taskInput());
    await repository.saveTaskState(
      taskInput({ taskId: "task_002", sessionId: "session_a_02", now: LATER }),
    );
    await repository.saveSessionSummary({
      ...identity(),
      summary: "task one summary",
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_01.jsonl`,
      now: NOW,
    });
    await repository.saveSessionSummary({
      ...identity({ taskId: "task_002", sessionId: "session_a_02" }),
      summary: "newer task two summary",
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_02.jsonl`,
      now: LATER,
    });

    const exact = await repository.findTaskSessionSummary(identity());

    expect(exact?.taskId).toBe("task_001");
    expect(exact?.sessionId).toBe("session_a_01");
    expect(exact?.summary).toBe("task one summary");
    expect(client.values.at(-1)).toEqual([
      "tenant_A",
      "LEGAL",
      TENANT_A_LEGAL_AGENT,
      "ari_a_01",
      "session_a_01",
      "task_001",
    ]);
  });

  it("keeps identical memory and task IDs isolated across all three Demo scopes", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    const scopedTasks = [
      {
        task: taskInput(),
        memory: "ALPHA_LEGAL_MEMORY",
      },
      {
        task: taskInput({
          scope: { tenantId: "tenant_A", bizDomain: "ROBOT_DOG" },
          logicalAgentId: TENANT_A_ROBOT_AGENT,
          runtimeInstanceId: "ari_robot_01",
          sessionId: "session_robot_01",
          taskType: "ROBOT_DOG_HEALTH_CHECK",
          input: { resource_id: "device_001" },
        }),
        memory: "ALPHA_ROBOT_MEMORY",
      },
      {
        task: taskInput({
          scope: { tenantId: "tenant_B", bizDomain: "LEGAL" },
          logicalAgentId: TENANT_B_LEGAL_AGENT,
          runtimeInstanceId: "ari_b_01",
          sessionId: "session_b_01",
        }),
        memory: "BETA_LEGAL_MEMORY",
      },
    ] as const;

    for (const item of scopedTasks) {
      await repository.saveTaskState(item.task);
      await repository.saveMemory({
        scope: item.task.scope,
        logicalAgentId: item.task.logicalAgentId,
        runtimeInstanceId: item.task.runtimeInstanceId,
        sessionId: item.task.sessionId,
        taskId: item.task.taskId,
        dedupeKey: "canary",
        memoryType: "TENANT_BIZ_MEMORY",
        resourceType: null,
        resourceId: null,
        content: item.memory,
        now: NOW,
      });
    }

    const tenantALegal = await repository.listMemories({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_A_LEGAL_AGENT,
    });
    const tenantARobot = await repository.listMemories({
      scope: { tenantId: "tenant_A", bizDomain: "ROBOT_DOG" },
      logicalAgentId: TENANT_A_ROBOT_AGENT,
    });
    const tenantBLegal = await repository.listMemories({
      scope: { tenantId: "tenant_B", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_B_LEGAL_AGENT,
    });

    expect(tenantALegal.map((memory) => memory.content)).toEqual(["ALPHA_LEGAL_MEMORY"]);
    expect(tenantARobot.map((memory) => memory.content)).toEqual(["ALPHA_ROBOT_MEMORY"]);
    expect(tenantBLegal.map((memory) => memory.content)).toEqual(["BETA_LEGAL_MEMORY"]);
    const scopedStatements = client.statements.filter(
      (statement) => !["BEGIN", "COMMIT", "ROLLBACK"].includes(statement),
    );
    expect(scopedStatements.length).toBeGreaterThan(0);
    expect(scopedStatements.every((statement) => statement.includes("tenant_id"))).toBe(true);
    expect(scopedStatements.every((statement) => statement.includes("biz_domain"))).toBe(true);
  });

  it("loads only summary, memory, trace index, unfinished task state, and file metadata for restore", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    await repository.saveTaskState(taskInput());
    await repository.saveMemory({
      ...identity(),
      dedupeKey: "restore-memory",
      memoryType: "TASK_STATE",
      resourceType: null,
      resourceId: null,
      content: "resume at ANALYZE step",
      now: NOW,
    });
    await repository.saveSessionSummary({
      ...identity(),
      summary: "read complete; analysis pending",
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_01.jsonl`,
      now: NOW,
    });
    await repository.appendTrace({
      ...identity(),
      traceId: "trace_restore",
      eventKey: "checkpoint-started",
      eventType: "CHECKPOINT_STARTED",
      decision: null,
      reason: null,
      event: { step: "ANALYZE" },
      now: NOW,
    });
    await repository.saveCheckpointArtifact({
      ...identity(),
      checkpointLevel: CheckpointLevel.L2,
      snapshotPath: `${TENANT_A_LEGAL_AGENT}/tasks/task_001.checkpoint.json`,
      transcriptPath: `${TENANT_A_LEGAL_AGENT}/sessions/session_a_01.jsonl`,
      now: NOW,
    });

    const bundle = await repository.loadRestoreBundle({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_A_LEGAL_AGENT,
    });
    const otherTenantBundle = await repository.loadRestoreBundle({
      scope: { tenantId: "tenant_B", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_B_LEGAL_AGENT,
    });

    expect(bundle.previousRuntimeInstanceId).toBe("ari_a_01");
    expect(bundle.latestSessionSummary?.summary).toContain("analysis pending");
    expect(bundle.memories.map((memory) => memory.content)).toEqual(["resume at ANALYZE step"]);
    expect(bundle.traceIndex.map((trace) => trace.eventType)).toEqual(["CHECKPOINT_STARTED"]);
    expect(bundle.unfinishedTasks.map((task) => task.currentStep)).toEqual(["READ_CASE"]);
    expect(bundle.latestCheckpoint?.snapshotPath).toContain("task_001.checkpoint.json");
    expect(Object.keys(bundle)).not.toContain("transcript");
    expect(otherTenantBundle.latestSessionSummary).toBeNull();
    expect(otherTenantBundle.memories).toEqual([]);
    expect(otherTenantBundle.unfinishedTasks).toEqual([]);

    client.runtimeScopes.push({
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      logicalAgentId: TENANT_A_LEGAL_AGENT,
      runtimeInstanceId: "ari_a_02",
      lastActiveAt: LATER,
    });
    const restoredTask = await repository.rebindTaskForRestore({
      ...identity({ runtimeInstanceId: "ari_a_02", sessionId: "session_a_02" }),
      now: LATER,
    });
    expect(restoredTask.logicalAgentId).toBe(TENANT_A_LEGAL_AGENT);
    expect(restoredTask.runtimeInstanceId).toBe("ari_a_02");
    expect(restoredTask.sessionId).toBe("session_a_02");
  });

  it("updates L1 and L2 activity only through the complete tenant/business identity", async () => {
    const scopes = runtimeScopes();
    const client = new RecordingPhase5PostgresClient(scopes);
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    await repository.saveTaskState(taskInput());

    await repository.touchL2Activity({ ...identity(), now: LATER });
    await repository.touchL1Activity({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: TENANT_A_LEGAL_AGENT,
      runtimeInstanceId: "ari_a_01",
      now: LATER,
    });

    expect(client.tasks[0]?.["last_active_at"]).toEqual(LATER);
    expect(scopes[0]?.lastActiveAt).toEqual(LATER);
    const touchStatements = client.statements.filter((statement) => statement.startsWith("UPDATE"));
    expect(touchStatements).toHaveLength(3);
    expect(touchStatements.every((statement) => statement.includes("tenant_id = $1"))).toBe(true);
    expect(touchStatements.every((statement) => statement.includes("biz_domain = $2"))).toBe(true);
  });

  it("rejects a cross-scope persistence identity instead of falling back by task ID", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );
    await repository.saveTaskState(taskInput());

    await expect(
      repository.saveMemory({
        ...identity({ scope: { tenantId: "tenant_B", bizDomain: "LEGAL" } }),
        dedupeKey: "forged-scope",
        memoryType: "RESOURCE_MEMORY",
        resourceType: "CASE",
        resourceId: "case_001",
        content: "must not be written",
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(Phase5ScopeError);
    expect(client.memories).toEqual([]);
  });

  it("rejects absolute and traversal artifact paths before issuing SQL", async () => {
    const client = new RecordingPhase5PostgresClient(runtimeScopes());
    const repository = new PostgresPhase5PersistenceRepository(
      new RecordingPhase5PostgresPool(client),
      { createId: uuidFactory() },
    );

    await expect(
      repository.saveSessionSummary({
        ...identity(),
        summary: "unsafe",
        transcriptPath: "../tenant_B/session.jsonl",
        now: NOW,
      }),
    ).rejects.toThrow("safe relative persistence path");
    await expect(
      repository.saveCheckpointArtifact({
        ...identity(),
        checkpointLevel: CheckpointLevel.L2,
        snapshotPath: "/tmp/snapshot.json",
        transcriptPath: "safe/session.jsonl",
        now: NOW,
      }),
    ).rejects.toThrow("safe relative persistence path");
    expect(client.statements).toEqual([]);
  });
});
