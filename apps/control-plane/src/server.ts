import { randomUUID } from "node:crypto";

import type { TenantCapabilityCatalog } from "@agentnest/capability";
import type { L1RuntimeStatus, TenantBizScope } from "@agentnest/contracts";
import type { MemoryRecord, TaskStateRecord } from "@agentnest/persistence";
import { Type, type Static } from "@sinclair/typebox";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { LifecycleReaperResult } from "./application/lifecycle-reaper.js";
import {
  TaskDispatchError,
  type DemoTaskOrchestrationResult,
  type TaskOrchestrator,
} from "./application/task-orchestrator.js";

const CorrelationSchema = Type.String({ minLength: 1, maxLength: 128 });
const IdempotencyKeySchema = Type.String({ minLength: 1, maxLength: 256 });
const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@-]*$",
});
const TenantIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});
const BizDomainSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_]*$",
});
const LogicalAgentIdSchema = Type.String({ pattern: "^tb_[a-f0-9]{20}$" });

const ScopedQuerySchema = Type.Object(
  {
    request_id: CorrelationSchema,
    tenant_id: TenantIdSchema,
    biz_domain: BizDomainSchema,
  },
  { additionalProperties: false },
);

const AgentParamsSchema = Type.Object(
  { logicalAgentId: LogicalAgentIdSchema },
  { additionalProperties: false },
);

const TaskParamsSchema = Type.Object({ taskId: IdentifierSchema }, { additionalProperties: false });

const JsonObjectSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 128 }),
  Type.Unknown(),
  { maxProperties: 100 },
);

export const CreateTaskApiSchema = Type.Object(
  {
    request_id: CorrelationSchema,
    idempotency_key: Type.Optional(IdempotencyKeySchema),
    tenant_id: TenantIdSchema,
    biz_domain: BizDomainSchema,
    user_id: Type.Optional(IdentifierSchema),
    task_type: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Z][A-Z0-9_]*$",
    }),
    resource: Type.Object(
      {
        resource_type: Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: "^[A-Z][A-Z0-9_]*$",
        }),
        resource_id: IdentifierSchema,
      },
      { additionalProperties: false },
    ),
    input: JsonObjectSchema,
  },
  { additionalProperties: false },
);

const AdminAgentBodySchema = Type.Object(
  {
    request_id: CorrelationSchema,
    idempotency_key: Type.Optional(IdempotencyKeySchema),
    tenant_id: TenantIdSchema,
    biz_domain: BizDomainSchema,
  },
  { additionalProperties: false },
);

const AdminRunBodySchema = Type.Object(
  {
    request_id: CorrelationSchema,
    idempotency_key: Type.Optional(IdempotencyKeySchema),
  },
  { additionalProperties: false },
);

const AdvanceClockBodySchema = Type.Object(
  {
    request_id: CorrelationSchema,
    idempotency_key: Type.Optional(IdempotencyKeySchema),
    seconds: Type.Integer({ minimum: 1, maximum: 604_800 }),
  },
  { additionalProperties: false },
);

type CreateTaskApiInput = Static<typeof CreateTaskApiSchema>;
type ScopedQuery = Static<typeof ScopedQuerySchema>;
type AgentParams = Static<typeof AgentParamsSchema>;
type TaskParams = Static<typeof TaskParamsSchema>;
type AdminAgentBody = Static<typeof AdminAgentBodySchema>;
type AdminRunBody = Static<typeof AdminRunBodySchema>;
type AdvanceClockBody = Static<typeof AdvanceClockBodySchema>;

export interface AgentReadRecord {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly status: L1RuntimeStatus;
  readonly currentRuntimeInstanceId: string | null;
  readonly lastActiveAt: Date;
  readonly capabilityProfileId: string;
  readonly activeL2Count: number;
}

export interface ControlPlaneReadRepository {
  checkHealth(): Promise<{ readonly postgres: boolean; readonly migrations: boolean }>;
  findTask(input: {
    readonly scope: TenantBizScope;
    readonly taskId: string;
  }): Promise<TaskStateRecord | null>;
  listAgents(scope: TenantBizScope): Promise<readonly AgentReadRecord[]>;
  findAgent(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<AgentReadRecord | null>;
  listMemories(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
    readonly limit?: number;
  }): Promise<readonly MemoryRecord[]>;
}

export interface ControlPlaneReadyStatus {
  readonly ready: boolean;
  readonly postgres: boolean;
  readonly migrations: boolean;
  readonly openclaw: boolean;
  readonly mainProfile: boolean;
}

export interface ControlPlaneHealthProbe {
  ready(): Promise<ControlPlaneReadyStatus>;
}

