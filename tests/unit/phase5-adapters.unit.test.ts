import { deriveLogicalAgentId } from "@agentnest/capability";
import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  EnsureActiveRuntimeInput,
  EnsureActiveRuntimeResult,
  MarkRuntimeReadyInput,
  PostgresPhase5PersistenceRepository,
  RestoreBundle,
  TaskStateRecord,
  TenantRuntimeLifecycleRepository,
} from "@agentnest/persistence";
import { CheckpointLevel } from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

import {
  LocalCheckpointL1SummarySource,
  Phase5AdapterError,
  Phase5LifecycleRestoreRepositoryAdapter,
  type L1CheckpointSummarySource,
  type RestoredRuntimeActivator,
} from "../../apps/control-plane/src/infrastructure/phase5-adapters.js";

const SCOPE = { tenantId: "tenant_A", bizDomain: "LEGAL" } as const satisfies TenantBizScope;
const LOGICAL_AGENT_ID = deriveLogicalAgentId(SCOPE);
const NOW = new Date("2030-01-02T00:00:00.000Z");

type RestorePersistence = Pick<
  PostgresPhase5PersistenceRepository,
  "loadRestoreBundle" | "rebindTaskForRestore"
>;

function unfinishedTask(overrides: Partial<TaskStateRecord> = {}): TaskStateRecord {
  return {
    tenantId: SCOPE.tenantId,
    bizDomain: SCOPE.bizDomain,
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "ari_previous",
    sessionId: "session_previous_task",
    taskId: "task_001",
    taskType: "LEGAL_EVIDENCE_CHECK",
    status: L2TaskStatus.WAITING_INPUT,
    currentStep: "awaiting_source",
    input: { question: "check evidence" },
    result: null,
    lastActiveAt: NOW,
    checkpointedAt: null,
    unloadedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function restoreBundle(overrides: Partial<RestoreBundle> = {}): RestoreBundle {
  return {
    previousRuntimeInstanceId: "ari_previous",
    latestSessionSummary: {
      summaryId: "00000000-0000-4000-8000-000000000001",
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_previous",
      sessionId: "session_previous_parent",
      taskId: "task_001",
      summary: "Evidence review paused after source validation.",
      transcriptPath: "sessions/private-transcript.jsonl",
      createdAt: NOW,
      updatedAt: NOW,
    },
    memories: [
      {
        memoryId: "00000000-0000-4000-8000-000000000002",
        tenantId: SCOPE.tenantId,
        bizDomain: SCOPE.bizDomain,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: "ari_previous",
        sessionId: "session_previous_task",
        taskId: "task_001",
        dedupeKey: "memory_001",
        memoryType: "TASK_FACT",
        resourceType: "CASE",
        resourceId: "case_001",
        content: "ALPHA_LEGAL_MEMORY",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    traceIndex: [
      {
        traceEventId: "00000000-0000-4000-8000-000000000003",
        traceId: "trace_001",
        tenantId: SCOPE.tenantId,
        bizDomain: SCOPE.bizDomain,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: "ari_previous",
        sessionId: "session_previous_task",
        taskId: "task_001",
        eventKey: "checkpoint_001",
        eventType: "CHECKPOINT_COMPLETED",
        decision: null,
        reason: null,
        createdAt: NOW,
      },
    ],
    unfinishedTasks: [unfinishedTask()],
    latestCheckpoint: {
      checkpointId: "00000000-0000-4000-8000-000000000004",
      checkpointLevel: CheckpointLevel.L1,
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_previous",
      sessionId: null,
      taskId: null,
      snapshotPath: "checkpoints/private-snapshot.json",
      transcriptPath: "sessions/private-transcript.jsonl",
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

function restorePersistence(bundle: RestoreBundle): RestorePersistence {
  return {
    loadRestoreBundle: () => Promise.resolve(bundle),
    rebindTaskForRestore: (input) =>
      Promise.resolve(
        unfinishedTask({
          tenantId: input.scope.tenantId,
          bizDomain: input.scope.bizDomain,
          logicalAgentId: input.logicalAgentId,
          runtimeInstanceId: input.runtimeInstanceId,
          sessionId: input.sessionId,
          taskId: input.taskId,
          lastActiveAt: input.now,
          updatedAt: input.now,
        }),
      ),
  };
}

class RecordingRuntimeRepository implements TenantRuntimeLifecycleRepository {
  public lastInput: EnsureActiveRuntimeInput | null = null;
  public readyInput: MarkRuntimeReadyInput | null = null;
  public resultOverride: EnsureActiveRuntimeResult | null = null;

  public ensureActiveRuntime(input: EnsureActiveRuntimeInput): Promise<EnsureActiveRuntimeResult> {
    this.lastInput = input;
    return Promise.resolve(
      this.resultOverride ?? {
        logicalAgent: {
          logicalAgentId: input.logicalAgentId,
          tenantId: input.scope.tenantId,
          bizDomain: input.scope.bizDomain,
          capabilityProfileId: input.capabilityProfileId,
          status: L1RuntimeStatus.PROVISIONING,
          currentRuntimeInstanceId: input.candidateRuntimeInstanceId,
          lastActiveAt: input.now,
        },
        runtime: {
          runtimeInstanceId: input.candidateRuntimeInstanceId,
          logicalAgentId: input.logicalAgentId,
          openclawAgentId: input.openclawAgentId,
          status: L1RuntimeStatus.PROVISIONING,
          startedAt: input.now,
          lastActiveAt: input.now,
          restoredFromRuntimeInstanceId: "ari_previous",
        },
        reused: false,
      },
    );
  }

  public markRuntimeReady(input: MarkRuntimeReadyInput): Promise<void> {
    this.readyInput = input;
    return Promise.resolve();
  }
}

class RecordingRuntimeActivator implements RestoredRuntimeActivator {
  public lastInput: Parameters<RestoredRuntimeActivator["activate"]>[0] | null = null;

  public activate(
    input: Parameters<RestoredRuntimeActivator["activate"]>[0],
  ): Promise<{ readonly openclawAgentId: string; readonly parentSessionId: string }> {
    this.lastInput = input;
    return Promise.resolve({
      openclawAgentId: input.logicalAgentId,
      parentSessionId: input.parentSessionId,
    });
  }
}

class RecordingCheckpointSummarySource implements L1CheckpointSummarySource {
  public summary: string | null = "Final L1 checkpoint summary.";

  public load(): Promise<string | null> {
    return Promise.resolve(this.summary);
  }
}

describe("Phase5LifecycleRestoreRepositoryAdapter", () => {
  it("loads the final L1 summary from the local checkpoint without Transcript content", async () => {
    const source = new LocalCheckpointL1SummarySource({
      restoreL1: (input) =>
        Promise.resolve({
          ...input,
          checkpointedAt: NOW,
          state: {
            sessionSummary: "Final local L1 summary.",
            memories: [],
            traceIndex: [],
            taskState: null,
            result: null,
            capabilitySummary: null,
          },
          snapshot: {
            path: "/volume/snapshot.json",
            uri: "file:///volume/snapshot.json",
            sha256: "0".repeat(64),
            byteLength: 1,
          },
          transcript: {
            path: "/volume/transcript.jsonl",
            uri: "file:///volume/transcript.jsonl",
            sha256: "1".repeat(64),
            byteLength: 1,
          },
        }),
    });

    await expect(
      source.load({ logicalAgentId: LOGICAL_AGENT_ID, runtimeInstanceId: "ari_previous" }),
    ).resolves.toBe("Final local L1 summary.");
  });

  it("maps only the narrow restore context while retaining previous Session IDs", async () => {
    const adapter = new Phase5LifecycleRestoreRepositoryAdapter(
      restorePersistence(restoreBundle()),
      new RecordingRuntimeRepository(),
      new RecordingRuntimeActivator(),
      new RecordingCheckpointSummarySource(),
    );

    const loaded = await adapter.loadRestoreBundle({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
    });

    expect(loaded.latestSessionSummary?.sessionId).toBe("session_previous_parent");
    expect(loaded.checkpointSessionSummary).toBe("Final L1 checkpoint summary.");
    expect(loaded.unfinishedTasks[0]?.sessionId).toBe("session_previous_task");
    expect(loaded.memories.map((memory) => memory.content)).toEqual(["ALPHA_LEGAL_MEMORY"]);
    expect(JSON.stringify(loaded)).not.toContain("transcriptPath");
    expect(JSON.stringify(loaded)).not.toContain("private-transcript");
    expect(JSON.stringify(loaded)).not.toContain("private-snapshot");
  });

  it("fails closed when persistence returns a record from another scope", async () => {
    const crossScopeTask = unfinishedTask({ tenantId: "tenant_B" });
    const adapter = new Phase5LifecycleRestoreRepositoryAdapter(
      restorePersistence(restoreBundle({ unfinishedTasks: [crossScopeTask] })),
      new RecordingRuntimeRepository(),
      new RecordingRuntimeActivator(),
      new RecordingCheckpointSummarySource(),
    );

    await expect(
      adapter.loadRestoreBundle({ scope: SCOPE, logicalAgentId: LOGICAL_AGENT_ID }),
    ).rejects.toThrow(Phase5AdapterError);
  });

  it("creates the requested runtime and verifies restored_from", async () => {
    const runtimes = new RecordingRuntimeRepository();
    const activator = new RecordingRuntimeActivator();
    const adapter = new Phase5LifecycleRestoreRepositoryAdapter(
      restorePersistence(restoreBundle()),
      runtimes,
      activator,
      new RecordingCheckpointSummarySource(),
    );

    const restored = await adapter.activateRestoredRuntime({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      restoredFromRuntimeInstanceId: "ari_previous",
      capabilityProfileId: "profile_current",
      parentSessionId: "session_parent_new",
      activatedAt: NOW,
    });

    expect(runtimes.lastInput).toMatchObject({
      candidateRuntimeInstanceId: "ari_restored",
      openclawAgentId: LOGICAL_AGENT_ID,
      logicalAgentId: LOGICAL_AGENT_ID,
    });
    expect(activator.lastInput).toMatchObject({
      runtimeInstanceId: "ari_restored",
      parentSessionId: "session_parent_new",
      capabilityProfileId: "profile_current",
    });
    expect(runtimes.readyInput).toMatchObject({
      runtimeInstanceId: "ari_restored",
      status: L1RuntimeStatus.IDLE,
    });
    expect(restored).toEqual({
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      restoredFromRuntimeInstanceId: "ari_previous",
    });
  });

  it("rejects a reused runtime or incorrect restored_from", async () => {
    const runtimes = new RecordingRuntimeRepository();
    const baseResult = await runtimes.ensureActiveRuntime({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      capabilityProfileId: "profile_current",
      candidateRuntimeInstanceId: "ari_restored",
      openclawAgentId: LOGICAL_AGENT_ID,
      now: NOW,
    });
    runtimes.resultOverride = {
      ...baseResult,
      runtime: { ...baseResult.runtime, restoredFromRuntimeInstanceId: "ari_wrong" },
      reused: true,
    };
    const adapter = new Phase5LifecycleRestoreRepositoryAdapter(
      restorePersistence(restoreBundle()),
      runtimes,
      new RecordingRuntimeActivator(),
      new RecordingCheckpointSummarySource(),
    );

    await expect(
      adapter.activateRestoredRuntime({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        runtimeInstanceId: "ari_restored",
        restoredFromRuntimeInstanceId: "ari_previous",
        capabilityProfileId: "profile_current",
        parentSessionId: "session_parent_new",
        activatedAt: NOW,
      }),
    ).rejects.toThrow("did not create the requested restored runtime");
  });

  it("rebinds unfinished TaskState through the Phase 5 repository", async () => {
    const calls: unknown[] = [];
    const persistence: RestorePersistence = {
      ...restorePersistence(restoreBundle()),
      rebindTaskForRestore: (input) => {
        calls.push(input);
        return Promise.resolve(
          unfinishedTask({
            runtimeInstanceId: input.runtimeInstanceId,
            sessionId: input.sessionId,
            taskId: input.taskId,
            lastActiveAt: input.now,
            updatedAt: input.now,
          }),
        );
      },
    };
    const adapter = new Phase5LifecycleRestoreRepositoryAdapter(
      persistence,
      new RecordingRuntimeRepository(),
      new RecordingRuntimeActivator(),
      new RecordingCheckpointSummarySource(),
    );

    await adapter.rebindUnfinishedTask({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      sessionId: "session_restored_task",
      taskId: "task_001",
      restoredAt: NOW,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        runtimeInstanceId: "ari_restored",
        sessionId: "session_restored_task",
        taskId: "task_001",
      }),
    ]);
  });
});
