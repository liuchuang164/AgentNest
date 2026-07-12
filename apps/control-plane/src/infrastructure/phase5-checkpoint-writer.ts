import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

import { intersectForTask, type TenantCapabilityCatalog } from "@agentnest/capability";
import {
  CheckpointLevel,
  type CheckpointArtifactRecord,
  type CheckpointJsonObject,
  type CheckpointJsonValue,
  type LocalCheckpointReceipt,
  type LocalCheckpointSnapshot,
  type LocalCheckpointVolume,
  type LocalL1CheckpointReceipt,
  type MemoryRecord,
  type PostgresPhase5PersistenceRepository,
  type RestoreBundle,
  type TaskStateRecord,
  type TraceIndexRecord,
} from "@agentnest/persistence";

import type {
  L1LifecycleRecord,
  L2LifecycleRecord,
  LifecycleCheckpointWriter,
} from "../application/lifecycle-reaper.js";

export interface CapturedL1Checkpoint {
  readonly scope: L1LifecycleRecord["scope"];
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly transcript: string;
  readonly snapshot: LocalCheckpointSnapshot;
}

export interface CapturedL2Checkpoint extends CapturedL1Checkpoint {
  readonly sessionId: string;
  readonly taskId: string;
}

/**
 * Supplies the current Transcript plus only the compact state needed for a
 * later restore. The Transcript remains a volume artifact and is never part of
 * the state restored into a new runtime.
 */
export interface CheckpointCaptureSource {
  captureL1(record: L1LifecycleRecord, checkpointedAt: Date): Promise<CapturedL1Checkpoint>;
  captureL2(record: L2LifecycleRecord, checkpointedAt: Date): Promise<CapturedL2Checkpoint>;
}

export type CheckpointCaptureRepository = Pick<
  PostgresPhase5PersistenceRepository,
  | "findTaskSessionSummary"
  | "findTaskState"
  | "listMemories"
  | "listTraceIndex"
  | "loadRestoreBundle"
>;

export interface CheckpointTranscriptSource {
  readL1Transcript(record: L1LifecycleRecord): Promise<string>;
  readL2Transcript(record: L2LifecycleRecord): Promise<string>;
}

export interface CheckpointCapabilitySummarySource {
  loadL1CapabilitySummary(record: L1LifecycleRecord): Promise<CheckpointJsonObject>;
  loadL2CapabilitySummary(record: L2LifecycleRecord): Promise<CheckpointJsonObject>;
}

export class CatalogCheckpointCapabilitySummarySource implements CheckpointCapabilitySummarySource {
  public constructor(
    private readonly catalog: TenantCapabilityCatalog,
    private readonly persistence: Pick<PostgresPhase5PersistenceRepository, "findTaskState">,
  ) {}

  public async loadL1CapabilitySummary(record: L1LifecycleRecord): Promise<CheckpointJsonObject> {
    const profile = await this.catalog.resolveProfile(record.scope);
    if (
      profile.tenant_id !== record.scope.tenantId ||
      profile.biz_domain !== record.scope.bizDomain
    ) {
      throw new Phase5CheckpointWriterError(
        "Capability Profile does not match the requested tenant/business agent",
      );
    }
    return checkpointJsonObject(
      {
        profile_id: profile.profile_id,
        version: profile.version,
        skills: profile.skills,
        tools: profile.tools,
        memory_scopes: profile.memory_scopes,
        lifecycle: profile.lifecycle,
      },
      "L1 current capability summary",
    );
  }

  public async loadL2CapabilitySummary(record: L2LifecycleRecord): Promise<CheckpointJsonObject> {
    const task = await this.persistence.findTaskState({
      scope: record.scope,
      taskId: record.taskId,
    });
    if (task === null) {
      throw new Phase5CheckpointWriterError("L2 Capability TaskState is missing");
    }
    assertTaskOwnedRecord(task, record, "L2 Capability TaskState");
    const [profile, template] = await Promise.all([
      this.catalog.resolveProfile(record.scope),
      this.catalog.resolveTaskTemplate(task.taskType),
    ]);
    if (
      profile.tenant_id !== record.scope.tenantId ||
      profile.biz_domain !== record.scope.bizDomain
    ) {
      throw new Phase5CheckpointWriterError(
        "Capability Profile does not match the requested tenant/business agent",
      );
    }
    const effective = intersectForTask(profile, template);
    return checkpointJsonObject(
      {
        profile_id: profile.profile_id,
        profile_version: profile.version,
        task_type: task.taskType,
        skills: effective.skills,
        tools: effective.tools,
        memory_scopes: effective.memoryScopes,
      },
      "L2 current capability summary",
    );
  }
}