export interface ControlPlaneAdminActions {
  checkpoint(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<void>;
  unload(input: { readonly scope: TenantBizScope; readonly logicalAgentId: string }): Promise<void>;
  runReaper(): Promise<LifecycleReaperResult>;
  advanceClock(seconds: number): Promise<Date>;
}

export interface BuildControlPlaneServerOptions {
  readonly tasks: Pick<TaskOrchestrator, "execute">;
  readonly reads: ControlPlaneReadRepository;
  readonly catalog: TenantCapabilityCatalog;
  readonly health: ControlPlaneHealthProbe;
  readonly admin?: ControlPlaneAdminActions;
  readonly demoAdminEnabled?: boolean;
}

interface ApiEnvelope<TData> {
  readonly success: boolean;
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly data: TData | null;
  readonly error: Readonly<Record<string, unknown>> | null;
}

function traceId(): string {
  return `trace_${randomUUID()}`;
}

function scope(tenantId: string, bizDomain: string): TenantBizScope {
  return { tenantId, bizDomain };
}

function requestIdFromRequest(request: FastifyRequest): string {
  const header = request.headers["x-request-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 128) {
    return header;
  }
  for (const source of [request.body, request.query]) {
    if (source !== null && typeof source === "object" && !Array.isArray(source)) {
      const candidate = (source as Readonly<Record<string, unknown>>)["request_id"];
      if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128) {
        return candidate;
      }
    }
  }
  return `req_${randomUUID()}`;
}

function ok<TData>(
  requestId: string,
  code: string,
  message: string,
  data: TData,
  responseTraceId = traceId(),
): ApiEnvelope<TData> {
  return {
    success: true,
    code,
    message,
    request_id: requestId,
    trace_id: responseTraceId,
    data,
    error: null,
  };
}

function failed(
  requestId: string,
  code: string,
  message: string,
  reason: string,
  responseTraceId = traceId(),
  details: Readonly<Record<string, unknown>> = {},
): ApiEnvelope<never> {
  return {
    success: false,
    code,
    message,
    request_id: requestId,
    trace_id: responseTraceId,
    data: null,
    error: { reason, ...details },
  };
}

function taskData(result: DemoTaskOrchestrationResult) {
  return {
    task_id: result.task.taskId,
    logical_agent_id: result.task.logicalAgentId,
    runtime_instance_id: result.task.runtimeInstanceId,
    l2_agent_id: result.l2AgentId,
    status: result.task.status,
  };
}

function persistedTaskData(task: TaskStateRecord) {
  const childSessionKey = task.result?.["openclaw_child_session_key"];
  return {
    task_id: task.taskId,
    tenant_id: task.tenantId,
    biz_domain: task.bizDomain,
    task_type: task.taskType,
    status: task.status,
    logical_agent_id: task.logicalAgentId,
    runtime_instance_id: task.runtimeInstanceId,
    l2_session_id: typeof childSessionKey === "string" ? childSessionKey : task.sessionId,
    result: task.result,
  };
}

function memoryData(memory: MemoryRecord) {
  return {
    memory_id: memory.memoryId,
    memory_type: memory.memoryType,
    content: memory.content,
    created_at: memory.createdAt.toISOString(),
  };
}

function healthData(status: ControlPlaneReadyStatus) {
  return {
    status: status.ready ? "ok" : "not_ready",
    checks: {
      postgres: status.postgres,
      migrations: status.migrations,
      openclaw: status.openclaw,
      main_profile: status.mainProfile,
    },
  } as const;
}

