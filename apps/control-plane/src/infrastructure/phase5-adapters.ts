import { normalizeTenantBizScope } from "@agentnest/capability";
import { L1RuntimeStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  LocalCheckpointVolume,
  PostgresPhase5PersistenceRepository,
  TenantRuntimeLifecycleRepository,
  ToolCompletionRecord,
} from "@agentnest/persistence";

import type {
  ActivateRestoredRuntimeInput,
  LifecycleRestoreBundle,
  LifecycleRestoreRepository,
  RebindRestoredTaskInput,
  RestoredRuntimeRecord,
} from "../application/lifecycle-restore.js";
import type {
  DemoToolCompletionKey,
  DemoToolCompletionRecord,
  DemoToolCompletionRepository,
  RecordDemoToolCompletionInput,
} from "../application/lifecycle-tool-once.js";

type RestorePersistenceRepository = Pick<
  PostgresPhase5PersistenceRepository,
  "loadRestoreBundle" | "rebindTaskForRestore"
>;

type ToolCompletionPersistenceRepository = Pick<
  PostgresPhase5PersistenceRepository,
  "findToolCompletion" | "recordToolCompletion"
>;

export interface RestoredRuntimeActivationResult {
  readonly openclawAgentId: string;
  readonly parentSessionId: string;
}

/** Ensures the current-policy OpenClaw L1 Profile before PostgreSQL marks it ready. */
export interface RestoredRuntimeActivator {
  activate(input: ActivateRestoredRuntimeInput): Promise<RestoredRuntimeActivationResult>;
}

export interface L1CheckpointSummarySource {
  load(input: {
    readonly logicalAgentId: string;
    readonly runtimeInstanceId: string;
  }): Promise<string | null>;
}

export class LocalCheckpointL1SummarySource implements L1CheckpointSummarySource {
  public constructor(private readonly volume: Pick<LocalCheckpointVolume, "restoreL1">) {}

  public async load(input: {
    readonly logicalAgentId: string;
    readonly runtimeInstanceId: string;
  }): Promise<string | null> {
    const restored = await this.volume.restoreL1(input);
    return restored?.state.sessionSummary ?? null;
  }
}

interface ScopedPersistenceRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
}

export class Phase5AdapterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "Phase5AdapterError";
  }
}

function assertScopedRecord(
  record: ScopedPersistenceRecord,
  scope: TenantBizScope,
  logicalAgentId: string,
): void {
  if (
    record.tenantId !== scope.tenantId ||
    record.bizDomain !== scope.bizDomain ||
    record.logicalAgentId !== logicalAgentId
  ) {
    throw new Phase5AdapterError(
      "Phase 5 persistence returned data outside the requested tenant/business scope",
    );
  }
}

function assertCompletionKey(record: ToolCompletionRecord, input: DemoToolCompletionKey): void {
  assertScopedRecord(record, input.scope, input.logicalAgentId);
  if (
    record.taskId !== input.taskId ||
    record.toolName !== input.toolName ||
    record.action !== input.action ||
    record.resourceType !== input.resourceType ||
    record.resourceId !== input.resourceId
  ) {
    throw new Phase5AdapterError(
      "Phase 5 persistence returned a Tool completion outside the requested key",
    );
  }
}

function mapToolCompletion(record: ToolCompletionRecord): DemoToolCompletionRecord {
  return {
    scope: {
      tenantId: record.tenantId,
      bizDomain: record.bizDomain,
    },
    logicalAgentId: record.logicalAgentId,
    runtimeInstanceId: record.runtimeInstanceId,
    sessionId: record.sessionId,
    taskId: record.taskId,
    toolName: record.toolName,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    result: structuredClone(record.result),
    completedAt: new Date(record.completedAt.getTime()),
  };
}

/**
 * Bridges the broad PostgreSQL Phase 5 records to the deliberately narrow
 * restore boundary. Transcript and checkpoint paths are intentionally omitted.
 */
export class Phase5LifecycleRestoreRepositoryAdapter implements LifecycleRestoreRepository {
  public constructor(
    private readonly persistence: RestorePersistenceRepository,
    private readonly runtimes: TenantRuntimeLifecycleRepository,
    private readonly runtimeActivator: RestoredRuntimeActivator,
    private readonly l1CheckpointSummaries: L1CheckpointSummarySource,
  ) {}