export interface CheckpointSessionSummarySource {
  /** Captures an L1-only runtime summary when no task-backed DB summary exists. */
  loadL1SessionSummary(record: L1LifecycleRecord): Promise<string>;
}

export type LifecycleCheckpointVolume = Pick<LocalCheckpointVolume, "checkpoint" | "checkpointL1">;

export type LifecycleCheckpointArtifactRepository = Pick<
  PostgresPhase5PersistenceRepository,
  "saveCheckpointArtifact" | "saveL1CheckpointArtifact"
>;

export interface Phase5LifecycleCheckpointWriterOptions {
  readonly volumeRoot: string;
}

export class Phase5CheckpointWriterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Phase5CheckpointWriterError";
  }
}

interface ScopedLogicalRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
}

interface TaskOwnedRecord extends ScopedLogicalRecord {
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
}

function sameScope(first: L1LifecycleRecord["scope"], second: L1LifecycleRecord["scope"]): boolean {
  return first.tenantId === second.tenantId && first.bizDomain === second.bizDomain;
}

function assertScopedLogicalRecord(
  persisted: ScopedLogicalRecord,
  record: Pick<L1LifecycleRecord, "scope" | "logicalAgentId">,
  label: string,
): void {
  if (
    persisted.tenantId !== record.scope.tenantId ||
    persisted.bizDomain !== record.scope.bizDomain ||
    persisted.logicalAgentId !== record.logicalAgentId
  ) {
    throw new Phase5CheckpointWriterError(
      `${label} does not match the requested tenant/business agent`,
    );
  }
}

function assertTaskOwnedRecord(
  persisted: TaskOwnedRecord,
  record: L2LifecycleRecord,
  label: string,
): void {
  assertScopedLogicalRecord(persisted, record, label);
  if (
    persisted.runtimeInstanceId !== record.runtimeInstanceId ||
    persisted.sessionId !== record.sessionId ||
    persisted.taskId !== record.taskId
  ) {
    throw new Phase5CheckpointWriterError(`${label} does not match the requested L2 task`);
  }
}

function checkpointJsonValue(
  value: unknown,
  label: string,
  seen: WeakSet<object> = new WeakSet<object>(),
): CheckpointJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Phase5CheckpointWriterError(`${label} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Phase5CheckpointWriterError(`${label} contains a non-JSON value`);
  }
  if (seen.has(value)) {
    throw new Phase5CheckpointWriterError(`${label} contains a cycle`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) =>
      checkpointJsonValue(item, `${label}[${String(index)}]`, seen),
    );
    seen.delete(value);
    return result;
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Phase5CheckpointWriterError(`${label} must contain only plain JSON objects`);
  }
  const result: Record<string, CheckpointJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = checkpointJsonValue(item, `${label}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function checkpointJsonObject(value: unknown, label: string): CheckpointJsonObject {
  const result = checkpointJsonValue(value, label);
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new Phase5CheckpointWriterError(`${label} must be a JSON object`);
  }
  return result as CheckpointJsonObject;
}

function taskStateSnapshot(task: TaskStateRecord): CheckpointJsonObject {
  return {
    task_id: task.taskId,
    session_id: task.sessionId,
    task_type: task.taskType,
    status: task.status,
    current_step: task.currentStep,
    input: checkpointJsonObject(task.input, `TaskState ${task.taskId} input`),
    result:
      task.result === null
        ? null
        : checkpointJsonObject(task.result, `TaskState ${task.taskId} result`),
    last_active_at: task.lastActiveAt.toISOString(),
  };
}

