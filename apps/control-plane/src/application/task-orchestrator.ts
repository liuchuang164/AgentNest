import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  intersectForTask,
  normalizeTenantBizScope,
  type EffectiveTaskCapability,
  type TenantCapabilityCatalog,
} from "@agentnest/capability";
import {
  L1RuntimeStatus,
  L2TaskStatus,
  TraceEventType,
  type CapabilityProfile,
  type TenantBizScope,
} from "@agentnest/contracts";
import type {
  OpenClawAdapter,
  OpenClawAgentProfileSpec,
  OpenClawAgentRunResult,
  OpenClawModelSpec,
} from "@agentnest/openclaw-adapter";
import type {
  ExecutionContextRecord,
  PostgresPhase5PersistenceRepository,
  TaskStateRecord,
  TenantRuntimeLifecycleRepository,
} from "@agentnest/persistence";

import type { CreateTaskExecutionContext } from "./create-task-execution-context.js";
import type { ActiveTenantBizAgent, EnsureTenantBizAgent } from "./ensure-tenant-biz-agent.js";

const ALL_BUSINESS_TOOLS = Object.freeze([
  "legal_analysis_write",
  "legal_case_read",
  "legal_research_query",
  "robot_device_read",
  "robot_health_write",
  "robot_telemetry_enrich",
]);

const L1_RUNTIME_TOOLS = Object.freeze([
  "read",
  "session_status",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
]);

export type TaskJsonObject = Readonly<Record<string, unknown>>;

export interface CreateDemoTaskInput {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly scope: TenantBizScope;
  readonly taskType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly input: TaskJsonObject;
}

export interface DemoTaskOrchestrationResult {
  readonly task: TaskStateRecord;
  readonly executionContextId: string | null;
  readonly l2AgentId: string;
  readonly reused: boolean;
}

export type TaskPersistence = Pick<
  PostgresPhase5PersistenceRepository,
  "appendTrace" | "findTaskState" | "saveSessionSummary" | "saveTaskState"
>;

type TaskOpenClawAdapter = Pick<
  OpenClawAdapter,
  "dispatchToAgent" | "ensureProfile" | "exportSessionHistory"
> &
  Partial<Pick<OpenClawAdapter, "createSession">>;

export type TaskDispatchMode = "l0" | "l1";

export interface TaskOrchestratorClock {
  now(): Date;
}

export interface TaskProfilePair {
  readonly l1: OpenClawAgentProfileSpec;
  readonly l2: OpenClawAgentProfileSpec;
  readonly l2AgentId: string;
}

export interface TaskOpenClawProfileFactory {
  build(input: {
    readonly activeAgent: ActiveTenantBizAgent;
    readonly effectiveCapability: EffectiveTaskCapability;
    readonly taskType: string;
  }): TaskProfilePair;
}

export interface OpenClawTaskProfileFactoryOptions {
  readonly runtimeRoot: string;
  readonly model?: OpenClawModelSpec;
}

export class TaskDispatchError extends Error {
  public constructor(
    message: string,
    public readonly task: TaskStateRecord,
    public readonly providerBlocked: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskDispatchError";
  }
}

function isProviderBlockedCause(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === "OpenClawCommandError" &&
    (("providerBlocked" in cause && cause.providerBlocked === true) ||
      ("exitCode" in cause && cause.exitCode === 78))
  );
}