function classifyError(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly reason: string;
} {
  if ((error instanceof Error && "validation" in error) || error instanceof TypeError) {
    return {
      status: 400,
      code: "INVALID_REQUEST",
      message: "request validation failed",
      reason: "VALIDATION_FAILED",
    };
  }
  if (
    error instanceof Error &&
    (error.name === "UnknownTenantBizScopeError" || error.name === "UnknownTaskTemplateError")
  ) {
    return {
      status: 400,
      code: "SCOPE_OR_TASK_NOT_CONFIGURED",
      message: "tenant/business scope or task type is not configured",
      reason: "NOT_CONFIGURED",
    };
  }
  if (error instanceof Error && error.name === "LifecycleAdminConflictError") {
    return {
      status: 409,
      code: "LIFECYCLE_CONFLICT",
      message: "lifecycle action cannot run in the current state",
      reason: "LIFECYCLE_CONFLICT",
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "request failed",
    reason: "INTERNAL_ERROR",
  };
}

/** Fastify API surface for the single-node Demo control plane. */
export function buildControlPlaneServer(options: BuildControlPlaneServerOptions): FastifyInstance {
  const server = Fastify({
    logger: false,
    ajv: {
      customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false },
    },
  });

  server.setNotFoundHandler(async (request, reply) => {
    const requestId = requestIdFromRequest(request);
    return await reply
      .code(404)
      .send(failed(requestId, "NOT_FOUND", "route not found", "ROUTE_NOT_FOUND"));
  });

  server.setErrorHandler(async (error, request, reply) => {
    const requestId = requestIdFromRequest(request);
    if (error instanceof TaskDispatchError) {
      return await reply
        .code(error.providerBlocked ? 503 : 502)
        .send(
          failed(
            requestId,
            error.providerBlocked ? "MODEL_PROVIDER_BLOCKED" : "OPENCLAW_DISPATCH_FAILED",
            error.providerBlocked
              ? "model provider billing or quota status blocked the task"
              : "OpenClaw did not complete the requested dispatch",
            error.providerBlocked ? "MODEL_PROVIDER_BLOCKED" : "OPENCLAW_DISPATCH_FAILED",
            traceId(),
            { task_id: error.task.taskId, status: error.task.status },
          ),
        );
    }
    const classified = classifyError(error);
    return await reply
      .code(classified.status)
      .send(failed(requestId, classified.code, classified.message, classified.reason));
  });

  server.get("/health/live", async (request, reply) => {
    const requestId = requestIdFromRequest(request);
    return await reply.code(200).send(
      ok(requestId, "OK", "service is live", {
        status: "ok",
        checks: { process: true },
      }),
    );
  });

  server.get("/health/ready", async (request, reply) => {
    const requestId = requestIdFromRequest(request);
    const status = await options.health.ready();
    return await reply
      .code(status.ready ? 200 : 503)
      .send(
        status.ready
          ? ok(requestId, "OK", "service is ready", healthData(status))
          : failed(
              requestId,
              "NOT_READY",
              "service dependencies are not ready",
              "DEPENDENCY_NOT_READY",
              traceId(),
              { ...status },
            ),
      );
  });

  server.get("/health", async (request, reply) => {
    const requestId = requestIdFromRequest(request);
    const status = await options.health.ready();
    return await reply
      .code(status.ready ? 200 : 503)
      .send(
        status.ready
          ? ok(requestId, "OK", "service is healthy", healthData(status))
          : failed(
              requestId,
              "NOT_READY",
              "service dependencies are not ready",
              "DEPENDENCY_NOT_READY",
              traceId(),
              { ...status },
            ),
      );
  });

  server.post<{ Body: CreateTaskApiInput }>(
    "/api/tasks",
    { schema: { body: CreateTaskApiSchema } },
    async (request, reply) => {
      const responseTraceId = traceId();
      const result = await options.tasks.execute({
        requestId: request.body.request_id,
        idempotencyKey: request.body.idempotency_key ?? request.body.request_id,
        traceId: responseTraceId,
        scope: scope(request.body.tenant_id, request.body.biz_domain),
        taskType: request.body.task_type,
        resourceType: request.body.resource.resource_type,
        resourceId: request.body.resource.resource_id,
        input: request.body.input,
      });
      return await reply
        .code(result.reused ? 200 : 202)
        .send(
          ok(
            request.body.request_id,
            result.reused ? "TASK_REUSED" : "TASK_ACCEPTED",
            result.reused ? "existing task returned" : "task accepted",
            taskData(result),
            responseTraceId,
          ),
        );
    },
  );

  server.get<{ Params: TaskParams; Querystring: ScopedQuery }>(
    "/api/tasks/:taskId",
    { schema: { params: TaskParamsSchema, querystring: ScopedQuerySchema } },
    async (request, reply) => {
      const task = await options.reads.findTask({
        scope: scope(request.query.tenant_id, request.query.biz_domain),
        taskId: request.params.taskId,
      });
      if (task === null) {
        return await reply
          .code(404)
          .send(
            failed(request.query.request_id, "TASK_NOT_FOUND", "task not found", "TASK_NOT_FOUND"),
          );
      }
      return await reply
        .code(200)
        .send(ok(request.query.request_id, "OK", "task found", persistedTaskData(task)));
    },
  );

  server.get<{ Querystring: ScopedQuery }>(
    "/api/agents",
    { schema: { querystring: ScopedQuerySchema } },
    async (request, reply) => {
      const requestedScope = scope(request.query.tenant_id, request.query.biz_domain);
      const records = await options.reads.listAgents(requestedScope);
      const data = await Promise.all(
        records.map(async (record) => {
          const profile = await options.catalog.resolveProfile(requestedScope);
          return {
            logical_agent_id: record.logicalAgentId,
            tenant_id: record.tenantId,
            biz_domain: record.bizDomain,
            status: record.status,
            current_runtime_instance_id: record.currentRuntimeInstanceId,
            active_l2_count: record.activeL2Count,
            skills: profile.skills,
            tools: profile.tools,
            last_active_at: record.lastActiveAt.toISOString(),
          };
        }),
      );
      return await reply.code(200).send(ok(request.query.request_id, "OK", "agents listed", data));
    },
  );

  server.get<{ Params: AgentParams; Querystring: ScopedQuery }>(
    "/api/agents/:logicalAgentId",
    { schema: { params: AgentParamsSchema, querystring: ScopedQuerySchema } },
    async (request, reply) => {
      const requestedScope = scope(request.query.tenant_id, request.query.biz_domain);
      const record = await options.reads.findAgent({
        scope: requestedScope,
        logicalAgentId: request.params.logicalAgentId,
      });
      if (record === null) {
        return await reply
          .code(404)
          .send(
            failed(
              request.query.request_id,
              "AGENT_NOT_FOUND",
              "agent not found",
              "AGENT_NOT_FOUND",
            ),
          );
      }
      const profile = await options.catalog.resolveProfile(requestedScope);
      return await reply.code(200).send(
        ok(request.query.request_id, "OK", "agent found", {
          logical_agent_id: record.logicalAgentId,
          tenant_id: record.tenantId,
          biz_domain: record.bizDomain,
          status: record.status,
          current_runtime_instance_id: record.currentRuntimeInstanceId,
          active_l2_count: record.activeL2Count,
          skills: profile.skills,
          tools: profile.tools,
          last_active_at: record.lastActiveAt.toISOString(),
        }),
      );
    },
  );

  server.get<{ Params: AgentParams; Querystring: ScopedQuery }>(
    "/api/agents/:logicalAgentId/memories",
    { schema: { params: AgentParamsSchema, querystring: ScopedQuerySchema } },
    async (request, reply) => {
      const memories = await options.reads.listMemories({
        scope: scope(request.query.tenant_id, request.query.biz_domain),
        logicalAgentId: request.params.logicalAgentId,
        limit: 100,
      });
      return await reply
        .code(200)
        .send(ok(request.query.request_id, "OK", "memories listed", memories.map(memoryData)));
    },
  );

  if (options.demoAdminEnabled === true) {
    if (options.admin === undefined) {
      throw new TypeError("Demo Admin routes require admin actions");
    }
    const admin = options.admin;
    server.post<{ Params: AgentParams; Body: AdminAgentBody }>(
      "/api/admin/agents/:logicalAgentId/checkpoint",
      { schema: { params: AgentParamsSchema, body: AdminAgentBodySchema } },
      async (request, reply) => {
        await admin.checkpoint({
          scope: scope(request.body.tenant_id, request.body.biz_domain),
          logicalAgentId: request.params.logicalAgentId,
        });
        return await reply.code(200).send(
          ok(request.body.request_id, "CHECKPOINT_COMPLETED", "checkpoint completed", {
            logical_agent_id: request.params.logicalAgentId,
            status: "COMPLETED",
          }),
        );
      },
    );

    server.post<{ Params: AgentParams; Body: AdminAgentBody }>(
      "/api/admin/agents/:logicalAgentId/unload",
      { schema: { params: AgentParamsSchema, body: AdminAgentBodySchema } },
      async (request, reply) => {
        await admin.unload({
          scope: scope(request.body.tenant_id, request.body.biz_domain),
          logicalAgentId: request.params.logicalAgentId,
        });
        return await reply.code(200).send(
          ok(request.body.request_id, "AGENT_UNLOADED", "agent unloaded", {
            logical_agent_id: request.params.logicalAgentId,
            status: "UNLOADED",
          }),
        );
      },
    );

    server.post<{ Body: AdminRunBody }>(
      "/api/admin/reaper/run",
      { schema: { body: AdminRunBodySchema } },
      async (request, reply) => {
        const result = await admin.runReaper();
        return await reply.code(200).send(
          ok(request.body.request_id, "REAPER_COMPLETED", "reaper completed", {
            l1_scanned: result.l1Scanned,
            l1_unloaded: result.l1Unloaded,
            l2_scanned: result.l2Scanned,
            l2_unloaded: result.l2Unloaded,
            skipped_active: result.skippedActive,
            failed: result.failed,
          }),
        );
      },
    );

    server.post<{ Body: AdvanceClockBody }>(
      "/api/admin/clock/advance",
      { schema: { body: AdvanceClockBodySchema } },
      async (request, reply) => {
        const now = await admin.advanceClock(request.body.seconds);
        return await reply.code(200).send(
          ok(request.body.request_id, "CLOCK_ADVANCED", "Demo clock advanced", {
            now: now.toISOString(),
            advanced_seconds: request.body.seconds,
          }),
        );
      },
    );
  }

  return server;
}
