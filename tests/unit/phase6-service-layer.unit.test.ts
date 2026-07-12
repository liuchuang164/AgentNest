import {
  DemoTenantCapabilityCatalog,
  deriveLogicalAgentId,
  deriveTenantRuntimePaths,
} from "@agentnest/capability";
import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  DispatchToAgentInput,
  ObservedOpenClawProfile,
  OpenClawAgentProfileSpec,
} from "../../packages/openclaw-adapter/src/index.js";
import {
  ExecutionContextDenyReason,
  type CreateExecutionContextInput,
  type EnsureActiveRuntimeInput,
  type EnsureActiveRuntimeResult,
  type ExecutionContextAuthorization,
  type ExecutionContextRecord,
  type ExecutionContextRepository,
  type MarkRuntimeReadyInput,
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
  formatTaskControllerEnvelope,
  type TaskPersistence,
} from "../../apps/control-plane/src/application/task-orchestrator.js";
import { NodeOpenClawCommandRunner } from "../../apps/control-plane/src/infrastructure/runtime-services.js";
import { resolveControlPlaneListenAddress } from "../../apps/control-plane/src/main.js";
import {
  buildControlPlaneServer,
  type ControlPlaneReadRepository,
} from "../../apps/control-plane/src/server.js";
import { resolveDataGatewayListenAddress } from "../../apps/data-gateway-mock/src/main.js";
import { resolveExternalGatewayListenAddress } from "../../apps/external-gateway-mock/src/main.js";

const SCOPE: TenantBizScope = { tenantId: "tenant_A", bizDomain: "LEGAL" };
const LOGICAL_AGENT_ID = deriveLogicalAgentId(SCOPE);
const RUNTIME_ID = "ari_00000000-0000-4000-8000-000000000001";
const EXECUTION_CONTEXT_ID = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2030-01-01T00:00:00.000Z");

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

class FakeRuntimeRepository implements TenantRuntimeLifecycleRepository {
  public readonly ready: MarkRuntimeReadyInput[] = [];

  public ensureActiveRuntime(input: EnsureActiveRuntimeInput): Promise<EnsureActiveRuntimeResult> {
    return Promise.resolve({
      reused: false,
      logicalAgent: {
        logicalAgentId: input.logicalAgentId,
        tenantId: input.scope.tenantId,
        bizDomain: input.scope.bizDomain,
        capabilityProfileId: input.capabilityProfileId,
        status: L1RuntimeStatus.PROVISIONING,
        currentRuntimeInstanceId: RUNTIME_ID,
        lastActiveAt: input.now,
      },
      runtime: {
        runtimeInstanceId: RUNTIME_ID,
        logicalAgentId: input.logicalAgentId,
        openclawAgentId: input.logicalAgentId,
        status: L1RuntimeStatus.PROVISIONING,
        startedAt: input.now,
        lastActiveAt: input.now,
        restoredFromRuntimeInstanceId: null,
      },
    });
  }

  public markRuntimeReady(input: MarkRuntimeReadyInput): Promise<void> {
    this.ready.push(input);
    return Promise.resolve();
  }
}

class FakeExecutionContexts implements ExecutionContextRepository {
  public readonly events: string[];
  #record: ExecutionContextRecord | null = null;

  public constructor(events: string[]) {
    this.events = events;
  }

