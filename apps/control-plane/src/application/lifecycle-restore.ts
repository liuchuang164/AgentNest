import { randomUUID } from "node:crypto";

import {
  createRuntimeInstanceId,
  deriveLogicalAgentId,
  normalizeTenantBizScope,
} from "@agentnest/capability";
import type { L2TaskStatus, TenantBizScope } from "@agentnest/contracts";

import type { LifecycleClock } from "./lifecycle-reaper.js";

export type RestoreJsonObject = Readonly<Record<string, unknown>>;

export interface RestoreSessionSummary {
  readonly summaryId: string;
  readonly sessionId: string;
  readonly summary: string;
}

export interface RestoreMemory {
  readonly memoryId: string;
  readonly memoryType: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly content: string;
}

export interface RestoreTraceIndexEntry {
  readonly traceEventId: string;
  readonly traceId: string;
  readonly eventType: string;
  readonly decision: string | null;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface RestoreUnfinishedTask {
  readonly taskId: string;
  readonly sessionId: string;
  readonly taskType: string;
  readonly status: L2TaskStatus;
  readonly currentStep: string | null;
  readonly input: RestoreJsonObject;
}

/**
 * This deliberately narrow bundle is the application boundary over the Phase 5
 * persistence repository. Transcript paths and transcript content are omitted,
 * so they cannot accidentally become model restore context.
 */
export interface LifecycleRestoreBundle {
  readonly previousRuntimeInstanceId: string | null;
  /** Final L1 checkpoint summary, loaded from the local Snapshot when present. */
  readonly checkpointSessionSummary: string | null;
  readonly latestSessionSummary: RestoreSessionSummary | null;
  readonly memories: readonly RestoreMemory[];
  readonly traceIndex: readonly RestoreTraceIndexEntry[];
  readonly unfinishedTasks: readonly RestoreUnfinishedTask[];
}

export interface RestoredRuntimeRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly restoredFromRuntimeInstanceId: string;
}

export interface ActivateRestoredRuntimeInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly restoredFromRuntimeInstanceId: string;
  readonly capabilityProfileId: string;
  readonly parentSessionId: string;
  readonly activatedAt: Date;
}

export interface RebindRestoredTaskInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly restoredAt: Date;
}

export interface LifecycleRestoreRepository {
  loadRestoreBundle(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<LifecycleRestoreBundle>;

  /**
   * The adapter must create the runtime with restored_from_runtime_instance_id
   * and record RESTORE_COMPLETED only after the OpenClaw runtime is active.
   */
  activateRestoredRuntime(input: ActivateRestoredRuntimeInput): Promise<RestoredRuntimeRecord>;

  rebindUnfinishedTask(input: RebindRestoredTaskInput): Promise<void>;
}

export interface RestoredTaskContext {
  readonly taskId: string;
  readonly taskType: string;
  readonly status: L2TaskStatus;
  readonly currentStep: string | null;
  readonly input: RestoreJsonObject;
  readonly newSessionId: string;
}

export interface RestoredModelContext {
  readonly sessionSummary: string | null;
  readonly memories: readonly RestoreMemory[];
  readonly traceIndex: readonly RestoreTraceIndexEntry[];
  readonly unfinishedTasks: readonly RestoredTaskContext[];
}

export interface LifecycleRestoreResult {
  readonly runtime: RestoredRuntimeRecord;
  readonly parentSessionId: string;
  readonly modelContext: RestoredModelContext;
}

export interface LifecycleRestoreOptions {
  readonly createRuntimeInstanceId?: () => string;
  readonly createSessionId?: (logicalAgentId: string, taskId: string | null) => string;
}

export class LifecycleRestoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LifecycleRestoreError";
  }
}

function cloneJsonObject(value: RestoreJsonObject): RestoreJsonObject {
  return structuredClone(value);
}

function defaultSessionId(logicalAgentId: string, taskId: string | null): string {
  const kind = taskId === null ? "restore-parent" : "restore-task";
  return `agent:${logicalAgentId}:${kind}-${randomUUID()}`;
}

export class LifecycleRestoreService {
  readonly #createRuntimeInstanceId: () => string;
  readonly #createSessionId: (logicalAgentId: string, taskId: string | null) => string;

  public constructor(
    private readonly repository: LifecycleRestoreRepository,
    private readonly clock: LifecycleClock,
    options: LifecycleRestoreOptions = {},
  ) {
    this.#createRuntimeInstanceId = options.createRuntimeInstanceId ?? createRuntimeInstanceId;
    this.#createSessionId = options.createSessionId ?? defaultSessionId;
  }

