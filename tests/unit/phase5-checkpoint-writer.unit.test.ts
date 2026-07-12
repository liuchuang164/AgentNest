import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import type { TaskTemplate, TenantCapabilityCatalog } from "@agentnest/capability";
import { L1RuntimeStatus, L2TaskStatus } from "@agentnest/contracts";
import {
  CheckpointLevel,
  LocalCheckpointVolume,
  PersistedTraceDecision,
  type CheckpointArtifactRecord,
  type FindScopedRecordsInput,
  type FindTaskSessionSummaryInput,
  type FindTaskStateInput,
  type LoadRestoreBundleInput,
  type LocalArtifactReference,
  type LocalCheckpointReceipt,
  type LocalL1CheckpointReceipt,
  type MemoryRecord,
  type RestoreBundle,
  type SaveCheckpointArtifactInput,
  type SaveL1CheckpointArtifactInput,
  type SaveLocalCheckpointInput,
  type SaveLocalL1CheckpointInput,
  type SessionSummaryRecord,
  type TaskStateRecord,
  type TraceIndexRecord,
} from "@agentnest/persistence";
import { afterEach, describe, expect, it } from "vitest";

import type {
  L1LifecycleRecord,
  L2LifecycleRecord,
} from "../../apps/control-plane/src/application/lifecycle-reaper.js";
import {
  CatalogCheckpointCapabilitySummarySource,
  Phase5LifecycleCheckpointWriter,
  PostgresCheckpointCaptureSource,
  type CapturedL1Checkpoint,
  type CapturedL2Checkpoint,
  type CheckpointCapabilitySummarySource,
  type CheckpointCaptureRepository,
  type CheckpointCaptureSource,
  type CheckpointSessionSummarySource,
  type CheckpointTranscriptSource,
  type LifecycleCheckpointArtifactRepository,
  type LifecycleCheckpointVolume,
} from "../../apps/control-plane/src/infrastructure/phase5-checkpoint-writer.js";

const CHECKPOINTED_AT = new Date("2026-07-12T02:00:00.000Z");
const LAST_ACTIVE_AT = new Date("2026-07-11T00:00:00.000Z");
const LOGICAL_AGENT_ID = "tb_9fa3d61c2d63ee4285ee";
const temporaryRoots: string[] = [];

const l1Record: L1LifecycleRecord = {
  scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
  logicalAgentId: LOGICAL_AGENT_ID,
  runtimeInstanceId: "ari_legal_001",
  status: L1RuntimeStatus.IDLE,
  lastActiveAt: LAST_ACTIVE_AT,
};

const l2Record: L2LifecycleRecord = {
  ...l1Record,
  sessionId: "agent:l2_legal:subagent:session_001",
  taskId: "task_legal_001",
  status: L2TaskStatus.COMPLETED,
};

function l1Capture(overrides: Partial<CapturedL1Checkpoint> = {}): CapturedL1Checkpoint {
  return {
    scope: l1Record.scope,
    logicalAgentId: l1Record.logicalAgentId,
    runtimeInstanceId: l1Record.runtimeInstanceId,
    transcript: '{"role":"assistant","content":"tenant runtime checkpoint"}\n',
    snapshot: {
      sessionSummary: "tenant A legal runtime summary",
      memories: [{ memory_type: "case_note", content: "ALPHA_LEGAL_MEMORY" }],
      traceIndex: [{ trace_id: "trace_l1", decision: "ALLOW" }],
      taskState: null,
      result: null,
      capabilitySummary: { skills: ["legal-evidence-check"], tools: ["legal_case_read"] },
    },
    ...overrides,
  };
}

function l2Capture(overrides: Partial<CapturedL2Checkpoint> = {}): CapturedL2Checkpoint {
  return {
    ...l1Capture(),
    sessionId: l2Record.sessionId,
    taskId: l2Record.taskId,
    transcript: '{"role":"assistant","content":"case task completed"}\n',
    snapshot: {
      sessionSummary: "case_001 evidence task completed",
      memories: [{ memory_type: "case_note", content: "ALPHA_LEGAL_MEMORY" }],
      traceIndex: [{ trace_id: "trace_l2", decision: "ALLOW" }],
      taskState: { status: "COMPLETED", current_step: "done" },
      result: { case_id: "case_001", finding: "ready" },
      capabilitySummary: { skills: ["legal-evidence-check"], tools: ["legal_case_read"] },
    },
    ...overrides,
  };
}