export function deriveTaskId(scope: TenantBizScope, idempotencyKey: string): string {
  const normalized = normalizeTenantBizScope(scope);
  const key = idempotencyKey.normalize("NFKC").trim();
  if (key.length === 0 || key.length > 256) {
    throw new TypeError("idempotency_key must contain between 1 and 256 characters");
  }
  const digest = createHash("sha256")
    .update(`${normalized.tenantId}:${normalized.bizDomain}:${key}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `task_${digest}`;
}

export function deriveL2AgentId(logicalAgentId: string, taskType: string): string {
  if (!/^tb_[a-f0-9]{20}$/u.test(logicalAgentId)) {
    throw new TypeError("logicalAgentId must be a stable tenant/business ID");
  }
  const normalizedTaskType = taskType.normalize("NFKC").trim();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(normalizedTaskType)) {
    throw new TypeError("taskType must be an uppercase identifier");
  }
  const digest = createHash("sha256")
    .update(`${logicalAgentId}:${normalizedTaskType}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `l2_${digest}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function profilePath(root: string, kind: "agents" | "workspaces", agentId: string): string {
  const candidate = resolve(root, kind, agentId, ...(kind === "agents" ? ["agent"] : []));
  const prefix = `${root}/`;
  if (candidate !== root && !candidate.startsWith(prefix)) {
    throw new TypeError("OpenClaw profile path escapes the configured runtime root");
  }
  return candidate;
}

/** Builds the same stable Profile layout used by the Phase 3 remote configurator. */
export class OpenClawTaskProfileFactory implements TaskOpenClawProfileFactory {
  readonly #runtimeRoot: string;

  public constructor(private readonly options: OpenClawTaskProfileFactoryOptions) {
    if (!isAbsolute(options.runtimeRoot)) {
      throw new TypeError("OpenClaw runtime root must be absolute");
    }
    this.#runtimeRoot = resolve(options.runtimeRoot);
  }

  public build(input: {
    readonly activeAgent: ActiveTenantBizAgent;
    readonly effectiveCapability: EffectiveTaskCapability;
    readonly taskType: string;
  }): TaskProfilePair {
    const l1AgentId = input.activeAgent.logicalAgent.logicalAgentId;
    const l2AgentId = deriveL2AgentId(l1AgentId, input.taskType);
    const l1Tools = sortedUnique([
      ...L1_RUNTIME_TOOLS,
      ...Object.keys(input.activeAgent.capabilityProfile.tools),
    ]);
    const l2Tools = sortedUnique(["read", ...Object.keys(input.effectiveCapability.tools)]);
    const l1Denied = ALL_BUSINESS_TOOLS.filter((tool) => !l1Tools.includes(tool));
    const l2Denied = ALL_BUSINESS_TOOLS.filter((tool) => !l2Tools.includes(tool));
    const model = this.options.model;

    return {
      l2AgentId,
      l1: {
        agentId: l1AgentId,
        workspace: profilePath(this.#runtimeRoot, "workspaces", l1AgentId),
        agentDir: profilePath(this.#runtimeRoot, "agents", l1AgentId),
        ...(model === undefined ? {} : { model }),
        skills: sortedUnique(input.activeAgent.capabilityProfile.skills),
        tools: { allow: l1Tools, deny: l1Denied },
        subagents: { allowAgents: [l2AgentId], requireAgentId: true },
      },
      l2: {
        agentId: l2AgentId,
        workspace: profilePath(this.#runtimeRoot, "workspaces", l2AgentId),
        agentDir: profilePath(this.#runtimeRoot, "agents", l2AgentId),
        ...(model === undefined ? {} : { model }),
        skills: sortedUnique(input.effectiveCapability.skills),
        tools: { allow: l2Tools, deny: l2Denied },
        subagents: { allowAgents: [], requireAgentId: true },
      },
    };
  }
}

export interface TaskOrchestratorOptions {
  readonly dispatchMode?: TaskDispatchMode;
  readonly childCompletionTimeoutMs?: number;
  readonly childPollIntervalMs?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly restoreContextLoader?: TaskRestoreContextLoader;
}

export interface TaskRestoreContextLoader {
  load(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
    readonly restoredFromRuntimeInstanceId: string;
  }): Promise<TaskJsonObject>;
}

function findChildSessionKey(value: unknown, l2AgentId: string): string | null {
  const visited = new WeakSet<object>();
  const pending: unknown[] = [value];
  const prefix = `agent:${l2AgentId}:subagent:`;
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      const start = current.indexOf(prefix);
      if (start >= 0) {
        const candidate = current.slice(start).split(/[^A-Za-z0-9_:@.-]/u)[0];
        if (candidate?.startsWith(prefix) === true) {
          return candidate;
        }
      }
      continue;
    }
    if (current === null || typeof current !== "object" || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const nested: readonly unknown[] = Array.isArray(current)
      ? (current as readonly unknown[])
      : Object.values(current as Readonly<Record<string, unknown>>);
    pending.push(...nested);
  }
  return null;
}

function safeRunResult(
  run: OpenClawAgentRunResult,
  l2AgentId: string,
  l1SessionKey: string,
): TaskJsonObject {
  return {
    openclaw_run_id: run.runId,
    openclaw_status: run.status,
    openclaw_session_key: run.sessionKey,
    openclaw_child_session_key: findChildSessionKey(run.raw, l2AgentId),
    openclaw_l1_session_key: l1SessionKey,
  };
}

export function l1RuntimeSessionKey(logicalAgentId: string, runtimeInstanceId: string): string {
  if (!/^tb_[a-f0-9]{20}$/u.test(logicalAgentId)) {
    throw new TypeError("logicalAgentId must be a stable tenant/business ID");
  }
  const normalizedRuntimeId = runtimeInstanceId.normalize("NFKC").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(normalizedRuntimeId)) {
    throw new TypeError("runtimeInstanceId must be a canonical identifier");
  }
  return `agent:${logicalAgentId}:runtime-${normalizedRuntimeId}`;
}

export function formatTaskControllerEnvelope(executionContextId: string, prompt: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      executionContextId,
    )
  ) {
    throw new TypeError("executionContextId must be a UUID");
  }
  return `AGENTNEST_CONTROLLER_CONTEXT_V1 ${JSON.stringify({
    execution_context_id: executionContextId,
  })}\n${prompt}`;
}

function scopedProfile(profile: CapabilityProfile): TenantBizScope {
  return { tenantId: profile.tenant_id, bizDomain: profile.biz_domain };
}

export class TaskOrchestrator {
  readonly #dispatchMode: TaskDispatchMode;
  readonly #childCompletionTimeoutMs: number;
  readonly #childPollIntervalMs: number;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #restoreContextLoader: TaskRestoreContextLoader | undefined;
  readonly #pendingTasks = new Map<string, Promise<void>>();

  public constructor(
    private readonly catalog: TenantCapabilityCatalog,
    private readonly ensureAgent: EnsureTenantBizAgent,
    private readonly runtimes: TenantRuntimeLifecycleRepository,
    private readonly contexts: CreateTaskExecutionContext,
    private readonly persistence: TaskPersistence,
    private readonly openclaw: TaskOpenClawAdapter,
    private readonly profiles: TaskOpenClawProfileFactory,
    private readonly clock: TaskOrchestratorClock,
    options: TaskOrchestratorOptions = {},
  ) {
    this.#dispatchMode = options.dispatchMode ?? "l0";
    this.#restoreContextLoader = options.restoreContextLoader;
    this.#childCompletionTimeoutMs = options.childCompletionTimeoutMs ?? 300_000;
    this.#childPollIntervalMs = options.childPollIntervalMs ?? 2_000;
    this.#wait =
      options.wait ??
      (async (milliseconds) => {
        await new Promise<void>((resolveWait) => {
          setTimeout(resolveWait, milliseconds);
        });
      });
    if (
      !Number.isSafeInteger(this.#childCompletionTimeoutMs) ||
      this.#childCompletionTimeoutMs < 0 ||
      !Number.isSafeInteger(this.#childPollIntervalMs) ||
      this.#childPollIntervalMs < 1
    ) {
      throw new TypeError("child completion polling options are invalid");
    }
  }

  public async execute(input: CreateDemoTaskInput): Promise<DemoTaskOrchestrationResult> {
    const scope = normalizeTenantBizScope(input.scope);
    const taskId = deriveTaskId(scope, input.idempotencyKey);
    return this.withTaskLock(taskId, async () => {
      const existing = await this.persistence.findTaskState({ scope, taskId });
      if (existing !== null) {
        return {
          task: existing,
          executionContextId: null,
          l2AgentId: deriveL2AgentId(existing.logicalAgentId, existing.taskType),
          reused: true,
        };
      }

      const [activeAgent, template] = await Promise.all([
        this.ensureAgent.execute(scope),
        this.catalog.resolveTaskTemplate(input.taskType),
      ]);
      const profile = activeAgent.capabilityProfile;
      const authoritativeScope = scopedProfile(profile);
      if (
        authoritativeScope.tenantId !== scope.tenantId ||
        authoritativeScope.bizDomain !== scope.bizDomain ||
        template.bizDomain !== scope.bizDomain
      ) {
        throw new TypeError("task type does not belong to the requested tenant/business scope");
      }
      const effective = intersectForTask(profile, template);
      const pair = this.profiles.build({
        activeAgent,
        effectiveCapability: effective,
        taskType: input.taskType,
      });
      const restoreContext = await this.loadRestoreContext(activeAgent, scope);
      const l1SessionKey = l1RuntimeSessionKey(
        activeAgent.logicalAgent.logicalAgentId,
        activeAgent.runtime.runtimeInstanceId,
      );

      await this.openclaw.ensureProfile(pair.l2);
      await this.openclaw.ensureProfile(pair.l1);
      await this.openclaw.createSession?.({
        agentId: pair.l1.agentId,
        sessionKey: l1SessionKey,
        label: `AgentNest ${scope.tenantId}/${scope.bizDomain} L1`,
      });
      const now = this.validNow();
      await this.runtimes.markRuntimeReady({
        scope,
        logicalAgentId: activeAgent.logicalAgent.logicalAgentId,
        runtimeInstanceId: activeAgent.runtime.runtimeInstanceId,
        status: L1RuntimeStatus.ACTIVE,
        now,
      });

      const identity = {
        scope,
        logicalAgentId: activeAgent.logicalAgent.logicalAgentId,
        runtimeInstanceId: activeAgent.runtime.runtimeInstanceId,
        sessionId: `agent:${pair.l2AgentId}:task-${taskId}`,
        taskId,
      } as const;
      const executionContext = await this.contexts.execute({
        ...identity,
        taskType: input.taskType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      });
      const persistedInput: TaskJsonObject = {
        request_id: input.requestId,
        resource: {
          resource_type: input.resourceType,
          resource_id: input.resourceId,
        },
        input: structuredClone(input.input),
      };
      await this.persistence.saveTaskState({
        ...identity,
        taskType: input.taskType,
        status: L2TaskStatus.QUEUED,
        currentStep: "OPENCLAW_DISPATCH",
        input: persistedInput,
        result: null,
        now,
      });
      let task: TaskStateRecord;

      try {
        task = await this.persistence.saveTaskState({
          ...identity,
          taskType: input.taskType,
          status: L2TaskStatus.SPAWNING,
          currentStep: "OPENCLAW_DISPATCH",
          input: persistedInput,
          result: null,
          now: this.validNow(),
        });
        const run = await this.dispatch({
          input,
          taskId,
          identity,
          executionContext,
          l2AgentId: pair.l2AgentId,
          l1SessionKey,
          restoreContext,
        });
        const status = await this.resolveTaskStatus(run, pair.l2AgentId);
        const completedAt = this.validNow();
        task = await this.persistence.saveTaskState({
          ...identity,
          taskType: input.taskType,
          status,
          currentStep:
            status === L2TaskStatus.COMPLETED
              ? "COMPLETED"
              : status === L2TaskStatus.FAILED
                ? "FAILED"
                : "OPENCLAW_RUNNING",
          input: persistedInput,
          result: safeRunResult(run, pair.l2AgentId, l1SessionKey),
          now: completedAt,
        });
        await this.persistence.appendTrace({
          ...identity,
          traceId: input.traceId,
          eventKey: "task-orchestration-dispatched",
          eventType: TraceEventType.L2_SPAWNED,
          decision: null,
          reason: null,
          event: {
            dispatch_mode: this.#dispatchMode,
            execution_context_id: executionContext.executionContextId,
            l2_agent_id: pair.l2AgentId,
            l1_session_key: l1SessionKey,
            task_status: status,
            restored_from_runtime_instance_id: activeAgent.runtime.restoredFromRuntimeInstanceId,
          },
          now: completedAt,
        });
        if ([L2TaskStatus.COMPLETED, L2TaskStatus.FAILED].includes(status)) {
          await this.persistence.saveSessionSummary({
            ...identity,
            summary:
              status === L2TaskStatus.COMPLETED
                ? `OpenClaw completed ${input.taskType} for ${input.resourceType}/${input.resourceId}.`
                : `OpenClaw child denied ${input.taskType} for ${input.resourceType}/${input.resourceId}.`,
            transcriptPath: `pending/${taskId}.jsonl`,
            now: completedAt,
          });
          await this.runtimes.markRuntimeReady({
            scope,
            logicalAgentId: identity.logicalAgentId,
            runtimeInstanceId: identity.runtimeInstanceId,
            status: L1RuntimeStatus.IDLE,
            now: completedAt,
          });
        }
        return {
          task,
          executionContextId: executionContext.executionContextId,
          l2AgentId: pair.l2AgentId,
          reused: false,
        };
      } catch (cause: unknown) {
        const failedAt = this.validNow();
        const providerBlocked = isProviderBlockedCause(cause);
        const failureCode = providerBlocked ? "MODEL_PROVIDER_BLOCKED" : "OPENCLAW_DISPATCH_FAILED";
        task = await this.persistence.saveTaskState({
          ...identity,
          taskType: input.taskType,
          status: L2TaskStatus.FAILED,
          currentStep: "OPENCLAW_DISPATCH",
          input: persistedInput,
          result: { error_code: failureCode },
          now: failedAt,
        });
        await this.persistence.appendTrace({
          ...identity,
          traceId: input.traceId,
          eventKey: "task-orchestration-dispatch-failed",
          eventType: TraceEventType.TOOL_CALL_DENIED,
          decision: null,
          reason: failureCode,
          event: {
            dispatch_mode: this.#dispatchMode,
            restored_from_runtime_instance_id: activeAgent.runtime.restoredFromRuntimeInstanceId,
          },
          now: failedAt,
        });
        await this.persistence.saveSessionSummary({
          ...identity,
          summary: `OpenClaw dispatch did not create a completed child for ${input.taskType}; failure=${failureCode}.`,
          transcriptPath: `pending/${taskId}.jsonl`,
          now: failedAt,
        });
        await this.runtimes.markRuntimeReady({
          scope,
          logicalAgentId: identity.logicalAgentId,
          runtimeInstanceId: identity.runtimeInstanceId,
          status: L1RuntimeStatus.IDLE,
          now: failedAt,
        });
        throw new TaskDispatchError(
          providerBlocked
            ? "The configured model provider rejected the task for billing or quota status"
            : "OpenClaw did not accept the task dispatch",
          task,
          providerBlocked,
          { cause },
        );
      }
    });
  }

  private async dispatch(input: {
    readonly input: CreateDemoTaskInput;
    readonly taskId: string;
    readonly identity: {
      readonly logicalAgentId: string;
      readonly sessionId: string;
    };
    readonly executionContext: ExecutionContextRecord;
    readonly l2AgentId: string;
    readonly l1SessionKey: string;
    readonly restoreContext: TaskJsonObject | null;
  }): Promise<OpenClawAgentRunResult> {
    const payload = {
      task_id: input.taskId,
      tenant_id: input.input.scope.tenantId,
      biz_domain: input.input.scope.bizDomain,
      task_type: input.input.taskType,
      resource_type: input.input.resourceType,
      resource_id: input.input.resourceId,
      execution_context_id: input.executionContext.executionContextId,
      l1_agent_id: input.identity.logicalAgentId,
      l1_session_key: input.l1SessionKey,
      l2_agent_id: input.l2AgentId,
      input: input.input.input,
      ...(input.restoreContext === null ? {} : { restored_context: input.restoreContext }),
    } as const;
    const controlledPrompt = formatTaskControllerEnvelope(
      input.executionContext.executionContextId,
      [
        "AgentNest controlled task. Preserve the controller context first line when creating the isolated L2 Session.",
        "Use native sessions_spawn exactly once for the specified L2 profile.",
        JSON.stringify(payload),
      ].join("\n"),
    );
    if (this.#dispatchMode === "l1") {
      return await this.openclaw.dispatchToAgent({
        agentId: input.identity.logicalAgentId,
        sessionKey: input.l1SessionKey,
        message: controlledPrompt,
        idempotencyKey: input.input.idempotencyKey,
      });
    }
    return await this.openclaw.dispatchToAgent({
      agentId: "main",
      sessionKey: `agent:main:${input.taskId}`,
      message: formatTaskControllerEnvelope(
        input.executionContext.executionContextId,
        [
          "AgentNest L0 controlled task. Route only to the specified L1; the L1 must use native sessions_spawn for the specified L2.",
          "Preserve the controller context first line when forwarding to L1 and L2.",
          JSON.stringify(payload),
        ].join("\n"),
      ),
      idempotencyKey: input.input.idempotencyKey,
    });
  }

  private async resolveTaskStatus(
    run: OpenClawAgentRunResult,
    l2AgentId: string,
  ): Promise<L2TaskStatus> {
    const childSessionKey = findChildSessionKey(run.raw, l2AgentId);
    if (childSessionKey === null) {
      return L2TaskStatus.FAILED;
    }
    if (this.#childCompletionTimeoutMs === 0) {
      return L2TaskStatus.RUNNING;
    }
    const deadline = Date.now() + this.#childCompletionTimeoutMs;
    while (Date.now() <= deadline) {
      try {
        const history = await this.openclaw.exportSessionHistory({
          agentId: l2AgentId,
          sessionKey: childSessionKey,
          limit: 20,
          maxChars: 16_000,
        });
        if (
          history.transcript.includes("AGENTNEST_L2_RESULT|") &&
          history.transcript.includes("|status=COMPLETED|")
        ) {
          return L2TaskStatus.COMPLETED;
        }
        if (
          history.transcript.includes("AGENTNEST_L2_RESULT|") &&
          history.transcript.includes("|status=DENIED|")
        ) {
          return L2TaskStatus.FAILED;
        }
      } catch {
        // The child Session can appear shortly after the parent accepts sessions_spawn.
      }
      await this.#wait(this.#childPollIntervalMs);
    }
    return L2TaskStatus.RUNNING;
  }

  private async loadRestoreContext(
    activeAgent: ActiveTenantBizAgent,
    scope: TenantBizScope,
  ): Promise<TaskJsonObject | null> {
    const restoredFromRuntimeInstanceId = activeAgent.runtime.restoredFromRuntimeInstanceId;
    if (
      activeAgent.reused ||
      restoredFromRuntimeInstanceId === null ||
      this.#restoreContextLoader === undefined
    ) {
      return null;
    }
    return structuredClone(
      await this.#restoreContextLoader.load({
        scope,
        logicalAgentId: activeAgent.logicalAgent.logicalAgentId,
        restoredFromRuntimeInstanceId,
      }),
    );
  }

  private validNow(): Date {
    const now = this.clock.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError("task clock returned an invalid Date");
    }
    return new Date(now.getTime());
  }

  private async withTaskLock<TResult>(
    taskId: string,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.#pendingTasks.get(taskId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.then(() => gate);
    this.#pendingTasks.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#pendingTasks.get(taskId) === current) {
        this.#pendingTasks.delete(taskId);
      }
    }
  }
}
