import { DemoTenantCapabilityCatalog, deriveLogicalAgentId } from "@agentnest/capability";
import { L1RuntimeStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  DispatchToAgentInput,
  ExportSessionHistoryInput,
  ObservedOpenClawProfile,
  OpenClawAgentProfileSpec,
} from "../../packages/openclaw-adapter/src/index.js";
import {
  ExecutionContextDenyReason,
  type AppendTraceInput,
  type CreateExecutionContextInput,
  type EnsureActiveRuntimeInput,
  type EnsureActiveRuntimeResult,
  type ExecutionContextAuthorization,
  type ExecutionContextRecord,
  type ExecutionContextRepository,
  type MarkRuntimeReadyInput,
  type SaveSessionSummaryInput,
  type SaveTaskStateInput,
  type SessionSummaryRecord,
  type TaskStateRecord,
  type TenantRuntimeLifecycleRepository,
  type TraceIndexRecord,
} from "@agentnest/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { CreateTaskExecutionContext } from "../../apps/control-plane/src/application/create-task-execution-context.js";
import { EnsureTenantBizAgent } from "../../apps/control-plane/src/application/ensure-tenant-biz-agent.js";
import {
  OpenClawTaskProfileFactory,
  TaskOrchestrator,
  type TaskPersistence,
} from "../../apps/control-plane/src/application/task-orchestrator.js";
import {
  buildControlPlaneServer,
  type ControlPlaneReadRepository,
} from "../../apps/control-plane/src/server.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function scopeKey(scope: TenantBizScope): string {
  return `${scope.tenantId}\u0000${scope.bizDomain}`;
}

function taskKey(scope: TenantBizScope, taskId: string): string {
  return `${scopeKey(scope)}\u0000${taskId}`;
}

function observedProfile(spec: OpenClawAgentProfileSpec): ObservedOpenClawProfile {
  return {
    agentId: spec.agentId,
    name: spec.name ?? null,
    default: spec.default ?? null,
    workspace: spec.workspace,
    agentDir: spec.agentDir,
    model: spec.model ?? null,
    skills: spec.skills,
    tools: {
      profile: spec.tools.profile ?? null,
      allow: spec.tools.allow,
      deny: spec.tools.deny,
    },
    subagents: {
      allowAgents: spec.subagents.allowAgents,
      delegationMode: spec.subagents.delegationMode ?? null,
      model: spec.subagents.model ?? null,
      thinking: spec.subagents.thinking ?? null,
      requireAgentId: spec.subagents.requireAgentId ?? null,
    },
    sandbox: null,
    observedAt: NOW,
    rawConfig: {},
  };
}

class InMemoryRuntimes implements TenantRuntimeLifecycleRepository {
  readonly #records = new Map<string, EnsureActiveRuntimeResult>();

  public ensureActiveRuntime(input: EnsureActiveRuntimeInput): Promise<EnsureActiveRuntimeResult> {
    const existing = this.#records.get(input.logicalAgentId);
    if (existing !== undefined) {
      const reused = { ...existing, reused: true };
      this.#records.set(input.logicalAgentId, reused);
      return Promise.resolve(reused);
    }
    const created: EnsureActiveRuntimeResult = {
      reused: false,
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
        restoredFromRuntimeInstanceId: null,
      },
    };
    this.#records.set(input.logicalAgentId, created);
    return Promise.resolve(created);
  }

  public markRuntimeReady(input: MarkRuntimeReadyInput): Promise<void> {
    const existing = this.#records.get(input.logicalAgentId);
    if (existing?.runtime.runtimeInstanceId !== input.runtimeInstanceId) {
      throw new Error("E2E runtime identity was not created");
    }
    this.#records.set(input.logicalAgentId, {
      reused: existing.reused,
      logicalAgent: {
        ...existing.logicalAgent,
        status: input.status,
        lastActiveAt: input.now,
      },
      runtime: { ...existing.runtime, status: input.status, lastActiveAt: input.now },
    });
    return Promise.resolve();
  }

  public all(): readonly EnsureActiveRuntimeResult[] {
    return [...this.#records.values()];
  }
}

class InMemoryExecutionContexts implements ExecutionContextRepository {
  readonly #records = new Map<string, ExecutionContextRecord>();
  #counter = 0;