  public async restore(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
    readonly capabilityProfileId: string;
  }): Promise<LifecycleRestoreResult> {
    const scope = normalizeTenantBizScope(input.scope);
    const expectedLogicalAgentId = deriveLogicalAgentId(scope);
    if (input.logicalAgentId !== expectedLogicalAgentId) {
      throw new LifecycleRestoreError(
        "logical agent does not match the requested tenant/biz scope",
      );
    }

    const bundle = await this.repository.loadRestoreBundle({
      scope,
      logicalAgentId: expectedLogicalAgentId,
    });
    const previousRuntimeInstanceId = bundle.previousRuntimeInstanceId;
    if (previousRuntimeInstanceId === null) {
      throw new LifecycleRestoreError("no unloaded runtime is available to restore");
    }

    const runtimeInstanceId = this.#createRuntimeInstanceId();
    if (runtimeInstanceId === previousRuntimeInstanceId) {
      throw new LifecycleRestoreError("restore must create a new runtime instance ID");
    }

    const allocatedSessionIds = new Set<string>();
    const parentSessionId = this.allocateSessionId(
      expectedLogicalAgentId,
      null,
      bundle.latestSessionSummary?.sessionId ?? null,
      allocatedSessionIds,
    );
    const unfinishedTasks = bundle.unfinishedTasks.map((task) => ({
      taskId: task.taskId,
      taskType: task.taskType,
      status: task.status,
      currentStep: task.currentStep,
      input: cloneJsonObject(task.input),
      newSessionId: this.allocateSessionId(
        expectedLogicalAgentId,
        task.taskId,
        task.sessionId,
        allocatedSessionIds,
      ),
    }));
    const restoredAt = this.clock.now();
    const runtime = await this.repository.activateRestoredRuntime({
      scope,
      logicalAgentId: expectedLogicalAgentId,
      runtimeInstanceId,
      restoredFromRuntimeInstanceId: previousRuntimeInstanceId,
      capabilityProfileId: input.capabilityProfileId,
      parentSessionId,
      activatedAt: restoredAt,
    });
    this.assertActivatedRuntime(
      runtime,
      scope,
      expectedLogicalAgentId,
      runtimeInstanceId,
      previousRuntimeInstanceId,
    );

    for (const task of unfinishedTasks) {
      await this.repository.rebindUnfinishedTask({
        scope,
        logicalAgentId: expectedLogicalAgentId,
        runtimeInstanceId,
        sessionId: task.newSessionId,
        taskId: task.taskId,
        restoredAt,
      });
    }

    return {
      runtime,
      parentSessionId,
      modelContext: {
        sessionSummary:
          bundle.checkpointSessionSummary ?? bundle.latestSessionSummary?.summary ?? null,
        memories: bundle.memories.map((memory) => ({
          memoryId: memory.memoryId,
          memoryType: memory.memoryType,
          resourceType: memory.resourceType,
          resourceId: memory.resourceId,
          content: memory.content,
        })),
        traceIndex: bundle.traceIndex.map((trace) => ({
          traceEventId: trace.traceEventId,
          traceId: trace.traceId,
          eventType: trace.eventType,
          decision: trace.decision,
          reason: trace.reason,
          createdAt: new Date(trace.createdAt.getTime()),
        })),
        unfinishedTasks,
      },
    };
  }

  private allocateSessionId(
    logicalAgentId: string,
    taskId: string | null,
    previousSessionId: string | null,
    allocated: Set<string>,
  ): string {
    const sessionId = this.#createSessionId(logicalAgentId, taskId).trim();
    if (sessionId.length === 0 || sessionId === previousSessionId || allocated.has(sessionId)) {
      throw new LifecycleRestoreError("restore must allocate new, distinct, non-empty session IDs");
    }
    allocated.add(sessionId);
    return sessionId;
  }

  private assertActivatedRuntime(
    runtime: RestoredRuntimeRecord,
    scope: TenantBizScope,
    logicalAgentId: string,
    runtimeInstanceId: string,
    previousRuntimeInstanceId: string,
  ): void {
    if (
      runtime.tenantId !== scope.tenantId ||
      runtime.bizDomain !== scope.bizDomain ||
      runtime.logicalAgentId !== logicalAgentId ||
      runtime.runtimeInstanceId !== runtimeInstanceId ||
      runtime.restoredFromRuntimeInstanceId !== previousRuntimeInstanceId
    ) {
      throw new LifecycleRestoreError("restore repository returned a mismatched runtime record");
    }
  }
}