class RecordingCaptureSource implements CheckpointCaptureSource {
  public l1 = l1Capture();
  public l2 = l2Capture();
  public l1Failure: Error | null = null;
  public l2Failure: Error | null = null;
  public l1Calls = 0;
  public l2Calls = 0;

  public captureL1(): Promise<CapturedL1Checkpoint> {
    this.l1Calls += 1;
    if (this.l1Failure !== null) {
      return Promise.reject(this.l1Failure);
    }
    return Promise.resolve(this.l1);
  }

  public captureL2(): Promise<CapturedL2Checkpoint> {
    this.l2Calls += 1;
    if (this.l2Failure !== null) {
      return Promise.reject(this.l2Failure);
    }
    return Promise.resolve(this.l2);
  }
}

function taskState(overrides: Partial<TaskStateRecord> = {}): TaskStateRecord {
  return {
    tenantId: l2Record.scope.tenantId,
    bizDomain: l2Record.scope.bizDomain,
    logicalAgentId: l2Record.logicalAgentId,
    runtimeInstanceId: l2Record.runtimeInstanceId,
    sessionId: l2Record.sessionId,
    taskId: l2Record.taskId,
    taskType: "LEGAL_EVIDENCE_CHECK",
    status: l2Record.status,
    currentStep: "done",
    input: { resource_id: "case_001" },
    result: { finding: "ready" },
    lastActiveAt: LAST_ACTIVE_AT,
    checkpointedAt: null,
    unloadedAt: null,
    createdAt: LAST_ACTIVE_AT,
    updatedAt: CHECKPOINTED_AT,
    ...overrides,
  };
}

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    tenantId: l2Record.scope.tenantId,
    bizDomain: l2Record.scope.bizDomain,
    logicalAgentId: l2Record.logicalAgentId,
    runtimeInstanceId: l2Record.runtimeInstanceId,
    sessionId: l2Record.sessionId,
    taskId: l2Record.taskId,
    memoryId: "00000000-0000-4000-8000-000000000010",
    dedupeKey: "case-result",
    memoryType: "RESOURCE_MEMORY",
    resourceType: "CASE",
    resourceId: "case_001",
    content: "ALPHA_LEGAL_MEMORY",
    createdAt: LAST_ACTIVE_AT,
    updatedAt: CHECKPOINTED_AT,
    ...overrides,
  };
}

function sessionSummary(overrides: Partial<SessionSummaryRecord> = {}): SessionSummaryRecord {
  return {
    tenantId: l2Record.scope.tenantId,
    bizDomain: l2Record.scope.bizDomain,
    logicalAgentId: l2Record.logicalAgentId,
    runtimeInstanceId: l2Record.runtimeInstanceId,
    sessionId: l2Record.sessionId,
    taskId: l2Record.taskId,
    summaryId: "00000000-0000-4000-8000-000000000011",
    summary: "case_001 evidence task completed",
    transcriptPath: "sessions/task_legal_001.jsonl",
    createdAt: LAST_ACTIVE_AT,
    updatedAt: CHECKPOINTED_AT,
    ...overrides,
  };
}

function trace(overrides: Partial<TraceIndexRecord> = {}): TraceIndexRecord {
  return {
    tenantId: l2Record.scope.tenantId,
    bizDomain: l2Record.scope.bizDomain,
    logicalAgentId: l2Record.logicalAgentId,
    runtimeInstanceId: l2Record.runtimeInstanceId,
    sessionId: l2Record.sessionId,
    taskId: l2Record.taskId,
    traceEventId: "00000000-0000-4000-8000-000000000012",
    traceId: "trace_l2",
    eventKey: "task-complete",
    eventType: "TASK_COMPLETED",
    decision: PersistedTraceDecision.ALLOW,
    reason: "DEMO_COMPLETE",
    createdAt: CHECKPOINTED_AT,
    ...overrides,
  };
}

function restoreBundle(overrides: Partial<RestoreBundle> = {}): RestoreBundle {
  return {
    previousRuntimeInstanceId: null,
    latestSessionSummary: sessionSummary(),
    memories: [memory()],
    traceIndex: [trace()],
    unfinishedTasks: [],
    latestCheckpoint: null,
    ...overrides,
  };
}

