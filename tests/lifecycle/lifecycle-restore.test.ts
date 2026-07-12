import { deriveLogicalAgentId } from "@agentnest/capability";
import { L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import {
  LifecycleRestoreError,
  LifecycleRestoreService,
  type ActivateRestoredRuntimeInput,
  type LifecycleRestoreBundle,
  type LifecycleRestoreRepository,
  type RebindRestoredTaskInput,
  type RestoredRuntimeRecord,
} from "../../apps/control-plane/src/application/lifecycle-restore.js";
import { MutableTestClock } from "../../packages/test-support/src/clock.js";

const SCOPE = { tenantId: "tenant_A", bizDomain: "LEGAL" } as const satisfies TenantBizScope;
const LOGICAL_AGENT_ID = deriveLogicalAgentId(SCOPE);
const RESTORED_AT = new Date("2030-01-02T00:00:00.000Z");

function restoreBundle(): LifecycleRestoreBundle {
  return {
    previousRuntimeInstanceId: "ari_previous",
    checkpointSessionSummary: null,
    latestSessionSummary: {
      summaryId: "summary_001",
      sessionId: "session_previous_parent",
      summary: "Evidence review paused after source validation.",
    },
    memories: [
      {
        memoryId: "memory_001",
        memoryType: "TASK_FACT",
        resourceType: "CASE",
        resourceId: "case_001",
        content: "ALPHA_LEGAL_MEMORY",
      },
    ],
    traceIndex: [
      {
        traceEventId: "trace_event_001",
        traceId: "trace_001",
        eventType: "CHECKPOINT_COMPLETED",
        decision: null,
        reason: null,
        createdAt: new Date("2030-01-01T23:59:59.000Z"),
      },
    ],
    unfinishedTasks: [
      {
        taskId: "task_001",
        sessionId: "session_previous_task_001",
        taskType: "LEGAL_EVIDENCE_CHECK",
        status: L2TaskStatus.WAITING_INPUT,
        currentStep: "awaiting_source",
        input: { question: "check evidence" },
      },
      {
        taskId: "task_002",
        sessionId: "session_previous_task_002",
        taskType: "LEGAL_EVIDENCE_CHECK",
        status: L2TaskStatus.RUNNING,
        currentStep: "read_case",
        input: { question: "compare evidence" },
      },
    ],
  };
}

class RecordingRestoreRepository implements LifecycleRestoreRepository {
  public activation: ActivateRestoredRuntimeInput | null = null;
  public readonly reboundTasks: RebindRestoredTaskInput[] = [];
  public runtimeOverride: RestoredRuntimeRecord | null = null;

  public constructor(public bundle: LifecycleRestoreBundle) {}

  public loadRestoreBundle(): Promise<LifecycleRestoreBundle> {
    return Promise.resolve(this.bundle);
  }

  public activateRestoredRuntime(
    input: ActivateRestoredRuntimeInput,
  ): Promise<RestoredRuntimeRecord> {
    this.activation = input;
    return Promise.resolve(
      this.runtimeOverride ?? {
        tenantId: input.scope.tenantId,
        bizDomain: input.scope.bizDomain,
        logicalAgentId: input.logicalAgentId,
        runtimeInstanceId: input.runtimeInstanceId,
        restoredFromRuntimeInstanceId: input.restoredFromRuntimeInstanceId,
      },
    );
  }

  public rebindUnfinishedTask(input: RebindRestoredTaskInput): Promise<void> {
    this.reboundTasks.push(input);
    return Promise.resolve();
  }
}

function sessionIds(
  ...ids: readonly string[]
): (logicalAgentId: string, taskId: string | null) => string {
  const remaining = [...ids];
  return () => remaining.shift() ?? "session_unexpected";
}

describe("LifecycleRestoreService", () => {
  it("allocates canonical OpenClaw-scoped Session keys by default", async () => {
    const repository = new RecordingRestoreRepository({
      ...restoreBundle(),
      unfinishedTasks: [],
    });
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
    });

    const result = await service.restore({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      capabilityProfileId: "profile_current",
    });

    expect(result.parentSessionId).toMatch(
      new RegExp(`^agent:${LOGICAL_AGENT_ID}:restore-parent-[0-9a-f-]+$`, "u"),
    );
  });

  it("keeps the logical ID, creates a new runtime and records restored_from", async () => {
    const repository = new RecordingRestoreRepository(restoreBundle());
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
      createSessionId: sessionIds("session_parent", "session_task_001", "session_task_002"),
    });

    const result = await service.restore({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      capabilityProfileId: "profile_current",
    });

    expect(result.runtime.logicalAgentId).toBe(LOGICAL_AGENT_ID);
    expect(result.runtime.runtimeInstanceId).toBe("ari_restored");
    expect(result.runtime.runtimeInstanceId).not.toBe("ari_previous");
    expect(result.runtime.restoredFromRuntimeInstanceId).toBe("ari_previous");
    expect(repository.activation).toMatchObject({
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      restoredFromRuntimeInstanceId: "ari_previous",
      capabilityProfileId: "profile_current",
      parentSessionId: "session_parent",
      activatedAt: RESTORED_AT,
    });
    expect(repository.reboundTasks).toEqual([
      expect.objectContaining({ taskId: "task_001", sessionId: "session_task_001" }),
      expect.objectContaining({ taskId: "task_002", sessionId: "session_task_002" }),
    ]);
    expect(new Set(repository.reboundTasks.map((task) => task.sessionId)).size).toBe(2);
  });

  it("injects only summary, scoped memory, trace index and unfinished TaskState", async () => {
    const rawBundle = {
      ...restoreBundle(),
      fullTranscript: "FULL_TRANSCRIPT_MUST_NOT_BE_INJECTED",
      latestCheckpoint: {
        transcriptPath: "runtime/persistence/secret-transcript.jsonl",
      },
      latestSessionSummary: {
        ...restoreBundle().latestSessionSummary,
        transcriptPath: "runtime/persistence/session.jsonl",
      },
    } as unknown as LifecycleRestoreBundle;
    const repository = new RecordingRestoreRepository(rawBundle);
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
      createSessionId: sessionIds("session_parent", "session_task_001", "session_task_002"),
    });

    const result = await service.restore({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      capabilityProfileId: "profile_current",
    });

    expect(result.modelContext.sessionSummary).toContain("Evidence review paused");
    expect(result.modelContext.memories.map((memory) => memory.content)).toEqual([
      "ALPHA_LEGAL_MEMORY",
    ]);
    expect(result.modelContext.traceIndex.map((trace) => trace.eventType)).toEqual([
      "CHECKPOINT_COMPLETED",
    ]);
    expect(result.modelContext.unfinishedTasks.map((task) => task.currentStep)).toEqual([
      "awaiting_source",
      "read_case",
    ]);
    const serializedContext = JSON.stringify(result.modelContext);
    expect(serializedContext).not.toContain("FULL_TRANSCRIPT_MUST_NOT_BE_INJECTED");
    expect(serializedContext).not.toContain("transcriptPath");
    expect(serializedContext).not.toContain("secret-transcript");
  });

  it("prefers the final L1 checkpoint summary over an older task summary", async () => {
    const repository = new RecordingRestoreRepository({
      ...restoreBundle(),
      checkpointSessionSummary: "Final L1 checkpoint summary after all task activity.",
    });
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
      createSessionId: sessionIds("session_parent", "session_task_001", "session_task_002"),
    });

    const result = await service.restore({
      scope: SCOPE,
      logicalAgentId: LOGICAL_AGENT_ID,
      capabilityProfileId: "profile_current",
    });

    expect(result.modelContext.sessionSummary).toBe(
      "Final L1 checkpoint summary after all task activity.",
    );
  });

  it("rejects scope/logical mismatches before loading restore state", async () => {
    const repository = new RecordingRestoreRepository(restoreBundle());
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT));

    await expect(
      service.restore({
        scope: SCOPE,
        logicalAgentId: "tb_00000000000000000000",
        capabilityProfileId: "profile_current",
      }),
    ).rejects.toThrow(LifecycleRestoreError);
    expect(repository.activation).toBeNull();
  });

  it("rejects restore when no unloaded runtime exists or the runtime ID is reused", async () => {
    const noPrevious = new RecordingRestoreRepository({
      ...restoreBundle(),
      previousRuntimeInstanceId: null,
    });
    const withoutSource = new LifecycleRestoreService(
      noPrevious,
      new MutableTestClock(RESTORED_AT),
    );
    await expect(
      withoutSource.restore({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        capabilityProfileId: "profile_current",
      }),
    ).rejects.toThrow("no unloaded runtime");

    const reusedId = new RecordingRestoreRepository(restoreBundle());
    const collision = new LifecycleRestoreService(reusedId, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_previous",
    });
    await expect(
      collision.restore({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        capabilityProfileId: "profile_current",
      }),
    ).rejects.toThrow("new runtime instance ID");
    expect(reusedId.activation).toBeNull();
  });

  it("rejects a repository response that does not record restored_from correctly", async () => {
    const repository = new RecordingRestoreRepository(restoreBundle());
    repository.runtimeOverride = {
      tenantId: SCOPE.tenantId,
      bizDomain: SCOPE.bizDomain,
      logicalAgentId: LOGICAL_AGENT_ID,
      runtimeInstanceId: "ari_restored",
      restoredFromRuntimeInstanceId: "ari_wrong",
    };
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
      createSessionId: sessionIds("session_parent", "session_task_001", "session_task_002"),
    });

    await expect(
      service.restore({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        capabilityProfileId: "profile_current",
      }),
    ).rejects.toThrow("mismatched runtime record");
    expect(repository.reboundTasks).toEqual([]);
  });

  it("rejects reuse of a previous Session before activating the restored runtime", async () => {
    const repository = new RecordingRestoreRepository(restoreBundle());
    const service = new LifecycleRestoreService(repository, new MutableTestClock(RESTORED_AT), {
      createRuntimeInstanceId: () => "ari_restored",
      createSessionId: sessionIds("session_previous_parent"),
    });

    await expect(
      service.restore({
        scope: SCOPE,
        logicalAgentId: LOGICAL_AGENT_ID,
        capabilityProfileId: "profile_current",
      }),
    ).rejects.toThrow("new, distinct");
    expect(repository.activation).toBeNull();
  });
});