function memorySnapshot(memory: MemoryRecord): CheckpointJsonObject {
  return {
    memory_id: memory.memoryId,
    session_id: memory.sessionId,
    task_id: memory.taskId,
    memory_type: memory.memoryType,
    resource_type: memory.resourceType,
    resource_id: memory.resourceId,
    content: memory.content,
    updated_at: memory.updatedAt.toISOString(),
  };
}

function traceSnapshot(trace: TraceIndexRecord): CheckpointJsonObject {
  return {
    trace_event_id: trace.traceEventId,
    trace_id: trace.traceId,
    session_id: trace.sessionId,
    task_id: trace.taskId,
    event_type: trace.eventType,
    decision: trace.decision,
    reason: trace.reason,
    created_at: trace.createdAt.toISOString(),
  };
}

function assertCheckpointedAt(checkpointedAt: Date): void {
  if (!(checkpointedAt instanceof Date) || Number.isNaN(checkpointedAt.getTime())) {
    throw new Phase5CheckpointWriterError("checkpointedAt must be a valid Date");
  }
}

function assertL1Bundle(bundle: RestoreBundle, record: L1LifecycleRecord): void {
  if (bundle.latestSessionSummary !== null) {
    assertScopedLogicalRecord(bundle.latestSessionSummary, record, "L1 Session Summary");
  }
  for (const memory of bundle.memories) {
    assertScopedLogicalRecord(memory, record, "L1 Memory");
  }
  for (const trace of bundle.traceIndex) {
    assertScopedLogicalRecord(trace, record, "L1 Trace");
  }
  for (const task of bundle.unfinishedTasks) {
    assertScopedLogicalRecord(task, record, "L1 TaskState");
  }
}

function matchingTaskHistory<TRecord extends TaskOwnedRecord>(
  records: readonly TRecord[],
  record: L2LifecycleRecord,
  label: string,
): readonly TRecord[] {
  for (const persisted of records) {
    assertScopedLogicalRecord(persisted, record, label);
  }
  return records.filter((persisted) => persisted.taskId === record.taskId);
}

/**
 * Concrete capture source backed by the Phase 5 PostgreSQL read model. L2
 * state is reduced to the exact task identity; L1 state uses the repository's
 * restore bundle. Transcript bytes remain separate from the compact Snapshot.
 */
export class PostgresCheckpointCaptureSource implements CheckpointCaptureSource {
  public constructor(
    private readonly persistence: CheckpointCaptureRepository,
    private readonly transcripts: CheckpointTranscriptSource,
    private readonly capabilities: CheckpointCapabilitySummarySource,
    private readonly sessionSummaries: CheckpointSessionSummarySource,
  ) {}

  public async captureL1(
    record: L1LifecycleRecord,
    checkpointedAt: Date,
  ): Promise<CapturedL1Checkpoint> {
    assertCheckpointedAt(checkpointedAt);
    const bundle = await this.persistence.loadRestoreBundle({
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
    });
    assertL1Bundle(bundle, record);
    const sessionSummary =
      bundle.latestSessionSummary === null
        ? await this.sessionSummaries.loadL1SessionSummary(record)
        : bundle.latestSessionSummary.summary;
    if (sessionSummary.length === 0) {
      throw new Phase5CheckpointWriterError("L1 checkpoint Session Summary is missing");
    }
    const [transcript, capabilitySummary] = await Promise.all([
      this.transcripts.readL1Transcript(record),
      this.capabilities.loadL1CapabilitySummary(record),
    ]);

    return {
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      transcript,
      snapshot: {
        sessionSummary,
        memories: bundle.memories.map(memorySnapshot),
        traceIndex: bundle.traceIndex.map(traceSnapshot),
        taskState:
          bundle.unfinishedTasks.length === 0
            ? null
            : {
                unfinished_tasks: bundle.unfinishedTasks.map(taskStateSnapshot),
              },
        result: null,
        capabilitySummary: checkpointJsonObject(capabilitySummary, "L1 capability summary"),
      },
    };
  }