class RecordingCaptureRepository implements CheckpointCaptureRepository {
  public task: TaskStateRecord | null = taskState();
  public summary: SessionSummaryRecord | null = sessionSummary();
  public memories: readonly MemoryRecord[] = [memory()];
  public traceIndex: readonly TraceIndexRecord[] = [trace()];
  public bundle: RestoreBundle = restoreBundle();
  public readonly taskInputs: FindTaskStateInput[] = [];
  public readonly scopedInputs: FindScopedRecordsInput[] = [];
  public readonly bundleInputs: LoadRestoreBundleInput[] = [];

  public findTaskState(input: FindTaskStateInput): Promise<TaskStateRecord | null> {
    this.taskInputs.push(input);
    return Promise.resolve(this.task);
  }

  public findTaskSessionSummary(
    input: FindTaskSessionSummaryInput,
  ): Promise<SessionSummaryRecord | null> {
    this.scopedInputs.push(input);
    return Promise.resolve(this.summary);
  }

  public listMemories(input: FindScopedRecordsInput): Promise<readonly MemoryRecord[]> {
    this.scopedInputs.push(input);
    return Promise.resolve(this.memories);
  }

  public listTraceIndex(input: FindScopedRecordsInput): Promise<readonly TraceIndexRecord[]> {
    this.scopedInputs.push(input);
    return Promise.resolve(this.traceIndex);
  }

  public loadRestoreBundle(input: LoadRestoreBundleInput): Promise<RestoreBundle> {
    this.bundleInputs.push(input);
    return Promise.resolve(this.bundle);
  }
}

class RecordingTranscriptSource implements CheckpointTranscriptSource {
  public l1Calls = 0;
  public l2Calls = 0;
  public l1Transcript = '{"role":"assistant","content":"L1 transcript"}\n';
  public l2Transcript = '{"role":"assistant","content":"L2 transcript"}\n';

  public readL1Transcript(): Promise<string> {
    this.l1Calls += 1;
    return Promise.resolve(this.l1Transcript);
  }

  public readL2Transcript(): Promise<string> {
    this.l2Calls += 1;
    return Promise.resolve(this.l2Transcript);
  }
}

class RecordingCapabilitySource implements CheckpointCapabilitySummarySource {
  public l1Calls = 0;
  public l2Calls = 0;

  public loadL1CapabilitySummary(): Promise<{ readonly tools: readonly string[] }> {
    this.l1Calls += 1;
    return Promise.resolve({ tools: ["legal_case_read", "legal_analysis_write"] });
  }

  public loadL2CapabilitySummary(): Promise<{ readonly tools: readonly string[] }> {
    this.l2Calls += 1;
    return Promise.resolve({ tools: ["legal_case_read"] });
  }
}

class RecordingSessionSummarySource implements CheckpointSessionSummarySource {
  public calls = 0;
  public summary = "idle L1 runtime has no task-backed session";

  public loadL1SessionSummary(): Promise<string> {
    this.calls += 1;
    return Promise.resolve(this.summary);
  }
}

class RecordingArtifactRepository implements LifecycleCheckpointArtifactRepository {
  public readonly l1Inputs: SaveL1CheckpointArtifactInput[] = [];
  public readonly l2Inputs: SaveCheckpointArtifactInput[] = [];
  public l1Failure: Error | null = null;
  public l2Failure: Error | null = null;