  public create(input: CreateExecutionContextInput): Promise<ExecutionContextRecord> {
    this.#counter += 1;
    const executionContextId = `00000000-0000-4000-8000-${this.#counter
      .toString()
      .padStart(12, "0")}`;
    const record: ExecutionContextRecord = {
      executionContextId,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      allowedSkills: input.allowedSkills,
      allowedTools: input.allowedTools,
      resourceScope: input.resourceScope,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.#records.set(executionContextId, record);
    return Promise.resolve(record);
  }

  public findById(input: {
    readonly scope: TenantBizScope;
    readonly executionContextId: string;
  }): Promise<ExecutionContextRecord | null> {
    const record = this.#records.get(input.executionContextId);
    if (record === undefined) {
      return Promise.resolve(null);
    }
    if (record.tenantId !== input.scope.tenantId || record.bizDomain !== input.scope.bizDomain) {
      return Promise.resolve(null);
    }
    return Promise.resolve(record);
  }

  public authorize(): Promise<ExecutionContextAuthorization> {
    return Promise.resolve({
      allowed: false,
      reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND,
    });
  }
}

class InMemoryTasks implements TaskPersistence {
  readonly #tasks = new Map<string, TaskStateRecord>();
  public readonly summaries: SessionSummaryRecord[] = [];
  public readonly traces: TraceIndexRecord[] = [];
  #counter = 100;