  public async captureL2(
    record: L2LifecycleRecord,
    checkpointedAt: Date,
  ): Promise<CapturedL2Checkpoint> {
    assertCheckpointedAt(checkpointedAt);
    const scopedInput = {
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
    } as const;
    const [task, latestSummary, allMemories, allTrace] = await Promise.all([
      this.persistence.findTaskState({ scope: record.scope, taskId: record.taskId }),
      this.persistence.findTaskSessionSummary({
        scope: record.scope,
        logicalAgentId: record.logicalAgentId,
        runtimeInstanceId: record.runtimeInstanceId,
        sessionId: record.sessionId,
        taskId: record.taskId,
      }),
      this.persistence.listMemories(scopedInput),
      this.persistence.listTraceIndex(scopedInput),
    ]);
    if (task === null) {
      throw new Phase5CheckpointWriterError("L2 checkpoint TaskState is missing");
    }
    assertTaskOwnedRecord(task, record, "L2 TaskState");
    if (task.status !== record.status) {
      throw new Phase5CheckpointWriterError(
        "L2 TaskState status does not match the lifecycle record",
      );
    }
    if (latestSummary === null) {
      throw new Phase5CheckpointWriterError("L2 checkpoint Session Summary is missing");
    }
    assertTaskOwnedRecord(latestSummary, record, "L2 Session Summary");
    const memories = matchingTaskHistory(allMemories, record, "Memory");
    const traceIndex = matchingTaskHistory(allTrace, record, "Trace");
    const [transcript, capabilitySummary] = await Promise.all([
      this.transcripts.readL2Transcript(record),
      this.capabilities.loadL2CapabilitySummary(record),
    ]);

    return {
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      sessionId: record.sessionId,
      taskId: record.taskId,
      transcript,
      snapshot: {
        sessionSummary: latestSummary.summary,
        memories: memories.map(memorySnapshot),
        traceIndex: traceIndex.map(traceSnapshot),
        taskState: taskStateSnapshot(task),
        result:
          task.result === null
            ? null
            : checkpointJsonObject(task.result, `TaskState ${task.taskId} result`),
        capabilitySummary: checkpointJsonObject(capabilitySummary, "L2 capability summary"),
      },
    };
  }
}

function assertL1CaptureIdentity(
  capture: CapturedL1Checkpoint,
  record: Pick<L1LifecycleRecord, "scope" | "logicalAgentId" | "runtimeInstanceId">,
): void {
  if (
    !sameScope(capture.scope, record.scope) ||
    capture.logicalAgentId !== record.logicalAgentId ||
    capture.runtimeInstanceId !== record.runtimeInstanceId
  ) {
    throw new Phase5CheckpointWriterError(
      "captured L1 checkpoint identity does not match the lifecycle record",
    );
  }
}

function assertL2CaptureIdentity(capture: CapturedL2Checkpoint, record: L2LifecycleRecord): void {
  assertL1CaptureIdentity(capture, record);
  if (capture.sessionId !== record.sessionId || capture.taskId !== record.taskId) {
    throw new Phase5CheckpointWriterError(
      "captured L2 checkpoint identity does not match the lifecycle record",
    );
  }
}

function assertL1ReceiptIdentity(
  receipt: LocalL1CheckpointReceipt,
  record: L1LifecycleRecord,
): void {
  if (
    receipt.logicalAgentId !== record.logicalAgentId ||
    receipt.runtimeInstanceId !== record.runtimeInstanceId
  ) {
    throw new Phase5CheckpointWriterError(
      "L1 checkpoint volume returned an artifact for a different runtime",
    );
  }
}

function assertL2ReceiptIdentity(receipt: LocalCheckpointReceipt, record: L2LifecycleRecord): void {
  if (
    receipt.logicalAgentId !== record.logicalAgentId ||
    receipt.runtimeInstanceId !== record.runtimeInstanceId ||
    receipt.sessionId !== record.sessionId ||
    receipt.taskId !== record.taskId
  ) {
    throw new Phase5CheckpointWriterError(
      "L2 checkpoint volume returned an artifact for a different task",
    );
  }
}