  public saveL1CheckpointArtifact(
    input: SaveL1CheckpointArtifactInput,
  ): Promise<CheckpointArtifactRecord> {
    this.l1Inputs.push(input);
    if (this.l1Failure !== null) {
      return Promise.reject(this.l1Failure);
    }
    return Promise.resolve({
      checkpointId: "00000000-0000-4000-8000-000000000001",
      checkpointLevel: CheckpointLevel.L1,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: null,
      taskId: null,
      snapshotPath: input.snapshotPath,
      transcriptPath: input.transcriptPath,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  public saveCheckpointArtifact(
    input: SaveCheckpointArtifactInput,
  ): Promise<CheckpointArtifactRecord> {
    this.l2Inputs.push(input);
    if (this.l2Failure !== null) {
      return Promise.reject(this.l2Failure);
    }
    return Promise.resolve({
      checkpointId: "00000000-0000-4000-8000-000000000002",
      checkpointLevel: CheckpointLevel.L2,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      snapshotPath: input.snapshotPath,
      transcriptPath: input.transcriptPath,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
}

function reference(path: string): LocalArtifactReference {
  return {
    path,
    uri: `file://${path}`,
    sha256: "0".repeat(64),
    byteLength: 0,
  };
}

class StubVolume implements LifecycleCheckpointVolume {
  public l1Calls = 0;
  public l2Calls = 0;
  public failure: Error | null = null;

  public constructor(private readonly root: string) {}

  public checkpointL1(input: SaveLocalL1CheckpointInput): Promise<LocalL1CheckpointReceipt> {
    this.l1Calls += 1;
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      checkpointedAt: input.checkpointedAt,
      snapshot: reference(resolve(this.root, "checkpoints/l1/snapshot.json")),
      transcript: reference(resolve(this.root, "checkpoints/l1/transcript.jsonl")),
    });
  }

  public checkpoint(input: SaveLocalCheckpointInput): Promise<LocalCheckpointReceipt> {
    this.l2Calls += 1;
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      checkpointedAt: input.checkpointedAt,
      snapshot: reference(resolve(this.root, "checkpoints/l2/snapshot.json")),
      transcript: reference(resolve(this.root, "checkpoints/l2/transcript.jsonl")),
    });
  }
}

async function makeRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "agentnest-checkpoint-writer-")));
  temporaryRoots.push(root);
  return root;
}

