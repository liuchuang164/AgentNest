import { Type, type TSchema } from "@sinclair/typebox";

import {
  AgentStateSchema,
  CapabilityProfileSchema,
  ExecutionContextSchema,
  IdentifierSchema,
  TaskRequestSchema,
  TraceEventSchema,
} from "./schemas.js";
import { L1RuntimeStatus, L2TaskStatus } from "./states.js";

const LogicalAgentIdSchema = Type.String({ pattern: "^tb_[a-f0-9]{20}$" });
const NullableErrorSchema = Type.Union([
  Type.Object(
    {
      category: Type.String({ minLength: 1, maxLength: 64 }),
      retryable: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

function responseEnvelope(data: TSchema): TSchema {
  return Type.Object(
    {
      success: Type.Boolean(),
      code: Type.String({ minLength: 1, maxLength: 64 }),
      message: Type.String({ maxLength: 512 }),
      request_id: IdentifierSchema,
      trace_id: IdentifierSchema,
      data: Type.Union([data, Type.Null()]),
      error: NullableErrorSchema,
    },
    { additionalProperties: false },
  );
}

const TaskAcceptedResponseSchema = responseEnvelope(
  Type.Object(
    {
      task_id: IdentifierSchema,
      logical_agent_id: LogicalAgentIdSchema,
      runtime_instance_id: IdentifierSchema,
      l2_agent_id: Type.Union([IdentifierSchema, Type.Null()]),
      status: Type.Union(Object.values(L2TaskStatus).map((status) => Type.Literal(status))),
    },
    { additionalProperties: false },
  ),
);
const TaskStatusResponseSchema = responseEnvelope(
  Type.Object(
    {
      task_id: IdentifierSchema,
      tenant_id: IdentifierSchema,
      biz_domain: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
      task_type: Type.String({ minLength: 1 }),
      status: Type.Union(Object.values(L2TaskStatus).map((status) => Type.Literal(status))),
      logical_agent_id: LogicalAgentIdSchema,
      runtime_instance_id: IdentifierSchema,
      l2_session_id: Type.Union([IdentifierSchema, Type.Null()]),
      result: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    },
    { additionalProperties: false },
  ),
);
const AgentSummarySchema = Type.Object(
  {
    logical_agent_id: LogicalAgentIdSchema,
    tenant_id: IdentifierSchema,
    biz_domain: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
    status: Type.Union(Object.values(L1RuntimeStatus).map((status) => Type.Literal(status))),
    current_runtime_instance_id: Type.Union([IdentifierSchema, Type.Null()]),
    active_l2_count: Type.Integer({ minimum: 0 }),
    skills: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    tools: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    ),
    last_active_at: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const AgentStatusResponseSchema = responseEnvelope(AgentSummarySchema);
const AgentListResponseSchema = responseEnvelope(Type.Array(AgentSummarySchema));
const MemoryListResponseSchema = responseEnvelope(
  Type.Array(
    Type.Object(
      {
        memory_id: IdentifierSchema,
        memory_type: Type.String({ minLength: 1 }),
        content: Type.String(),
        created_at: Type.String({ format: "date-time" }),
      },
      { additionalProperties: false },
    ),
  ),
);
const AdminActionResponseSchema = responseEnvelope(
  Type.Object(
    {
      logical_agent_id: Type.Union([LogicalAgentIdSchema, Type.Null()]),
      status: Type.Union([
        ...Object.values(L1RuntimeStatus).map((status) => Type.Literal(status)),
        Type.Literal("COMPLETED"),
      ]),
    },
    { additionalProperties: false },
  ),
);
const ReaperResponseSchema = responseEnvelope(
  Type.Object(
    {
      l1_scanned: Type.Integer({ minimum: 0 }),
      l1_unloaded: Type.Integer({ minimum: 0 }),
      l2_scanned: Type.Integer({ minimum: 0 }),
      l2_unloaded: Type.Integer({ minimum: 0 }),
      skipped_active: Type.Integer({ minimum: 0 }),
      failed: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
);
const ClockAdvanceResponseSchema = responseEnvelope(
  Type.Object(
    {
      advanced_seconds: Type.Integer({ minimum: 0, maximum: 604_800 }),
      now: Type.String({ format: "date-time" }),
    },
    { additionalProperties: false },
  ),
);
const HealthResponseSchema = responseEnvelope(
  Type.Object(
    {
      status: Type.Union([Type.Literal("ok"), Type.Literal("not_ready")]),
      checks: Type.Record(Type.String({ minLength: 1 }), Type.Boolean()),
    },
    { additionalProperties: false },
  ),
);
const StandardErrorResponseSchema = responseEnvelope(Type.Unknown());

const schemaReference = (name: string): Readonly<Record<string, string>> => ({
  $ref: `#/components/schemas/${name}`,
});
const jsonContent = (
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({ "application/json": { schema } });
const standardResponses = (successSchema: string): Readonly<Record<string, unknown>> => ({
  "200": {
    description: "Successful request",
    content: jsonContent(schemaReference(successSchema)),
  },
  "400": {
    description: "Invalid request",
    content: jsonContent(schemaReference("StandardErrorResponse")),
  },
  "403": {
    description: "Scope denied",
    content: jsonContent(schemaReference("StandardErrorResponse")),
  },
  "500": {
    description: "Internal service error",
    content: jsonContent(schemaReference("StandardErrorResponse")),
  },
});
const requestIdHeader = {
  name: "X-Request-Id",
  in: "header",
  required: true,
  schema: IdentifierSchema,
} as const;
const pathParameter = (name: string, schema: TSchema): Readonly<Record<string, unknown>> => ({
  name,
  in: "path",
  required: true,
  schema,
});
const adminBody = (properties: Readonly<Record<string, TSchema>> = {}) => ({
  required: true,
  content: jsonContent(
    Type.Object(
      {
        request_id: IdentifierSchema,
        idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        ...properties,
      },
      { additionalProperties: false },
    ),
  ),
});

export const openApiDocument: Readonly<Record<string, unknown>> = {
  openapi: "3.1.0",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "AgentNest Control Plane API",
    version: "0.2.0",
    description: "Lean tenant and business scoped AgentNest demo API.",
  },
  servers: [{ url: "http://127.0.0.1:18080" }],
  paths: {
    "/api/tasks": {
      post: {
        operationId: "submitTask",
        requestBody: {
          required: true,
          content: jsonContent(schemaReference("TaskRequest")),
        },
        responses: {
          ...standardResponses("TaskAcceptedResponse"),
          "202": {
            description: "Task accepted",
            content: jsonContent(schemaReference("TaskAcceptedResponse")),
          },
        },
      },
    },
    "/api/tasks/{taskId}": {
      get: {
        operationId: "getTask",
        parameters: [requestIdHeader, pathParameter("taskId", IdentifierSchema)],
        responses: standardResponses("TaskStatusResponse"),
      },
    },
    "/api/agents": {
      get: {
        operationId: "listAgents",
        parameters: [requestIdHeader],
        responses: standardResponses("AgentListResponse"),
      },
    },
    "/api/agents/{logicalAgentId}": {
      get: {
        operationId: "getAgent",
        parameters: [requestIdHeader, pathParameter("logicalAgentId", LogicalAgentIdSchema)],
        responses: standardResponses("AgentStatusResponse"),
      },
    },
    "/api/agents/{logicalAgentId}/memories": {
      get: {
        operationId: "listAgentMemories",
        parameters: [requestIdHeader, pathParameter("logicalAgentId", LogicalAgentIdSchema)],
        responses: standardResponses("MemoryListResponse"),
      },
    },
    "/api/admin/agents/{logicalAgentId}/checkpoint": {
      post: {
        operationId: "checkpointAgent",
        parameters: [pathParameter("logicalAgentId", LogicalAgentIdSchema)],
        requestBody: adminBody(),
        responses: standardResponses("AdminActionResponse"),
      },
    },
    "/api/admin/agents/{logicalAgentId}/unload": {
      post: {
        operationId: "unloadAgent",
        parameters: [pathParameter("logicalAgentId", LogicalAgentIdSchema)],
        requestBody: adminBody(),
        responses: standardResponses("AdminActionResponse"),
      },
    },
    "/api/admin/reaper/run": {
      post: {
        operationId: "runReaper",
        requestBody: adminBody(),
        responses: standardResponses("ReaperResponse"),
      },
    },
    "/api/admin/clock/advance": {
      post: {
        operationId: "advanceDemoClock",
        description: "Available only in test or demo profiles on loopback/private bindings.",
        requestBody: adminBody({ seconds: Type.Integer({ minimum: 0, maximum: 604_800 }) }),
        responses: standardResponses("ClockAdvanceResponse"),
      },
    },
    "/health": {
      get: {
        operationId: "getHealth",
        parameters: [requestIdHeader],
        responses: standardResponses("HealthResponse"),
      },
    },
  },
  components: {
    schemas: {
      TaskRequest: TaskRequestSchema,
      CapabilityProfile: CapabilityProfileSchema,
      ExecutionContext: ExecutionContextSchema,
      AgentState: AgentStateSchema,
      TraceEvent: TraceEventSchema,
      TaskAcceptedResponse: TaskAcceptedResponseSchema,
      TaskStatusResponse: TaskStatusResponseSchema,
      AgentListResponse: AgentListResponseSchema,
      AgentStatusResponse: AgentStatusResponseSchema,
      MemoryListResponse: MemoryListResponseSchema,
      AdminActionResponse: AdminActionResponseSchema,
      ReaperResponse: ReaperResponseSchema,
      ClockAdvanceResponse: ClockAdvanceResponseSchema,
      HealthResponse: HealthResponseSchema,
      StandardErrorResponse: StandardErrorResponseSchema,
    },
  },
};