  public create(input: CreateExecutionContextInput): Promise<ExecutionContextRecord> {
    this.events.push("context");
    this.#record = {
      executionContextId: EXECUTION_CONTEXT_ID,
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
    return Promise.resolve(this.#record);
  }

  public findById(): Promise<ExecutionContextRecord | null> {
    return Promise.resolve(this.#record);
  }

  public authorize(): Promise<ExecutionContextAuthorization> {
    return Promise.resolve({
      allowed: false,
      reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND,
    });
  }
}

class FakeTaskPersistence implements TaskPersistence {
  readonly #tasks = new Map<string, TaskStateRecord>();
  public readonly events: string[];

  public constructor(events: string[]) {
    this.events = events;
  }

  public findTaskState(input: {
    readonly scope: TenantBizScope;
    readonly taskId: string;
  }): Promise<TaskStateRecord | null> {
    const task = this.#tasks.get(input.taskId);
    if (task?.tenantId !== input.scope.tenantId || task.bizDomain !== input.scope.bizDomain) {
      return Promise.resolve(null);
    }
    return Promise.resolve(task);
  }

  public saveTaskState(
    input: Parameters<TaskPersistence["saveTaskState"]>[0],
  ): Promise<TaskStateRecord> {
    this.events.push(`task:${input.status}`);
    const existing = this.#tasks.get(input.taskId);
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
    this.#tasks.set(input.taskId, record);
    return Promise.resolve(record);
  }

  public saveSessionSummary(
    input: Parameters<TaskPersistence["saveSessionSummary"]>[0],
  ): Promise<SessionSummaryRecord> {
    return Promise.resolve({
      summaryId: "00000000-0000-4000-8000-000000000003",
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
    });
  }

  public appendTrace(
    input: Parameters<TaskPersistence["appendTrace"]>[0],
  ): Promise<TraceIndexRecord> {
    return Promise.resolve({
      traceEventId: "00000000-0000-4000-8000-000000000004",
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
    });
  }
}

function taskRecord(): TaskStateRecord {
  return {
    tenantId: "tenant_A",
    bizDomain: "LEGAL",
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: RUNTIME_ID,
    sessionId: "agent:l2_aaaaaaaaaaaaaaaaaaaa:task-demo",
    taskId: "task_demo",
    taskType: "LEGAL_EVIDENCE_CHECK",
    status: L2TaskStatus.COMPLETED,
    currentStep: "COMPLETED",
    input: {},
    result: { stored: true },
    lastActiveAt: NOW,
    checkpointedAt: null,
    unloadedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Phase 6 runnable service layer", () => {
  const servers: { close(): Promise<unknown> }[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  });

  it("orchestrates Profile/context/task before dispatch, preserves the strict envelope, and reuses idempotently", async () => {
    const events: string[] = [];
    const catalog = new DemoTenantCapabilityCatalog();
    const runtimes = new FakeRuntimeRepository();
    const persistence = new FakeTaskPersistence(events);
    const contextRepository = new FakeExecutionContexts(events);
    const dispatches: DispatchToAgentInput[] = [];
    const ensuredProfiles: OpenClawAgentProfileSpec[] = [];
    const orchestrator = new TaskOrchestrator(
      catalog,
      new EnsureTenantBizAgent(catalog, runtimes, {
        runtimeRoot: "/tmp/agentnest-runtime",
        now: () => NOW,
        createRuntimeId: () => RUNTIME_ID,
      }),
      runtimes,
      new CreateTaskExecutionContext(catalog, contextRepository, { now: () => NOW }),
      persistence,
      {
        ensureProfile(spec) {
          ensuredProfiles.push(spec);
          return Promise.resolve(observedProfile(spec));
        },
        dispatchToAgent(input) {
          events.push("dispatch");
          dispatches.push(input);
          const l2 = ensuredProfiles.find((profile) => profile.agentId.startsWith("l2_"));
          return Promise.resolve({
            runId: "run_demo",
            status: "ok",
            sessionKey: input.sessionKey,
            raw: {
              final_output: `AGENTNEST_L0_DISPATCHED|task_id=task_demo|l1_session_key=agent:${LOGICAL_AGENT_ID}:runtime-${RUNTIME_ID}|child_session_key=agent:${l2?.agentId ?? "missing"}:subagent:child-001`,
            },
          });
        },
        exportSessionHistory(input) {
          return Promise.resolve({
            key: input.sessionKey,
            sessionId: "child-session-001",
            messageCount: 1,
            transcript:
              '{"role":"assistant","content":"AGENTNEST_L2_RESULT|task_id=task_demo|task_type=LEGAL_EVIDENCE_CHECK|status=COMPLETED|role=LEGAL"}\n',
            raw: {},
          });
        },
      },
      new OpenClawTaskProfileFactory({ runtimeRoot: "/tmp/openclaw-runtime" }),
      { now: () => NOW },
      { dispatchMode: "l0" },
    );
    const input = {
      requestId: "req_demo",
      idempotencyKey: "idem_demo",
      traceId: "trace_demo",
      scope: SCOPE,
      taskType: "LEGAL_EVIDENCE_CHECK",
      resourceType: "CASE",
      resourceId: "case_001",
      input: { question: "check evidence" },
    } as const;

    const first = await orchestrator.execute(input);
    const second = await orchestrator.execute(input);

    expect(first.task.status).toBe(L2TaskStatus.COMPLETED);
    expect(first.executionContextId).toBe(EXECUTION_CONTEXT_ID);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(dispatches).toHaveLength(1);
    expect(events.indexOf("context")).toBeLessThan(events.indexOf("task:QUEUED"));
    expect(events.indexOf("task:SPAWNING")).toBeLessThan(events.indexOf("dispatch"));
    const message = dispatches[0]?.message ?? "";
    expect(message.split("\n")[0]).toBe(
      `AGENTNEST_CONTROLLER_CONTEXT_V1 {"execution_context_id":"${EXECUTION_CONTEXT_ID}"}`,
    );
    expect(message).toContain(`"l1_session_key":"agent:${LOGICAL_AGENT_ID}:runtime-${RUNTIME_ID}"`);
    expect(runtimes.ready.map((entry) => entry.status)).toEqual([
      L1RuntimeStatus.ACTIVE,
      L1RuntimeStatus.IDLE,
    ]);
  });

  it("formats the controller envelope canonically and builds isolated L1/L2 Profiles", async () => {
    const catalog = new DemoTenantCapabilityCatalog();
    const profile = await catalog.resolveProfile(SCOPE);
    const active = {
      logicalAgent: {
        logicalAgentId: LOGICAL_AGENT_ID,
        tenantId: SCOPE.tenantId,
        bizDomain: SCOPE.bizDomain,
        capabilityProfileId: profile.profile_id,
        status: L1RuntimeStatus.ACTIVE,
        currentRuntimeInstanceId: RUNTIME_ID,
        lastActiveAt: NOW,
      },
      runtime: {
        runtimeInstanceId: RUNTIME_ID,
        logicalAgentId: LOGICAL_AGENT_ID,
        openclawAgentId: LOGICAL_AGENT_ID,
        status: L1RuntimeStatus.ACTIVE,
        startedAt: NOW,
        lastActiveAt: NOW,
        restoredFromRuntimeInstanceId: null,
      },
      reused: false,
      capabilityProfile: profile,
      paths: deriveTenantRuntimePaths("/tmp/runtime", LOGICAL_AGENT_ID),
    };
    const pair = new OpenClawTaskProfileFactory({ runtimeRoot: "/tmp/openclaw" }).build({
      activeAgent: active,
      effectiveCapability: {
        skills: profile.skills,
        tools: profile.tools,
        memoryScopes: profile.memory_scopes,
      },
      taskType: "LEGAL_EVIDENCE_CHECK",
    });
    expect(pair.l1.agentDir).not.toBe(pair.l2.agentDir);
    expect(pair.l1.tools.allow).toContain("sessions_spawn");
    expect(pair.l2.tools.allow).not.toContain("robot_device_read");
    expect(pair.l2.tools.allow).not.toContain("sessions_spawn");
    expect(formatTaskControllerEnvelope(EXECUTION_CONTEXT_ID, "prompt")).toBe(
      `AGENTNEST_CONTROLLER_CONTEXT_V1 {"execution_context_id":"${EXECUTION_CONTEXT_ID}"}\nprompt`,
    );
  });

  it("serves create/get with envelopes, validates input, and always uses tenant+biz scoped reads", async () => {
    const created = taskRecord();
    const readScopes: TenantBizScope[] = [];
    const reads: ControlPlaneReadRepository = {
      checkHealth: () => Promise.resolve({ postgres: true, migrations: true }),
      findTask: ({ scope }) => {
        readScopes.push(scope);
        return Promise.resolve(created);
      },
      listAgents: () => Promise.resolve([]),
      findAgent: () => Promise.resolve(null),
      listMemories: () => Promise.resolve([]),
    };
    const server = buildControlPlaneServer({
      tasks: {
        execute: () =>
          Promise.resolve({
            task: created,
            executionContextId: EXECUTION_CONTEXT_ID,
            l2AgentId: "l2_aaaaaaaaaaaaaaaaaaaa",
            reused: false,
          }),
      },
      reads,
      catalog: new DemoTenantCapabilityCatalog(),
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
      demoAdminEnabled: false,
    });
    servers.push(server);
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        request_id: "req_create",
        tenant_id: "tenant_A",
        biz_domain: "LEGAL",
        task_type: "LEGAL_EVIDENCE_CHECK",
        resource: { resource_type: "CASE", resource_id: "case_001" },
        input: { question: "check" },
      },
    });
    expect(createResponse.statusCode).toBe(202);
    expect(createResponse.json()).toMatchObject({
      success: true,
      code: "TASK_ACCEPTED",
      request_id: "req_create",
      data: {
        task_id: "task_demo",
        logical_agent_id: LOGICAL_AGENT_ID,
        runtime_instance_id: RUNTIME_ID,
      },
      error: null,
    });

    const getResponse = await server.inject({
      method: "GET",
      url: "/api/tasks/task_demo?request_id=req_get&tenant_id=tenant_A&biz_domain=LEGAL",
    });
    expect(getResponse.statusCode).toBe(200);
    expect(readScopes).toEqual([SCOPE]);

    const invalidResponse = await server.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "x-request-id": "req_invalid" },
      payload: { request_id: "req_invalid" },
    });
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.json()).toMatchObject({
      success: false,
      code: "INVALID_REQUEST",
      request_id: "req_invalid",
      error: { reason: "VALIDATION_FAILED" },
    });
  });

  it("resolves compose-compatible loopback hosts and custom service ports", () => {
    expect(
      resolveControlPlaneListenAddress({
        AGENTNEST_BIND_HOST: "127.0.0.1",
        CONTROL_PLANE_PORT: "28080",
      }),
    ).toEqual({ host: "127.0.0.1", port: 28_080 });
    expect(
      resolveDataGatewayListenAddress({
        AGENTNEST_BIND_HOST: "127.0.0.1",
        DATA_GATEWAY_MOCK_PORT: "28081",
      }),
    ).toEqual({ host: "127.0.0.1", port: 28_081 });
    expect(
      resolveExternalGatewayListenAddress({
        AGENTNEST_BIND_HOST: "127.0.0.1",
        EXTERNAL_GATEWAY_MOCK_PORT: "28082",
      }),
    ).toEqual({ host: "127.0.0.1", port: 28_082 });
    expect(() => resolveControlPlaneListenAddress({ AGENTNEST_BIND_HOST: "0.0.0.0" })).toThrow(
      /127\.0\.0\.1/u,
    );
  });

  it("classifies a provider billing rejection for the API without echoing credentials", async () => {
    const result = await new NodeOpenClawCommandRunner().run({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('Arrearage'); process.exit(1)"],
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(78);
  });
});