async function expectContentAddressed(path: string, prefix: string): Promise<string> {
  const content = await readFile(path);
  const hash = createHash("sha256").update(content).digest("hex");
  expect(path).toContain(`${prefix}-${hash}`);
  return hash;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Phase5LifecycleCheckpointWriter", () => {
  it("writes an L1 volume checkpoint before recording safe hash-backed references", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(
      captures,
      new LocalCheckpointVolume(root),
      persistence,
      { volumeRoot: root },
    );

    await writer.checkpointL1(l1Record, CHECKPOINTED_AT);

    expect(captures.l1Calls).toBe(1);
    expect(captures.l2Calls).toBe(0);
    expect(persistence.l1Inputs).toHaveLength(1);
    expect(persistence.l2Inputs).toHaveLength(0);
    const persisted = persistence.l1Inputs[0];
    expect(persisted).not.toHaveProperty("sessionId");
    expect(persisted).not.toHaveProperty("taskId");
    expect(isAbsolute(persisted?.snapshotPath ?? "/unexpected")).toBe(false);
    expect(isAbsolute(persisted?.transcriptPath ?? "/unexpected")).toBe(false);
    const snapshotPath = resolve(root, persisted?.snapshotPath ?? "missing");
    const transcriptPath = resolve(root, persisted?.transcriptPath ?? "missing");
    await expectContentAddressed(snapshotPath, "snapshot");
    const transcriptHash = await expectContentAddressed(transcriptPath, "transcript");
    const snapshot: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(snapshot).toMatchObject({
      checkpoint_level: "L1",
      transcript_ref: { sha256: transcriptHash },
      state: {
        sessionSummary: captures.l1.snapshot.sessionSummary,
        memories: captures.l1.snapshot.memories,
        traceIndex: captures.l1.snapshot.traceIndex,
        taskState: null,
        capabilitySummary: captures.l1.snapshot.capabilitySummary,
      },
    });
    expect(snapshot).not.toHaveProperty("session_id");
    expect(snapshot).not.toHaveProperty("task_id");
  });

  it("writes an L2 checkpoint with the exact lifecycle task identity and compact state", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(
      captures,
      new LocalCheckpointVolume(root),
      persistence,
      { volumeRoot: root },
    );

    await writer.checkpointL2(l2Record, CHECKPOINTED_AT);

    expect(persistence.l2Inputs[0]).toMatchObject({
      scope: l2Record.scope,
      logicalAgentId: l2Record.logicalAgentId,
      runtimeInstanceId: l2Record.runtimeInstanceId,
      sessionId: l2Record.sessionId,
      taskId: l2Record.taskId,
      checkpointLevel: CheckpointLevel.L2,
      now: CHECKPOINTED_AT,
    });
    const persisted = persistence.l2Inputs[0];
    const snapshotPath = resolve(root, persisted?.snapshotPath ?? "missing");
    const transcriptPath = resolve(root, persisted?.transcriptPath ?? "missing");
    await expectContentAddressed(snapshotPath, "snapshot");
    const transcriptHash = await expectContentAddressed(transcriptPath, "transcript");
    const snapshot: unknown = JSON.parse(await readFile(snapshotPath, "utf8"));
    expect(snapshot).toMatchObject({
      logical_agent_id: l2Record.logicalAgentId,
      runtime_instance_id: l2Record.runtimeInstanceId,
      session_id: l2Record.sessionId,
      task_id: l2Record.taskId,
      transcript_ref: { sha256: transcriptHash },
      state: {
        sessionSummary: captures.l2.snapshot.sessionSummary,
        memories: captures.l2.snapshot.memories,
        traceIndex: captures.l2.snapshot.traceIndex,
        taskState: captures.l2.snapshot.taskState,
        capabilitySummary: captures.l2.snapshot.capabilitySummary,
      },
    });
    expect(snapshot).not.toHaveProperty("state.transcript");
  });

  it("stops before the volume and database when capture fails", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    captures.l2Failure = new Error("capture unavailable");
    const volume = new StubVolume(root);
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(captures, volume, persistence, {
      volumeRoot: root,
    });

    await expect(writer.checkpointL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      "capture unavailable",
    );
    expect(volume.l2Calls).toBe(0);
    expect(persistence.l2Inputs).toHaveLength(0);
  });

  it("stops before the database and rejects when the volume write fails", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    const volume = new StubVolume(root);
    volume.failure = new Error("volume unavailable");
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(captures, volume, persistence, {
      volumeRoot: root,
    });

    await expect(writer.checkpointL1(l1Record, CHECKPOINTED_AT)).rejects.toThrow(
      "volume unavailable",
    );
    expect(volume.l1Calls).toBe(1);
    expect(persistence.l1Inputs).toHaveLength(0);
  });

  it("does not report success when PostgreSQL artifact recording fails", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    const volume = new StubVolume(root);
    const persistence = new RecordingArtifactRepository();
    persistence.l2Failure = new Error("database unavailable");
    const writer = new Phase5LifecycleCheckpointWriter(captures, volume, persistence, {
      volumeRoot: root,
    });

    await expect(writer.checkpointL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      "database unavailable",
    );
    expect(volume.l2Calls).toBe(1);
    expect(persistence.l2Inputs).toHaveLength(1);
  });

  it("rejects L1 and L2 capture identities that differ from the lifecycle record", async () => {
    const root = await makeRoot();
    const captures = new RecordingCaptureSource();
    const volume = new StubVolume(root);
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(captures, volume, persistence, {
      volumeRoot: root,
    });

    captures.l1 = l1Capture({ runtimeInstanceId: "ari_other" });
    await expect(writer.checkpointL1(l1Record, CHECKPOINTED_AT)).rejects.toThrow(
      /identity does not match/u,
    );
    captures.l2 = l2Capture({ sessionId: "agent:l2:subagent:other" });
    await expect(writer.checkpointL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      /identity does not match/u,
    );

    expect(volume.l1Calls).toBe(0);
    expect(volume.l2Calls).toBe(0);
    expect(persistence.l1Inputs).toHaveLength(0);
    expect(persistence.l2Inputs).toHaveLength(0);
  });

  it("rejects a volume artifact reference outside the configured root before DB recording", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const captures = new RecordingCaptureSource();
    const volume = new StubVolume(outside);
    const persistence = new RecordingArtifactRepository();
    const writer = new Phase5LifecycleCheckpointWriter(captures, volume, persistence, {
      volumeRoot: root,
    });

    await expect(writer.checkpointL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      /outside the configured volume root/u,
    );
    expect(persistence.l2Inputs).toHaveLength(0);
  });
});