  public async loadRestoreBundle(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<LifecycleRestoreBundle> {
    const scope = normalizeTenantBizScope(input.scope);
    const persisted = await this.persistence.loadRestoreBundle({
      scope,
      logicalAgentId: input.logicalAgentId,
    });

    const scopedRecords: readonly ScopedPersistenceRecord[] = [
      ...(persisted.latestSessionSummary === null ? [] : [persisted.latestSessionSummary]),
      ...persisted.memories,
      ...persisted.traceIndex,
      ...persisted.unfinishedTasks,
    ];
    for (const record of scopedRecords) {
      assertScopedRecord(record, scope, input.logicalAgentId);
    }
    const checkpointSessionSummary =
      persisted.previousRuntimeInstanceId === null
        ? null
        : await this.l1CheckpointSummaries.load({
            logicalAgentId: input.logicalAgentId,
            runtimeInstanceId: persisted.previousRuntimeInstanceId,
          });
    if (checkpointSessionSummary !== null && checkpointSessionSummary.length === 0) {
      throw new Phase5AdapterError("L1 checkpoint returned an empty Session Summary");
    }

    return {
      previousRuntimeInstanceId: persisted.previousRuntimeInstanceId,
      checkpointSessionSummary,
      latestSessionSummary:
        persisted.latestSessionSummary === null
          ? null
          : {
              summaryId: persisted.latestSessionSummary.summaryId,
              sessionId: persisted.latestSessionSummary.sessionId,
              summary: persisted.latestSessionSummary.summary,
            },
      memories: persisted.memories.map((memory) => ({
        memoryId: memory.memoryId,
        memoryType: memory.memoryType,
        resourceType: memory.resourceType,
        resourceId: memory.resourceId,
        content: memory.content,
      })),
      traceIndex: persisted.traceIndex.map((trace) => ({
        traceEventId: trace.traceEventId,
        traceId: trace.traceId,
        eventType: trace.eventType,
        decision: trace.decision,
        reason: trace.reason,
        createdAt: new Date(trace.createdAt.getTime()),
      })),
      unfinishedTasks: persisted.unfinishedTasks.map((task) => ({
        taskId: task.taskId,
        sessionId: task.sessionId,
        taskType: task.taskType,
        status: task.status,
        currentStep: task.currentStep,
        input: structuredClone(task.input),
      })),
    };
  }

  public async activateRestoredRuntime(
    input: ActivateRestoredRuntimeInput,
  ): Promise<RestoredRuntimeRecord> {
    const scope = normalizeTenantBizScope(input.scope);
    if (input.runtimeInstanceId === input.restoredFromRuntimeInstanceId) {
      throw new Phase5AdapterError("restore must create a distinct runtime instance");
    }

    const activated = await this.runtimeActivator.activate(input);
    if (
      activated.openclawAgentId !== input.logicalAgentId ||
      activated.parentSessionId !== input.parentSessionId
    ) {
      throw new Phase5AdapterError(
        "OpenClaw activator returned a runtime outside the requested restore identity",
      );
    }

    const ensured = await this.runtimes.ensureActiveRuntime({
      scope,
      logicalAgentId: input.logicalAgentId,
      capabilityProfileId: input.capabilityProfileId,
      candidateRuntimeInstanceId: input.runtimeInstanceId,
      openclawAgentId: activated.openclawAgentId,
      now: new Date(input.activatedAt.getTime()),
    });

    assertScopedRecord(ensured.logicalAgent, scope, input.logicalAgentId);
    if (
      ensured.reused ||
      ensured.logicalAgent.currentRuntimeInstanceId !== input.runtimeInstanceId ||
      ensured.runtime.logicalAgentId !== input.logicalAgentId ||
      ensured.runtime.runtimeInstanceId !== input.runtimeInstanceId ||
      ensured.runtime.restoredFromRuntimeInstanceId !== input.restoredFromRuntimeInstanceId
    ) {
      throw new Phase5AdapterError(
        "runtime repository did not create the requested restored runtime instance",
      );
    }
    await this.runtimes.markRuntimeReady({
      scope,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      status: L1RuntimeStatus.IDLE,
      now: new Date(input.activatedAt.getTime()),
    });

    return {
      tenantId: ensured.logicalAgent.tenantId,
      bizDomain: ensured.logicalAgent.bizDomain,
      logicalAgentId: ensured.runtime.logicalAgentId,
      runtimeInstanceId: ensured.runtime.runtimeInstanceId,
      restoredFromRuntimeInstanceId: ensured.runtime.restoredFromRuntimeInstanceId,
    };
  }

  public async rebindUnfinishedTask(input: RebindRestoredTaskInput): Promise<void> {
    const scope = normalizeTenantBizScope(input.scope);
    const rebound = await this.persistence.rebindTaskForRestore({
      scope,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      now: new Date(input.restoredAt.getTime()),
    });
    assertScopedRecord(rebound, scope, input.logicalAgentId);
    if (
      rebound.runtimeInstanceId !== input.runtimeInstanceId ||
      rebound.sessionId !== input.sessionId ||
      rebound.taskId !== input.taskId
    ) {
      throw new Phase5AdapterError(
        "Phase 5 persistence rebound a task outside the requested restored runtime",
      );
    }
  }
}

export class Phase5DemoToolCompletionRepositoryAdapter implements DemoToolCompletionRepository {
  public constructor(private readonly persistence: ToolCompletionPersistenceRepository) {}

  public async findToolCompletion(
    input: DemoToolCompletionKey,
  ): Promise<DemoToolCompletionRecord | null> {
    const scope = normalizeTenantBizScope(input.scope);
    const normalizedInput = { ...input, scope };
    const record = await this.persistence.findToolCompletion(normalizedInput);
    if (record === null) {
      return null;
    }
    assertCompletionKey(record, normalizedInput);
    return mapToolCompletion(record);
  }

  public async recordToolCompletion(input: RecordDemoToolCompletionInput): Promise<{
    readonly record: DemoToolCompletionRecord;
    readonly created: boolean;
  }> {
    const scope = normalizeTenantBizScope(input.scope);
    const normalizedInput = { ...input, scope };
    const persisted = await this.persistence.recordToolCompletion({
      ...normalizedInput,
      result: structuredClone(input.result),
      completedAt: new Date(input.completedAt.getTime()),
    });
    assertCompletionKey(persisted.record, normalizedInput);
    return {
      record: mapToolCompletion(persisted.record),
      created: persisted.created,
    };
  }
}
