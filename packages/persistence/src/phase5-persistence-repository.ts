import { randomUUID } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import { normalizeTenantBizScope } from "@agentnest/capability";
import { L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";

import type { PostgresClient, PostgresPool, SqlQueryResult } from "./postgres.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOGICAL_AGENT_ID = /^tb_[a-f0-9]{20}$/u;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:\//iu;

export type JsonObject = Readonly<Record<string, unknown>>;

export enum CheckpointLevel {
  L1 = "L1",
  L2 = "L2",
}

export enum PersistedTraceDecision {
  ALLOW = "ALLOW",
  DENY = "DENY",
}

export interface TaskPersistenceIdentity {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface TaskStateRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskType: string;
  readonly status: L2TaskStatus;
  readonly currentStep: string | null;
  readonly input: JsonObject;
  readonly result: JsonObject | null;
  readonly lastActiveAt: Date;
  readonly checkpointedAt: Date | null;
  readonly unloadedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveTaskStateInput extends TaskPersistenceIdentity {
  readonly taskType: string;
  readonly status: L2TaskStatus;
  readonly currentStep: string | null;
  readonly input: JsonObject;
  readonly result: JsonObject | null;
  readonly now: Date;
}

export interface MemoryRecord {
  readonly memoryId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly dedupeKey: string;
  readonly memoryType: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly content: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveMemoryInput extends TaskPersistenceIdentity {
  readonly dedupeKey: string;
  readonly memoryType: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly content: string;
  readonly now: Date;
}

export interface SessionSummaryRecord {
  readonly summaryId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly summary: string;
  readonly transcriptPath: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveSessionSummaryInput extends TaskPersistenceIdentity {
  readonly summary: string;
  readonly transcriptPath: string;
  readonly now: Date;
}

export interface TraceIndexRecord {
  readonly traceEventId: string;
  readonly traceId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly eventKey: string;
  readonly eventType: string;
  readonly decision: PersistedTraceDecision | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface AppendTraceInput extends TaskPersistenceIdentity {
  readonly traceId: string;
  readonly eventKey: string;
  readonly eventType: string;
  readonly decision: PersistedTraceDecision | null;
  readonly reason: string | null;
  readonly event: JsonObject;
  readonly now: Date;
}

export interface CheckpointArtifactRecord {
  readonly checkpointId: string;
  readonly checkpointLevel: CheckpointLevel;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly snapshotPath: string;
  readonly transcriptPath: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveCheckpointArtifactInput extends TaskPersistenceIdentity {
  readonly checkpointLevel: CheckpointLevel.L2;
  readonly snapshotPath: string;
  readonly transcriptPath: string;
  readonly now: Date;
}

export interface SaveL1CheckpointArtifactInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly snapshotPath: string;
  readonly transcriptPath: string;
  readonly now: Date;
}

export interface ToolCompletionRecord {
  readonly markerId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly result: JsonObject;
  readonly completedAt: Date;
}

export interface ToolCompletionLookupKey {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface RecordToolCompletionInput
  extends TaskPersistenceIdentity, ToolCompletionLookupKey {
  readonly result: JsonObject;
  readonly completedAt: Date;
}

export interface RecordToolCompletionResult {
  readonly record: ToolCompletionRecord;
  readonly created: boolean;
}

export interface RestoreBundle {
  readonly previousRuntimeInstanceId: string | null;
  readonly latestSessionSummary: SessionSummaryRecord | null;
  readonly memories: readonly MemoryRecord[];
  readonly traceIndex: readonly TraceIndexRecord[];
  readonly unfinishedTasks: readonly TaskStateRecord[];
  readonly latestCheckpoint: CheckpointArtifactRecord | null;
}

export interface FindScopedRecordsInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly limit?: number;
}

export interface FindTaskStateInput {
  readonly scope: TenantBizScope;
  readonly taskId: string;
}

export type FindTaskSessionSummaryInput = TaskPersistenceIdentity;

export interface LoadRestoreBundleInput extends FindScopedRecordsInput {
  readonly limit?: number;
}

export interface Phase5PersistenceRepositoryOptions {
  readonly createId?: () => string;
}

interface TaskStateRow extends Record<string, unknown> {
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly task_type: unknown;
  readonly status: unknown;
  readonly current_step: unknown;
  readonly input_json: unknown;
  readonly result_json: unknown;
  readonly last_active_at: unknown;
  readonly checkpointed_at: unknown;
  readonly unloaded_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface MemoryRow extends Record<string, unknown> {
  readonly memory_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly dedupe_key: unknown;
  readonly memory_type: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly content: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface SessionSummaryRow extends Record<string, unknown> {
  readonly summary_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly summary: unknown;
  readonly transcript_path: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface TraceIndexRow extends Record<string, unknown> {
  readonly trace_event_id: unknown;
  readonly trace_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly event_key: unknown;
  readonly event_type: unknown;
  readonly decision: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
}

interface CheckpointArtifactRow extends Record<string, unknown> {
  readonly checkpoint_id: unknown;
  readonly checkpoint_level: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly snapshot_path: unknown;
  readonly transcript_path: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ToolCompletionRow extends Record<string, unknown> {
  readonly marker_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly tool_name: unknown;
  readonly action: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly result_json: unknown;
  readonly completed_at: unknown;
}

interface PreviousRuntimeRow extends Record<string, unknown> {
  readonly runtime_instance_id: unknown;
}

interface IdentityValues {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export class Phase5PersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Phase5PersistenceError";
  }
}

export class Phase5ScopeError extends Phase5PersistenceError {
  public constructor() {
    super("task or runtime does not belong to the requested tenant/business scope");
    this.name = "Phase5ScopeError";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Phase5PersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  return value === null ? null : readString(value, field);
}

function readDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new Phase5PersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new Phase5PersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return result;
}

function readNullableDate(value: unknown, field: string): Date | null {
  return value === null ? null : readDate(value, field);
}

function readJsonObject(value: unknown, field: string): JsonObject {
  if (!isRecord(value)) {
    throw new Phase5PersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readNullableJsonObject(value: unknown, field: string): JsonObject | null {
  return value === null ? null : readJsonObject(value, field);
}

function assertIdentifier(value: string, field: string, maxLength = 256): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
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

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function assertJsonObject(value: JsonObject, field: string): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  JSON.stringify(value);
  return value;
}

function assertUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) {
    throw new Phase5PersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return normalized;
}

function assertRelativeArtifactPath(value: string, field: string): string {
  const candidate = value.normalize("NFKC").trim().replaceAll("\\", "/");
  if (
    candidate.length === 0 ||
    candidate.length > 1024 ||
    isAbsolute(candidate) ||
    WINDOWS_ABSOLUTE_PATH.test(candidate) ||
    candidate.split("/").includes("..")
  ) {
    throw new TypeError(`${field} must be a safe relative persistence path`);
  }
  const normalized = posix.normalize(candidate);
  if (normalized === "." || normalized.startsWith("../")) {
    throw new TypeError(`${field} must be a safe relative persistence path`);
  }
  return normalized;
}

function assertResourcePair(
  resourceType: string | null,
  resourceId: string | null,
): readonly [string | null, string | null] {
  if ((resourceType === null) !== (resourceId === null)) {
    throw new TypeError("resourceType and resourceId must either both be set or both be null");
  }
  if (resourceType === null || resourceId === null) {
    return [null, null];
  }
  return [
    assertIdentifier(resourceType, "resourceType", 64),
    assertIdentifier(resourceId, "resourceId", 128),
  ];
}

function assertLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("limit must be an integer between 1 and 500");
  }
  return limit;
}

function identityValues(input: TaskPersistenceIdentity): IdentityValues {
  const scope = normalizeTenantBizScope(input.scope);
  return {
    tenantId: scope.tenantId,
    bizDomain: scope.bizDomain,
    logicalAgentId: assertLogicalAgentId(input.logicalAgentId),
    runtimeInstanceId: assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId", 128),
    sessionId: assertIdentifier(input.sessionId, "sessionId", 128),
    taskId: assertIdentifier(input.taskId, "taskId", 128),
  };
}

function readL2Status(value: unknown): L2TaskStatus {
  if (typeof value !== "string" || !Object.values(L2TaskStatus).includes(value as L2TaskStatus)) {
    throw new Phase5PersistenceError("PostgreSQL returned invalid task status");
  }
  return value as L2TaskStatus;
}

function readCheckpointLevel(value: unknown): CheckpointLevel {
  if (value === CheckpointLevel.L1 || value === CheckpointLevel.L2) {
    return value;
  }
  throw new Phase5PersistenceError("PostgreSQL returned invalid checkpoint level");
}

function readTraceDecision(value: unknown): PersistedTraceDecision | null {
  if (value === null) {
    return null;
  }
  if (value === PersistedTraceDecision.ALLOW || value === PersistedTraceDecision.DENY) {
    return value;
  }
  throw new Phase5PersistenceError("PostgreSQL returned invalid trace decision");
}

function firstRow<TRow extends Record<string, unknown>>(result: SqlQueryResult<TRow>): TRow | null {
  return result.rows[0] ?? null;
}

function requiredRow<TRow extends Record<string, unknown>>(result: SqlQueryResult<TRow>): TRow {
  const row = firstRow(result);
  if (row === null) {
    throw new Phase5ScopeError();
  }
  return row;
}

function toTaskState(row: TaskStateRow): TaskStateRecord {
  return {
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    taskType: readString(row.task_type, "task_type"),
    status: readL2Status(row.status),
    currentStep: readNullableString(row.current_step, "current_step"),
    input: readJsonObject(row.input_json, "input_json"),
    result: readNullableJsonObject(row.result_json, "result_json"),
    lastActiveAt: readDate(row.last_active_at, "last_active_at"),
    checkpointedAt: readNullableDate(row.checkpointed_at, "checkpointed_at"),
    unloadedAt: readNullableDate(row.unloaded_at, "unloaded_at"),
    createdAt: readDate(row.created_at, "created_at"),
    updatedAt: readDate(row.updated_at, "updated_at"),
  };
}

function toMemory(row: MemoryRow): MemoryRecord {
  return {
    memoryId: assertUuid(readString(row.memory_id, "memory_id"), "memory_id"),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    dedupeKey: readString(row.dedupe_key, "dedupe_key"),
    memoryType: readString(row.memory_type, "memory_type"),
    resourceType: readNullableString(row.resource_type, "resource_type"),
    resourceId: readNullableString(row.resource_id, "resource_id"),
    content: readString(row.content, "content"),
    createdAt: readDate(row.created_at, "created_at"),
    updatedAt: readDate(row.updated_at, "updated_at"),
  };
}

function toSessionSummary(row: SessionSummaryRow): SessionSummaryRecord {
  return {
    summaryId: assertUuid(readString(row.summary_id, "summary_id"), "summary_id"),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    summary: readString(row.summary, "summary"),
    transcriptPath: assertRelativeArtifactPath(
      readString(row.transcript_path, "transcript_path"),
      "transcript_path",
    ),
    createdAt: readDate(row.created_at, "created_at"),
    updatedAt: readDate(row.updated_at, "updated_at"),
  };
}

function toTraceIndex(row: TraceIndexRow): TraceIndexRecord {
  return {
    traceEventId: assertUuid(readString(row.trace_event_id, "trace_event_id"), "trace_event_id"),
    traceId: readString(row.trace_id, "trace_id"),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    eventKey: readString(row.event_key, "event_key"),
    eventType: readString(row.event_type, "event_type"),
    decision: readTraceDecision(row.decision),
    reason: readNullableString(row.reason, "reason"),
    createdAt: readDate(row.created_at, "created_at"),
  };
}

function toCheckpoint(row: CheckpointArtifactRow): CheckpointArtifactRecord {
  return {
    checkpointId: assertUuid(readString(row.checkpoint_id, "checkpoint_id"), "checkpoint_id"),
    checkpointLevel: readCheckpointLevel(row.checkpoint_level),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readNullableString(row.session_id, "session_id"),
    taskId: readNullableString(row.task_id, "task_id"),
    snapshotPath: assertRelativeArtifactPath(
      readString(row.snapshot_path, "snapshot_path"),
      "snapshot_path",
    ),
    transcriptPath: assertRelativeArtifactPath(
      readString(row.transcript_path, "transcript_path"),
      "transcript_path",
    ),
    createdAt: readDate(row.created_at, "created_at"),
    updatedAt: readDate(row.updated_at, "updated_at"),
  };
}

function toToolCompletion(row: ToolCompletionRow): ToolCompletionRecord {
  return {
    markerId: assertUuid(readString(row.marker_id, "marker_id"), "marker_id"),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    toolName: readString(row.tool_name, "tool_name"),
    action: readString(row.action, "action"),
    resourceType: readString(row.resource_type, "resource_type"),
    resourceId: readString(row.resource_id, "resource_id"),
    result: readJsonObject(row.result_json, "result_json"),
    completedAt: readDate(row.completed_at, "completed_at"),
  };
}

const TASK_COLUMNS = `tenant_id, biz_domain, logical_agent_id, runtime_instance_id,
  session_id, task_id, task_type, status, current_step, input_json, result_json,
  last_active_at, checkpointed_at, unloaded_at, created_at, updated_at`;

const MEMORY_COLUMNS = `memory_id, tenant_id, biz_domain, logical_agent_id,
  runtime_instance_id, session_id, task_id, dedupe_key, memory_type, resource_type,
  resource_id, content, created_at, updated_at`;

const SUMMARY_COLUMNS = `summary_id, tenant_id, biz_domain, logical_agent_id,
  runtime_instance_id, session_id, task_id, summary, transcript_path, created_at, updated_at`;

const TRACE_INDEX_COLUMNS = `trace_event_id, trace_id, tenant_id, biz_domain,
  logical_agent_id, runtime_instance_id, session_id, task_id, event_key, event_type,
  decision, reason, created_at`;

const CHECKPOINT_COLUMNS = `checkpoint_id, checkpoint_level, tenant_id, biz_domain,
  logical_agent_id, runtime_instance_id, session_id, task_id, snapshot_path,
  transcript_path, created_at, updated_at`;

const TOOL_COMPLETION_COLUMNS = `marker_id, tenant_id, biz_domain, logical_agent_id,
  runtime_instance_id, session_id, task_id, tool_name, action, resource_type,
  resource_id, result_json, completed_at`;

export class PostgresPhase5PersistenceRepository {
  readonly #pool: PostgresPool;
  readonly #createId: () => string;

  public constructor(pool: PostgresPool, options: Phase5PersistenceRepositoryOptions = {}) {
    this.#pool = pool;
    this.#createId = options.createId ?? randomUUID;
  }

  public async saveTaskState(input: SaveTaskStateInput): Promise<TaskStateRecord> {
    const identity = identityValues(input);
    const taskType = assertIdentifier(input.taskType, "taskType", 128);
    const currentStep =
      input.currentStep === null ? null : assertIdentifier(input.currentStep, "currentStep", 256);
    const taskInput = assertJsonObject(input.input, "input");
    const result = input.result === null ? null : assertJsonObject(input.result, "result");
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const queryResult = await client.query<TaskStateRow>(
        `INSERT INTO agent_task (
           tenant_id, biz_domain, task_id, logical_agent_id, runtime_instance_id,
           session_id, task_type, status, current_step, input_json, result_json,
           last_active_at, checkpointed_at, unloaded_at, created_at, updated_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8::text, $9, $10::jsonb, $11::jsonb,
                $12::timestamptz,
                CASE WHEN $8::text IN ('CHECKPOINTED', 'UNLOADED')
                     THEN $12::timestamptz ELSE NULL END,
                CASE WHEN $8::text = 'UNLOADED'
                     THEN $12::timestamptz ELSE NULL END,
                $12::timestamptz, $12::timestamptz
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS runtime
             ON runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $5
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $4
         ON CONFLICT (tenant_id, biz_domain, task_id) DO UPDATE
           SET status = EXCLUDED.status,
               current_step = EXCLUDED.current_step,
               result_json = EXCLUDED.result_json,
               last_active_at = EXCLUDED.last_active_at,
               checkpointed_at = COALESCE(
                 agent_task.checkpointed_at, EXCLUDED.checkpointed_at
               ),
               unloaded_at = COALESCE(agent_task.unloaded_at, EXCLUDED.unloaded_at),
               updated_at = EXCLUDED.updated_at
         WHERE agent_task.logical_agent_id = EXCLUDED.logical_agent_id
           AND agent_task.runtime_instance_id = EXCLUDED.runtime_instance_id
           AND agent_task.session_id = EXCLUDED.session_id
         RETURNING ${TASK_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.taskId,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          taskType,
          input.status,
          currentStep,
          JSON.stringify(taskInput),
          result === null ? null : JSON.stringify(result),
          now,
        ],
      );
      return toTaskState(requiredRow(queryResult));
    });
  }

  public async findTaskState(input: FindTaskStateInput): Promise<TaskStateRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const taskId = assertIdentifier(input.taskId, "taskId", 128);
    return this.#withClient(async (client) => {
      const result = await client.query<TaskStateRow>(
        `SELECT ${TASK_COLUMNS}
           FROM agent_task
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND task_id = $3`,
        [scope.tenantId, scope.bizDomain, taskId],
      );
      const row = firstRow(result);
      return row === null ? null : toTaskState(row);
    });
  }

  public async listUnfinishedTasks(
    input: FindScopedRecordsInput,
  ): Promise<readonly TaskStateRecord[]> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const limit = assertLimit(input.limit);
    return this.#withClient(async (client) => {
      const result = await client.query<TaskStateRow>(
        `SELECT ${TASK_COLUMNS}
           FROM agent_task
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND status IN ('QUEUED', 'SPAWNING', 'RUNNING', 'WAITING_INPUT')
          ORDER BY last_active_at DESC, task_id
          LIMIT $4`,
        [scope.tenantId, scope.bizDomain, logicalAgentId, limit],
      );
      return result.rows.map(toTaskState);
    });
  }

  public async touchL2Activity(
    input: TaskPersistenceIdentity & { readonly now: Date },
  ): Promise<void> {
    const identity = identityValues(input);
    const now = assertDate(input.now, "now");
    await this.#withClient(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `UPDATE agent_task
            SET last_active_at = $7, updated_at = $7
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND runtime_instance_id = $4
            AND session_id = $5
            AND task_id = $6
        RETURNING task_id`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          now,
        ],
      );
      requiredRow(result);
    });
  }

  public async rebindTaskForRestore(
    input: TaskPersistenceIdentity & { readonly now: Date },
  ): Promise<TaskStateRecord> {
    const identity = identityValues(input);
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<TaskStateRow>(
        `UPDATE agent_task AS task
            SET runtime_instance_id = $4,
                session_id = $5,
                last_active_at = $7,
                unloaded_at = NULL,
                updated_at = $7
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS runtime
             ON runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $4
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
            AND task.tenant_id = agent.tenant_id
            AND task.biz_domain = agent.biz_domain
            AND task.logical_agent_id = agent.logical_agent_id
            AND task.task_id = $6
            AND task.status IN ('QUEUED', 'SPAWNING', 'RUNNING', 'WAITING_INPUT')
        RETURNING task.tenant_id, task.biz_domain, task.logical_agent_id,
                  task.runtime_instance_id, task.session_id, task.task_id,
                  task.task_type, task.status, task.current_step, task.input_json,
                  task.result_json, task.last_active_at, task.checkpointed_at,
                  task.unloaded_at, task.created_at, task.updated_at`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          now,
        ],
      );
      return toTaskState(requiredRow(result));
    });
  }

  public async touchL1Activity(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
    readonly runtimeInstanceId: string;
    readonly now: Date;
  }): Promise<void> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const runtimeInstanceId = assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId", 128);
    const now = assertDate(input.now, "now");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const runtimeResult = await client.query<Record<string, unknown>>(
        `UPDATE agent_runtime_instance AS runtime
            SET last_active_at = $5
           FROM tenant_biz_agent AS agent
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
            AND runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $4
        RETURNING runtime.runtime_instance_id`,
        [scope.tenantId, scope.bizDomain, logicalAgentId, runtimeInstanceId, now],
      );
      requiredRow(runtimeResult);
      const agentResult = await client.query<Record<string, unknown>>(
        `UPDATE tenant_biz_agent
            SET last_active_at = $4, updated_at = $4
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND current_runtime_instance_id = $5
        RETURNING logical_agent_id`,
        [scope.tenantId, scope.bizDomain, logicalAgentId, now, runtimeInstanceId],
      );
      requiredRow(agentResult);
      await client.query("COMMIT");
    } catch (error: unknown) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async saveMemory(input: SaveMemoryInput): Promise<MemoryRecord> {
    const identity = identityValues(input);
    const memoryId = this.#newId("memory_id");
    const dedupeKey = assertIdentifier(input.dedupeKey, "dedupeKey", 256);
    const memoryType = assertIdentifier(input.memoryType, "memoryType", 128);
    const [resourceType, resourceId] = assertResourcePair(input.resourceType, input.resourceId);
    const content = assertIdentifier(input.content, "content", 100_000);
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<MemoryRow>(
        `INSERT INTO agent_memory (
           tenant_id, biz_domain, memory_id, logical_agent_id, runtime_instance_id,
           session_id, task_id, dedupe_key, memory_type, resource_type, resource_id,
           content, created_at, updated_at
         )
         SELECT task.tenant_id, task.biz_domain, $7::uuid, task.logical_agent_id,
                task.runtime_instance_id, task.session_id, task.task_id, $8, $9,
                $10, $11, $12, $13::timestamptz, $13::timestamptz
           FROM agent_task AS task
          WHERE task.tenant_id = $1
            AND task.biz_domain = $2
            AND task.logical_agent_id = $3
            AND task.runtime_instance_id = $4
            AND task.session_id = $5
            AND task.task_id = $6
         ON CONFLICT (tenant_id, biz_domain, logical_agent_id, task_id, dedupe_key)
         DO UPDATE SET
           runtime_instance_id = EXCLUDED.runtime_instance_id,
           session_id = EXCLUDED.session_id,
           memory_type = EXCLUDED.memory_type,
           resource_type = EXCLUDED.resource_type,
           resource_id = EXCLUDED.resource_id,
           content = EXCLUDED.content,
           updated_at = EXCLUDED.updated_at
         RETURNING ${MEMORY_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          memoryId,
          dedupeKey,
          memoryType,
          resourceType,
          resourceId,
          content,
          now,
        ],
      );
      return toMemory(requiredRow(result));
    });
  }

  public async listMemories(input: FindScopedRecordsInput): Promise<readonly MemoryRecord[]> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const limit = assertLimit(input.limit);
    return this.#withClient(async (client) => {
      const result = await client.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS}
           FROM agent_memory
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
          ORDER BY created_at DESC, memory_id
          LIMIT $4`,
        [scope.tenantId, scope.bizDomain, logicalAgentId, limit],
      );
      return result.rows.map(toMemory);
    });
  }

  public async saveSessionSummary(input: SaveSessionSummaryInput): Promise<SessionSummaryRecord> {
    const identity = identityValues(input);
    const summaryId = this.#newId("summary_id");
    const summary = assertIdentifier(input.summary, "summary", 100_000);
    const transcriptPath = assertRelativeArtifactPath(input.transcriptPath, "transcriptPath");
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<SessionSummaryRow>(
        `INSERT INTO agent_session_summary (
           tenant_id, biz_domain, summary_id, logical_agent_id, runtime_instance_id,
           session_id, task_id, summary, transcript_path, created_at, updated_at
         )
         SELECT task.tenant_id, task.biz_domain, $7::uuid, task.logical_agent_id,
                task.runtime_instance_id, task.session_id, task.task_id, $8, $9,
                $10::timestamptz, $10::timestamptz
           FROM agent_task AS task
          WHERE task.tenant_id = $1
            AND task.biz_domain = $2
            AND task.logical_agent_id = $3
            AND task.runtime_instance_id = $4
            AND task.session_id = $5
            AND task.task_id = $6
         ON CONFLICT (tenant_id, biz_domain, logical_agent_id, session_id, task_id)
         DO UPDATE SET
           summary = EXCLUDED.summary,
           transcript_path = EXCLUDED.transcript_path,
           updated_at = EXCLUDED.updated_at
         RETURNING ${SUMMARY_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          summaryId,
          summary,
          transcriptPath,
          now,
        ],
      );
      return toSessionSummary(requiredRow(result));
    });
  }

  public async findLatestSessionSummary(
    input: FindScopedRecordsInput,
  ): Promise<SessionSummaryRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    return this.#withClient(async (client) => {
      const result = await client.query<SessionSummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}
           FROM agent_session_summary
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
          ORDER BY updated_at DESC, summary_id
          LIMIT 1`,
        [scope.tenantId, scope.bizDomain, logicalAgentId],
      );
      const row = firstRow(result);
      return row === null ? null : toSessionSummary(row);
    });
  }

  public async findTaskSessionSummary(
    input: FindTaskSessionSummaryInput,
  ): Promise<SessionSummaryRecord | null> {
    const identity = identityValues(input);
    return this.#withClient(async (client) => {
      const result = await client.query<SessionSummaryRow>(
        `SELECT ${SUMMARY_COLUMNS}
           FROM agent_session_summary
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND runtime_instance_id = $4
            AND session_id = $5
            AND task_id = $6
          ORDER BY updated_at DESC, summary_id
          LIMIT 1`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
        ],
      );
      const row = firstRow(result);
      return row === null ? null : toSessionSummary(row);
    });
  }

  public async appendTrace(input: AppendTraceInput): Promise<TraceIndexRecord> {
    const identity = identityValues(input);
    const traceEventId = this.#newId("trace_event_id");
    const traceId = assertIdentifier(input.traceId, "traceId", 128);
    const eventKey = assertIdentifier(input.eventKey, "eventKey", 256);
    const eventType = assertIdentifier(input.eventType, "eventType", 128);
    const reason = input.reason === null ? null : assertIdentifier(input.reason, "reason", 512);
    const event = assertJsonObject(input.event, "event");
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<TraceIndexRow>(
        `INSERT INTO agent_trace (
           tenant_id, biz_domain, trace_event_id, trace_id, logical_agent_id,
           runtime_instance_id, session_id, task_id, event_key, event_type,
           decision, reason, event_json, created_at
         )
         SELECT task.tenant_id, task.biz_domain, $7::uuid, $8, task.logical_agent_id,
                task.runtime_instance_id, task.session_id, task.task_id, $9, $10,
                $11, $12, $13::jsonb, $14::timestamptz
           FROM agent_task AS task
          WHERE task.tenant_id = $1
            AND task.biz_domain = $2
            AND task.logical_agent_id = $3
            AND task.runtime_instance_id = $4
            AND task.session_id = $5
            AND task.task_id = $6
         ON CONFLICT (tenant_id, biz_domain, task_id, event_key)
         DO UPDATE SET
           runtime_instance_id = EXCLUDED.runtime_instance_id,
           session_id = EXCLUDED.session_id,
           trace_id = EXCLUDED.trace_id,
           event_type = EXCLUDED.event_type,
           decision = EXCLUDED.decision,
           reason = EXCLUDED.reason,
           event_json = EXCLUDED.event_json
         RETURNING ${TRACE_INDEX_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          traceEventId,
          traceId,
          eventKey,
          eventType,
          input.decision,
          reason,
          JSON.stringify(event),
          now,
        ],
      );
      return toTraceIndex(requiredRow(result));
    });
  }

  public async listTraceIndex(input: FindScopedRecordsInput): Promise<readonly TraceIndexRecord[]> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const limit = assertLimit(input.limit);
    return this.#withClient(async (client) => {
      const result = await client.query<TraceIndexRow>(
        `SELECT ${TRACE_INDEX_COLUMNS}
           FROM agent_trace
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
          ORDER BY created_at DESC, trace_event_id
          LIMIT $4`,
        [scope.tenantId, scope.bizDomain, logicalAgentId, limit],
      );
      return result.rows.map(toTraceIndex);
    });
  }

  public async saveCheckpointArtifact(
    input: SaveCheckpointArtifactInput,
  ): Promise<CheckpointArtifactRecord> {
    const identity = identityValues(input);
    const checkpointId = this.#newId("checkpoint_id");
    const snapshotPath = assertRelativeArtifactPath(input.snapshotPath, "snapshotPath");
    const transcriptPath = assertRelativeArtifactPath(input.transcriptPath, "transcriptPath");
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<CheckpointArtifactRow>(
        `INSERT INTO agent_checkpoint_artifact (
           tenant_id, biz_domain, checkpoint_id, checkpoint_level, logical_agent_id,
           runtime_instance_id, session_id, task_id, snapshot_path, transcript_path,
           created_at, updated_at
         )
         SELECT task.tenant_id, task.biz_domain, $7::uuid, $8, task.logical_agent_id,
                task.runtime_instance_id, task.session_id, task.task_id, $9, $10,
                $11::timestamptz, $11::timestamptz
           FROM agent_task AS task
          WHERE task.tenant_id = $1
            AND task.biz_domain = $2
            AND task.logical_agent_id = $3
            AND task.runtime_instance_id = $4
            AND task.session_id = $5
            AND task.task_id = $6
         ON CONFLICT (
           tenant_id, biz_domain, logical_agent_id, runtime_instance_id, session_id,
           task_id, checkpoint_level
         ) DO UPDATE SET
           snapshot_path = EXCLUDED.snapshot_path,
           transcript_path = EXCLUDED.transcript_path,
           updated_at = EXCLUDED.updated_at
         RETURNING ${CHECKPOINT_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          checkpointId,
          input.checkpointLevel,
          snapshotPath,
          transcriptPath,
          now,
        ],
      );
      return toCheckpoint(requiredRow(result));
    });
  }

  public async saveL1CheckpointArtifact(
    input: SaveL1CheckpointArtifactInput,
  ): Promise<CheckpointArtifactRecord> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const runtimeInstanceId = assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId", 128);
    const checkpointId = this.#newId("checkpoint_id");
    const snapshotPath = assertRelativeArtifactPath(input.snapshotPath, "snapshotPath");
    const transcriptPath = assertRelativeArtifactPath(input.transcriptPath, "transcriptPath");
    const now = assertDate(input.now, "now");
    return this.#withClient(async (client) => {
      const result = await client.query<CheckpointArtifactRow>(
        `INSERT INTO agent_checkpoint_artifact (
           tenant_id, biz_domain, checkpoint_id, checkpoint_level, logical_agent_id,
           runtime_instance_id, session_id, task_id, snapshot_path, transcript_path,
           created_at, updated_at
         )
         SELECT agent.tenant_id, agent.biz_domain, $5::uuid, 'L1', agent.logical_agent_id,
                runtime.runtime_instance_id, NULL, NULL, $6, $7,
                $8::timestamptz, $8::timestamptz
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS runtime
             ON runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $4
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
         ON CONFLICT (
           tenant_id, biz_domain, logical_agent_id, runtime_instance_id, session_id,
           task_id, checkpoint_level
         ) DO UPDATE SET
           snapshot_path = EXCLUDED.snapshot_path,
           transcript_path = EXCLUDED.transcript_path,
           updated_at = EXCLUDED.updated_at
         RETURNING ${CHECKPOINT_COLUMNS}`,
        [
          scope.tenantId,
          scope.bizDomain,
          logicalAgentId,
          runtimeInstanceId,
          checkpointId,
          snapshotPath,
          transcriptPath,
          now,
        ],
      );
      return toCheckpoint(requiredRow(result));
    });
  }

  public async findLatestCheckpoint(
    input: FindScopedRecordsInput,
  ): Promise<CheckpointArtifactRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    return this.#withClient(async (client) => {
      const result = await client.query<CheckpointArtifactRow>(
        `SELECT ${CHECKPOINT_COLUMNS}
           FROM agent_checkpoint_artifact
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
          ORDER BY updated_at DESC, checkpoint_id
          LIMIT 1`,
        [scope.tenantId, scope.bizDomain, logicalAgentId],
      );
      const row = firstRow(result);
      return row === null ? null : toCheckpoint(row);
    });
  }

  public async findToolCompletion(
    input: ToolCompletionLookupKey,
  ): Promise<ToolCompletionRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const taskId = assertIdentifier(input.taskId, "taskId", 128);
    const key = this.#toolKey(input);
    return this.#withClient(async (client) => {
      const result = await client.query<ToolCompletionRow>(
        `SELECT ${TOOL_COMPLETION_COLUMNS}
           FROM demo_tool_completion_marker
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND logical_agent_id = $3
            AND task_id = $4
            AND tool_name = $5
            AND action = $6
            AND resource_type = $7
            AND resource_id = $8`,
        [
          scope.tenantId,
          scope.bizDomain,
          logicalAgentId,
          taskId,
          key.toolName,
          key.action,
          key.resourceType,
          key.resourceId,
        ],
      );
      const row = firstRow(result);
      return row === null ? null : toToolCompletion(row);
    });
  }

  public async recordToolCompletion(
    input: RecordToolCompletionInput,
  ): Promise<RecordToolCompletionResult> {
    const identity = identityValues(input);
    const key = this.#toolKey(input);
    const markerId = this.#newId("marker_id");
    const resultJson = assertJsonObject(input.result, "result");
    const completedAt = assertDate(input.completedAt, "completedAt");
    const inserted = await this.#withClient(async (client) => {
      const result = await client.query<ToolCompletionRow>(
        `INSERT INTO demo_tool_completion_marker (
           tenant_id, biz_domain, marker_id, logical_agent_id, runtime_instance_id,
           session_id, task_id, tool_name, action, resource_type, resource_id,
           result_json, completed_at
         )
         SELECT task.tenant_id, task.biz_domain, $7::uuid, task.logical_agent_id,
                task.runtime_instance_id, task.session_id, task.task_id, $8, $9,
                $10, $11, $12::jsonb, $13::timestamptz
           FROM agent_task AS task
          WHERE task.tenant_id = $1
            AND task.biz_domain = $2
            AND task.logical_agent_id = $3
            AND task.runtime_instance_id = $4
            AND task.session_id = $5
            AND task.task_id = $6
         ON CONFLICT (
           tenant_id, biz_domain, task_id, tool_name, action, resource_type, resource_id
         ) DO NOTHING
         RETURNING ${TOOL_COMPLETION_COLUMNS}`,
        [
          identity.tenantId,
          identity.bizDomain,
          identity.logicalAgentId,
          identity.runtimeInstanceId,
          identity.sessionId,
          identity.taskId,
          markerId,
          key.toolName,
          key.action,
          key.resourceType,
          key.resourceId,
          JSON.stringify(resultJson),
          completedAt,
        ],
      );
      const row = firstRow(result);
      return row === null ? null : toToolCompletion(row);
    });
    if (inserted !== null) {
      return { record: inserted, created: true };
    }
    const existing = await this.findToolCompletion(input);
    if (existing === null) {
      throw new Phase5ScopeError();
    }
    return { record: existing, created: false };
  }

  public async loadRestoreBundle(input: LoadRestoreBundleInput): Promise<RestoreBundle> {
    const scope = normalizeTenantBizScope(input.scope);
    const logicalAgentId = assertLogicalAgentId(input.logicalAgentId);
    const limit = assertLimit(input.limit);
    const scopedInput = { scope, logicalAgentId, limit };
    const [
      previousRuntimeInstanceId,
      latestSessionSummary,
      memories,
      traceIndex,
      unfinishedTasks,
      latestCheckpoint,
    ] = await Promise.all([
      this.#findPreviousRuntimeInstanceId(scope, logicalAgentId),
      this.findLatestSessionSummary(scopedInput),
      this.listMemories(scopedInput),
      this.listTraceIndex(scopedInput),
      this.listUnfinishedTasks(scopedInput),
      this.findLatestCheckpoint(scopedInput),
    ]);
    return {
      previousRuntimeInstanceId,
      latestSessionSummary,
      memories,
      traceIndex,
      unfinishedTasks,
      latestCheckpoint,
    };
  }

  async #findPreviousRuntimeInstanceId(
    scope: TenantBizScope,
    logicalAgentId: string,
  ): Promise<string | null> {
    return this.#withClient(async (client) => {
      const result = await client.query<PreviousRuntimeRow>(
        `SELECT CASE
                  WHEN current_runtime.status = 'UNLOADED'
                    THEN current_runtime.runtime_instance_id
                  ELSE previous_runtime.runtime_instance_id
                END AS runtime_instance_id
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS current_runtime
             ON current_runtime.logical_agent_id = agent.logical_agent_id
            AND current_runtime.runtime_instance_id = agent.current_runtime_instance_id
           LEFT JOIN agent_runtime_instance AS previous_runtime
             ON previous_runtime.logical_agent_id = current_runtime.logical_agent_id
            AND previous_runtime.runtime_instance_id =
                current_runtime.restored_from_runtime_instance_id
            AND previous_runtime.status = 'UNLOADED'
          WHERE agent.tenant_id = $1
            AND agent.biz_domain = $2
            AND agent.logical_agent_id = $3
            AND (
              current_runtime.status = 'UNLOADED'
              OR (
                current_runtime.status IN ('PROVISIONING', 'ACTIVE', 'IDLE')
                AND previous_runtime.runtime_instance_id IS NOT NULL
              )
            )
          LIMIT 1`,
        [scope.tenantId, scope.bizDomain, logicalAgentId],
      );
      const row = firstRow(result);
      return row === null ? null : readString(row.runtime_instance_id, "runtime_instance_id");
    });
  }

  #newId(field: string): string {
    const value = this.#createId().trim().toLowerCase();
    if (!UUID.test(value)) {
      throw new TypeError(`${field} factory must return a UUID`);
    }
    return value;
  }

  #toolKey(input: ToolCompletionLookupKey): {
    readonly toolName: string;
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId: string;
  } {
    return {
      toolName: assertIdentifier(input.toolName, "toolName", 128),
      action: assertIdentifier(input.action, "action", 64),
      resourceType: assertIdentifier(input.resourceType, "resourceType", 64),
      resourceId: assertIdentifier(input.resourceId, "resourceId", 128),
    };
  }

  async #withClient<TResult>(
    operation: (client: PostgresClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.#pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }
}