describe("PostgresCheckpointCaptureSource", () => {
  it("captures only the exact L2 task records and keeps Transcript outside the Snapshot", async () => {
    const persistence = new RecordingCaptureRepository();
    persistence.memories = [
      memory({ runtimeInstanceId: "ari_previous", sessionId: "agent:l2:subagent:previous" }),
      memory({
        memoryId: "00000000-0000-4000-8000-000000000020",
        sessionId: "agent:l2:subagent:other",
        taskId: "task_other",
        content: "OTHER_TASK_MEMORY",
      }),
    ];
    persistence.traceIndex = [
      trace({ runtimeInstanceId: "ari_previous", sessionId: "agent:l2:subagent:previous" }),
      trace({
        traceEventId: "00000000-0000-4000-8000-000000000021",
        sessionId: "agent:l2:subagent:other",
        taskId: "task_other",
        traceId: "trace_other",
      }),
    ];
    const transcripts = new RecordingTranscriptSource();
    const capabilities = new RecordingCapabilitySource();
    const summaries = new RecordingSessionSummarySource();
    const source = new PostgresCheckpointCaptureSource(
      persistence,
      transcripts,
      capabilities,
      summaries,
    );

    const captured = await source.captureL2(l2Record, CHECKPOINTED_AT);

    expect(persistence.taskInputs).toEqual([{ scope: l2Record.scope, taskId: l2Record.taskId }]);
    expect(persistence.scopedInputs[0]).toEqual({
      scope: l2Record.scope,
      logicalAgentId: l2Record.logicalAgentId,
      runtimeInstanceId: l2Record.runtimeInstanceId,
      sessionId: l2Record.sessionId,
      taskId: l2Record.taskId,
    });
    expect(captured).toMatchObject({
      scope: l2Record.scope,
      logicalAgentId: l2Record.logicalAgentId,
      runtimeInstanceId: l2Record.runtimeInstanceId,
      sessionId: l2Record.sessionId,
      taskId: l2Record.taskId,
      snapshot: {
        sessionSummary: "case_001 evidence task completed",
        memories: [{ task_id: l2Record.taskId, content: "ALPHA_LEGAL_MEMORY" }],
        traceIndex: [{ task_id: l2Record.taskId, trace_id: "trace_l2" }],
        taskState: {
          task_id: l2Record.taskId,
          status: L2TaskStatus.COMPLETED,
          input: { resource_id: "case_001" },
        },
        result: { finding: "ready" },
        capabilitySummary: { tools: ["legal_case_read"] },
      },
    });
    expect(captured.snapshot.memories).toHaveLength(1);
    expect(captured.snapshot.traceIndex).toHaveLength(1);
    expect(captured.snapshot).not.toHaveProperty("transcript");
    expect(transcripts.l2Calls).toBe(1);
    expect(capabilities.l2Calls).toBe(1);

    persistence.memories = [];
    persistence.traceIndex = [];
    const emptyCollections = await source.captureL2(l2Record, CHECKPOINTED_AT);
    expect(emptyCollections.snapshot.memories).toEqual([]);
    expect(emptyCollections.snapshot.traceIndex).toEqual([]);
  });

  it("captures a taskless L1 with empty collections and an explicit runtime summary", async () => {
    const persistence = new RecordingCaptureRepository();
    persistence.bundle = restoreBundle({
      latestSessionSummary: null,
      memories: [],
      traceIndex: [],
      unfinishedTasks: [],
    });
    const transcripts = new RecordingTranscriptSource();
    transcripts.l1Transcript = "";
    const capabilities = new RecordingCapabilitySource();
    const summaries = new RecordingSessionSummarySource();
    const source = new PostgresCheckpointCaptureSource(
      persistence,
      transcripts,
      capabilities,
      summaries,
    );

    const captured = await source.captureL1(l1Record, CHECKPOINTED_AT);

    expect(persistence.bundleInputs).toEqual([
      { scope: l1Record.scope, logicalAgentId: l1Record.logicalAgentId },
    ]);
    expect(captured).toMatchObject({
      scope: l1Record.scope,
      logicalAgentId: l1Record.logicalAgentId,
      runtimeInstanceId: l1Record.runtimeInstanceId,
      snapshot: {
        sessionSummary: "idle L1 runtime has no task-backed session",
        memories: [],
        traceIndex: [],
        taskState: null,
        result: null,
        capabilitySummary: {
          tools: ["legal_case_read", "legal_analysis_write"],
        },
      },
    });
    expect(captured).not.toHaveProperty("sessionId");
    expect(captured).not.toHaveProperty("taskId");
    expect(captured.snapshot).not.toHaveProperty("transcript");
    expect(captured.transcript).toBe("");
    expect(transcripts.l1Calls).toBe(1);
    expect(capabilities.l1Calls).toBe(1);
    expect(summaries.calls).toBe(1);
  });

  it("rejects missing PostgreSQL checkpoint state before reading external sources", async () => {
    const persistence = new RecordingCaptureRepository();
    persistence.task = null;
    const transcripts = new RecordingTranscriptSource();
    const capabilities = new RecordingCapabilitySource();
    const summaries = new RecordingSessionSummarySource();
    const source = new PostgresCheckpointCaptureSource(
      persistence,
      transcripts,
      capabilities,
      summaries,
    );

    await expect(source.captureL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      "TaskState is missing",
    );
    expect(transcripts.l2Calls).toBe(0);
    expect(capabilities.l2Calls).toBe(0);

    persistence.bundle = restoreBundle({ latestSessionSummary: null });
    summaries.summary = "";
    await expect(source.captureL1(l1Record, CHECKPOINTED_AT)).rejects.toThrow(
      "Session Summary is missing",
    );
    expect(transcripts.l1Calls).toBe(0);
    expect(capabilities.l1Calls).toBe(0);
  });

  it("rejects scope and task identity mismatches returned by persistence", async () => {
    const transcripts = new RecordingTranscriptSource();
    const capabilities = new RecordingCapabilitySource();
    const summaries = new RecordingSessionSummarySource();
    const persistence = new RecordingCaptureRepository();
    persistence.memories = [memory({ tenantId: "tenant_B" })];
    const source = new PostgresCheckpointCaptureSource(
      persistence,
      transcripts,
      capabilities,
      summaries,
    );

    await expect(source.captureL2(l2Record, CHECKPOINTED_AT)).rejects.toThrow(
      /does not match the requested tenant\/business agent/u,
    );

    persistence.bundle = restoreBundle({
      latestSessionSummary: sessionSummary({ logicalAgentId: "tb_00000000000000000000" }),
    });
    await expect(source.captureL1(l1Record, CHECKPOINTED_AT)).rejects.toThrow(
      /does not match the requested tenant\/business agent/u,
    );
    expect(transcripts.l1Calls).toBe(0);
    expect(transcripts.l2Calls).toBe(0);
    expect(capabilities.l1Calls).toBe(0);
    expect(capabilities.l2Calls).toBe(0);
    expect(summaries.calls).toBe(0);
  });
});