  public findTaskState(input: {
    readonly scope: TenantBizScope;
    readonly taskId: string;
  }): Promise<TaskStateRecord | null> {
    return Promise.resolve(this.#tasks.get(taskKey(input.scope, input.taskId)) ?? null);
  }

  public saveTaskState(input: SaveTaskStateInput): Promise<TaskStateRecord> {
    const key = taskKey(input.scope, input.taskId);
    const existing = this.#tasks.get(key);
    const record: TaskStateRecord = {
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      taskType: input.taskType,
      status: input.status,
      currentStep: input.currentStep,
      input: input.input,
      result: input.result,
      lastActiveAt: input.now,
      checkpointedAt: null,
      unloadedAt: null,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.#tasks.set(key, record);
    return Promise.resolve(record);
  }

  public saveSessionSummary(input: SaveSessionSummaryInput): Promise<SessionSummaryRecord> {
    const record: SessionSummaryRecord = {
      summaryId: this.nextUuid(),
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      summary: input.summary,
      transcriptPath: input.transcriptPath,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.summaries.push(record);
    return Promise.resolve(record);
  }

  public appendTrace(input: AppendTraceInput): Promise<TraceIndexRecord> {
    const record: TraceIndexRecord = {
      traceEventId: this.nextUuid(),
      traceId: input.traceId,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      eventKey: input.eventKey,
      eventType: input.eventType,
      decision: input.decision,
      reason: input.reason,
      createdAt: input.now,
    };
    this.traces.push(record);
    return Promise.resolve(record);
  }

  public all(): readonly TaskStateRecord[] {
    return [...this.#tasks.values()];
  }

  private nextUuid(): string {
    this.#counter += 1;
    return `00000000-0000-4000-8000-${this.#counter.toString().padStart(12, "0")}`;
  }
}

interface TaskResponseData {
  readonly task_id: string;
  readonly logical_agent_id: string;
  readonly runtime_instance_id: string;
  readonly l2_agent_id: string;
  readonly status: string;
}

interface TaskResponseEnvelope {
  readonly success: boolean;
  readonly code: string;
  readonly data: TaskResponseData | null;
}

describe("control-plane deterministic application E2E", () => {
  const servers: { close(): Promise<unknown> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  });

  it("runs API -> scope/runtime/context -> L0 dispatch with an explicit fake OpenClaw transport", async () => {
    const catalog = new DemoTenantCapabilityCatalog();
    const runtimes = new InMemoryRuntimes();
    const contexts = new InMemoryExecutionContexts();
    const tasks = new InMemoryTasks();
    const ensuredProfiles: OpenClawAgentProfileSpec[] = [];
    const dispatches: DispatchToAgentInput[] = [];
    let runtimeCounter = 0;
    let dispatchCounter = 0;
    const orchestrator = new TaskOrchestrator(
      catalog,
      new EnsureTenantBizAgent(catalog, runtimes, {
        runtimeRoot: "/tmp/agentnest-e2e/runtime",
        now: () => NOW,
        createRuntimeId: () => {
          runtimeCounter += 1;
          return `ari_00000000-0000-4000-8000-${runtimeCounter.toString().padStart(12, "0")}`;
        },
      }),
      runtimes,
      new CreateTaskExecutionContext(catalog, contexts, { now: () => NOW }),
      tasks,
      {
        ensureProfile(spec) {
          ensuredProfiles.push(spec);
          return Promise.resolve(observedProfile(spec));
        },
        dispatchToAgent(input) {
          dispatches.push(input);
          dispatchCounter += 1;
          const l2 = [...ensuredProfiles]
            .reverse()
            .find((profile) => profile.agentId.startsWith("l2_"));
          if (l2 === undefined) {
            throw new Error("fake OpenClaw transport did not observe an L2 profile");
          }
          return Promise.resolve({
            runId: `fake-run-${dispatchCounter.toString()}`,
            status: "completed",
            sessionKey: input.sessionKey,
            raw: {
              child_session_key: `agent:${l2.agentId}:subagent:fake-${dispatchCounter.toString()}`,
            },
          });
        },
        exportSessionHistory(input: ExportSessionHistoryInput) {
          return Promise.resolve({
            key: input.sessionKey,
            sessionId: `fake-session-${dispatchCounter.toString()}`,
            messageCount: 1,
            transcript:
              '{"role":"assistant","text":"AGENTNEST_L2_RESULT|task_id=fake|status=COMPLETED|detail=deterministic"}',
            raw: {},
          });
        },
      },
      new OpenClawTaskProfileFactory({ runtimeRoot: "/tmp/agentnest-e2e/openclaw" }),
      { now: () => NOW },
      { dispatchMode: "l0" },
    );
    const reads: ControlPlaneReadRepository = {
      checkHealth: () => Promise.resolve({ postgres: true, migrations: true }),
      findTask: (input) => tasks.findTaskState(input),
      listAgents: (requestedScope) =>
        Promise.resolve(
          runtimes
            .all()
            .filter(
              (record) =>
                record.logicalAgent.tenantId === requestedScope.tenantId &&
                record.logicalAgent.bizDomain === requestedScope.bizDomain,
            )
            .map((record) => ({
              tenantId: record.logicalAgent.tenantId,
              bizDomain: record.logicalAgent.bizDomain,
              logicalAgentId: record.logicalAgent.logicalAgentId,
              status: record.logicalAgent.status,
              currentRuntimeInstanceId: record.logicalAgent.currentRuntimeInstanceId,
              lastActiveAt: record.logicalAgent.lastActiveAt,
              capabilityProfileId: record.logicalAgent.capabilityProfileId,
              activeL2Count: 0,
            })),
        ),
      findAgent: ({ scope, logicalAgentId }) =>
        reads
          .listAgents(scope)
          .then(
            (records) => records.find((record) => record.logicalAgentId === logicalAgentId) ?? null,
          ),
      listMemories: () => Promise.resolve([]),
    };
    const server = buildControlPlaneServer({
      tasks: orchestrator,
      reads,
      catalog,
      health: {
        ready: () =>
          Promise.resolve({
            ready: true,
            postgres: true,
            migrations: true,
            openclaw: true,
            mainProfile: true,
          }),
      },
    });
    servers.push(server);

    async function createTask(input: {
      readonly requestId: string;
      readonly idempotencyKey: string;
      readonly tenantId: string;
      readonly bizDomain: "LEGAL" | "ROBOT_DOG";
      readonly taskType: "LEGAL_EVIDENCE_CHECK" | "ROBOT_DOG_HEALTH_CHECK";
      readonly resourceType: "CASE" | "DEVICE";
      readonly resourceId: string;
    }): Promise<{ readonly statusCode: number; readonly body: TaskResponseEnvelope }> {
      const response = await server.inject({
        method: "POST",
        url: "/api/tasks",
        headers: { "x-request-id": input.requestId },
        payload: {
          request_id: input.requestId,
          idempotency_key: input.idempotencyKey,
          tenant_id: input.tenantId,
          biz_domain: input.bizDomain,
          task_type: input.taskType,
          resource: {
            resource_type: input.resourceType,
            resource_id: input.resourceId,
          },
          input: { instruction: "deterministic application E2E" },
        },
      });
      return { statusCode: response.statusCode, body: response.json<TaskResponseEnvelope>() };
    }

    const tenantALegalOne = await createTask({
      requestId: "e2e-a-legal-1",
      idempotencyKey: "e2e-a-legal-1",
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      taskType: "LEGAL_EVIDENCE_CHECK",
      resourceType: "CASE",
      resourceId: "case_001",
    });
    const tenantALegalTwo = await createTask({
      requestId: "e2e-a-legal-2",
      idempotencyKey: "e2e-a-legal-2",
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      taskType: "LEGAL_EVIDENCE_CHECK",
      resourceType: "CASE",
      resourceId: "case_001",
    });
    const tenantBLegal = await createTask({
      requestId: "e2e-b-legal",
      idempotencyKey: "e2e-b-legal",
      tenantId: "tenant_B",
      bizDomain: "LEGAL",
      taskType: "LEGAL_EVIDENCE_CHECK",
      resourceType: "CASE",
      resourceId: "case_001",
    });
    const tenantARobot = await createTask({
      requestId: "e2e-a-robot",
      idempotencyKey: "e2e-a-robot",
      tenantId: "tenant_A",
      bizDomain: "ROBOT_DOG",
      taskType: "ROBOT_DOG_HEALTH_CHECK",
      resourceType: "DEVICE",
      resourceId: "device_001",
    });
    const tenantALegalOneReused = await createTask({
      requestId: "e2e-a-legal-1-retry",
      idempotencyKey: "e2e-a-legal-1",
      tenantId: "tenant_A",
      bizDomain: "LEGAL",
      taskType: "LEGAL_EVIDENCE_CHECK",
      resourceType: "CASE",
      resourceId: "case_001",
    });

    for (const response of [tenantALegalOne, tenantALegalTwo, tenantBLegal, tenantARobot]) {
      expect(response.statusCode).toBe(202);
      expect(response.body).toMatchObject({ success: true, code: "TASK_ACCEPTED" });
      expect(response.body.data?.status).toBe("COMPLETED");
    }
    expect(tenantALegalOneReused.statusCode).toBe(200);
    expect(tenantALegalOneReused.body).toMatchObject({
      success: true,
      code: "TASK_REUSED",
      data: { task_id: tenantALegalOne.body.data?.task_id },
    });

    const aLegalOne = tenantALegalOne.body.data;
    const aLegalTwo = tenantALegalTwo.body.data;
    const bLegal = tenantBLegal.body.data;
    const aRobot = tenantARobot.body.data;
    expect(aLegalOne).not.toBeNull();
    expect(aLegalTwo).not.toBeNull();
    expect(bLegal).not.toBeNull();
    expect(aRobot).not.toBeNull();
    if (aLegalOne === null || aLegalTwo === null || bLegal === null || aRobot === null) {
      throw new Error("E2E task response did not contain data");
    }

    expect(aLegalOne.logical_agent_id).toBe(aLegalTwo.logical_agent_id);
    expect(aLegalOne.runtime_instance_id).toBe(aLegalTwo.runtime_instance_id);
    expect(aLegalOne.logical_agent_id).toBe(
      deriveLogicalAgentId({ tenantId: "tenant_A", bizDomain: "LEGAL" }),
    );
    expect(
      new Set([aLegalOne.logical_agent_id, bLegal.logical_agent_id, aRobot.logical_agent_id]).size,
    ).toBe(3);
    expect(dispatches).toHaveLength(4);
    expect(tasks.summaries).toHaveLength(4);
    expect(tasks.traces).toHaveLength(4);
    for (const dispatch of dispatches) {
      expect(dispatch.agentId).toBe("main");
      expect(dispatch.message.split("\n")[0]).toMatch(
        /^AGENTNEST_CONTROLLER_CONTEXT_V1 \{"execution_context_id":"[0-9a-f-]{36}"\}$/u,
      );
      expect(dispatch.message).toContain("native sessions_spawn");
    }

    const l1Profiles = [aLegalOne, bLegal, aRobot].map((result) =>
      ensuredProfiles.find((profile) => profile.agentId === result.logical_agent_id),
    );
    expect(l1Profiles.every((profile) => profile !== undefined)).toBe(true);
    expect(new Set(l1Profiles.map((profile) => profile?.agentDir)).size).toBe(3);
    expect(new Set(l1Profiles.map((profile) => profile?.workspace)).size).toBe(3);
    for (const result of [aLegalOne, bLegal, aRobot]) {
      const l1 = ensuredProfiles.find((profile) => profile.agentId === result.logical_agent_id);
      const l2 = ensuredProfiles.find((profile) => profile.agentId === result.l2_agent_id);
      expect(l1).toBeDefined();
      expect(l2).toBeDefined();
      expect(l2?.tools.allow.every((tool) => l1?.tools.allow.includes(tool) === true)).toBe(true);
      expect(l2?.agentDir).not.toBe(l1?.agentDir);
    }

    const crossScopeRead = await server.inject({
      method: "GET",
      url: `/api/tasks/${aLegalOne.task_id}?request_id=e2e-cross-scope&tenant_id=tenant_B&biz_domain=LEGAL`,
    });
    expect(crossScopeRead.statusCode).toBe(404);
    expect(tasks.all()).toHaveLength(4);
  });
});