function assertL1ArtifactIdentity(
  artifact: CheckpointArtifactRecord,
  record: L1LifecycleRecord,
): void {
  if (
    artifact.checkpointLevel !== CheckpointLevel.L1 ||
    artifact.tenantId !== record.scope.tenantId ||
    artifact.bizDomain !== record.scope.bizDomain ||
    artifact.logicalAgentId !== record.logicalAgentId ||
    artifact.runtimeInstanceId !== record.runtimeInstanceId ||
    artifact.sessionId !== null ||
    artifact.taskId !== null
  ) {
    throw new Phase5CheckpointWriterError(
      "persistence returned an L1 checkpoint outside the requested runtime",
    );
  }
}

function assertL2ArtifactIdentity(
  artifact: CheckpointArtifactRecord,
  record: L2LifecycleRecord,
): void {
  if (
    artifact.checkpointLevel !== CheckpointLevel.L2 ||
    artifact.tenantId !== record.scope.tenantId ||
    artifact.bizDomain !== record.scope.bizDomain ||
    artifact.logicalAgentId !== record.logicalAgentId ||
    artifact.runtimeInstanceId !== record.runtimeInstanceId ||
    artifact.sessionId !== record.sessionId ||
    artifact.taskId !== record.taskId
  ) {
    throw new Phase5CheckpointWriterError(
      "persistence returned an L2 checkpoint outside the requested task",
    );
  }
}

/**
 * Writes the local volume first and records its safe relative artifact
 * references in PostgreSQL second. A rejection from capture, volume, or
 * PostgreSQL is deliberately propagated so LifecycleReaper cannot unload or
 * mark the runtime UNLOADED.
 */
export class Phase5LifecycleCheckpointWriter implements LifecycleCheckpointWriter {
  readonly #volumeRoot: string;

  public constructor(
    private readonly captureSource: CheckpointCaptureSource,
    private readonly volume: LifecycleCheckpointVolume,
    private readonly persistence: LifecycleCheckpointArtifactRepository,
    options: Phase5LifecycleCheckpointWriterOptions,
  ) {
    if (options.volumeRoot.trim() === "") {
      throw new TypeError("checkpoint volume root must not be empty");
    }
    this.#volumeRoot = resolve(options.volumeRoot);
  }

  public async checkpointL1(record: L1LifecycleRecord, checkpointedAt: Date): Promise<void> {
    const capture = await this.captureSource.captureL1(record, checkpointedAt);
    assertL1CaptureIdentity(capture, record);

    const receipt = await this.volume.checkpointL1({
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      checkpointedAt,
      transcript: capture.transcript,
      snapshot: capture.snapshot,
    });
    assertL1ReceiptIdentity(receipt, record);

    const artifact = await this.persistence.saveL1CheckpointArtifact({
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      snapshotPath: await this.relativeArtifactPath(receipt.snapshot.path),
      transcriptPath: await this.relativeArtifactPath(receipt.transcript.path),
      now: checkpointedAt,
    });
    assertL1ArtifactIdentity(artifact, record);
  }

  public async checkpointL2(record: L2LifecycleRecord, checkpointedAt: Date): Promise<void> {
    const capture = await this.captureSource.captureL2(record, checkpointedAt);
    assertL2CaptureIdentity(capture, record);

    const receipt = await this.volume.checkpoint({
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      sessionId: record.sessionId,
      taskId: record.taskId,
      checkpointedAt,
      transcript: capture.transcript,
      snapshot: capture.snapshot,
    });
    assertL2ReceiptIdentity(receipt, record);

    const artifact = await this.persistence.saveCheckpointArtifact({
      scope: record.scope,
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      sessionId: record.sessionId,
      taskId: record.taskId,
      checkpointLevel: CheckpointLevel.L2,
      snapshotPath: await this.relativeArtifactPath(receipt.snapshot.path),
      transcriptPath: await this.relativeArtifactPath(receipt.transcript.path),
      now: checkpointedAt,
    });
    assertL2ArtifactIdentity(artifact, record);
  }

  private async relativeArtifactPath(artifactPath: string): Promise<string> {
    const canonicalRoot = await realpath(this.#volumeRoot);
    const absoluteArtifactPath = resolve(artifactPath);
    const fromRoot = relative(canonicalRoot, absoluteArtifactPath);
    if (
      fromRoot === "" ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Phase5CheckpointWriterError(
        "checkpoint artifact is outside the configured volume root",
      );
    }
    return fromRoot.split(sep).join("/");
  }
}