describe("CatalogCheckpointCapabilitySummarySource", () => {
  it("re-resolves current policy so a revoked Tool is absent after restore", async () => {
    const catalog: TenantCapabilityCatalog = {
      resolveProfile: () =>
        Promise.resolve({
          profile_id: "cap_tenant_a_legal_v2",
          version: 2,
          tenant_id: l2Record.scope.tenantId,
          biz_domain: l2Record.scope.bizDomain,
          skills: ["legal-evidence-check"],
          tools: { legal_case_read: ["read"] },
          memory_scopes: ["RESOURCE_MEMORY"],
          lifecycle: {
            l1_idle_ttl_seconds: 86_400,
            l2_idle_ttl_seconds: 3_600,
            max_active_l2: 5,
          },
          created_at: "2030-01-01T00:00:00.000Z",
        }),
      resolveTaskTemplate: (): Promise<TaskTemplate> =>
        Promise.resolve({
          taskType: "LEGAL_EVIDENCE_CHECK",
          bizDomain: "LEGAL",
          skills: ["legal-evidence-check"],
          tools: {
            legal_case_read: ["read"],
            legal_analysis_write: ["write"],
          },
          memoryScopes: ["RESOURCE_MEMORY"],
        }),
    };
    const persistence = new RecordingCaptureRepository();
    const source = new CatalogCheckpointCapabilitySummarySource(catalog, persistence);

    const l1 = await source.loadL1CapabilitySummary(l1Record);
    const l2 = await source.loadL2CapabilitySummary(l2Record);

    expect(l1).toMatchObject({
      profile_id: "cap_tenant_a_legal_v2",
      tools: { legal_case_read: ["read"] },
    });
    expect(l2).toMatchObject({
      profile_version: 2,
      tools: { legal_case_read: ["read"] },
    });
    expect(JSON.stringify(l2)).not.toContain("legal_analysis_write");
  });
});
