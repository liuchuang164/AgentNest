import { Type, type TSchema } from "@sinclair/typebox";

import {
  AgentStateSchema,
  CapabilitySnapshotSchema,
  CapabilityTokenClaimsSchema,
  TaskRequestSchema,
  TraceEventSchema,
} from "./schemas.js";
import { L1RuntimeStatus, L2TaskStatus } from "./states.js";

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
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
      logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
      runtime_instance_id: IdentifierSchema,
      status: Type.Literal(L2TaskStatus.QUEUED),
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
      logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
      runtime_instance_id: IdentifierSchema,
      l2_session_id: Type.Union([IdentifierSchema, Type.Null()]),
      current_step: Type.String({ minLength: 1 }),
      result: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
      created_at: Type.String({ format: "date-time", pattern: "Z$" }),
      updated_at: Type.String({ format: "date-time", pattern: "Z$" }),
    },
    { additionalProperties: false },
  ),
);

const AgentStatusResponseSchema = responseEnvelope(
  Type.Object(
    {
      logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
      tenant_id: IdentifierSchema,
      biz_domain: Type.String({ pattern: "^[A-Z][A-Z0-9_]*$" }),
      status: Type.Union(Object.values(L1RuntimeStatus).map((status) => Type.Literal(status))),
      current_runtime_instance_id: Type.Union([IdentifierSchema, Type.Null()]),
      capability_snapshot_id: IdentifierSchema,
      active_l2_count: Type.Integer({ minimum: 0 }),
      last_active_at: Type.String({ format: "date-time", pattern: "Z$" }),
    },
    { additionalProperties: false },
  ),
);
const AdminActionResponseSchema = responseEnvelope(
  Type.Object(
    {
      logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
      status: Type.Union(Object.values(L1RuntimeStatus).map((status) => Type.Literal(status))),
    },
    { additionalProperties: false },
  ),
);
const ReaperResponseSchema = responseEnvelope(
  Type.Object(
    {
      scanned: Type.Integer({ minimum: 0 }),
      l1_candidates: Type.Integer({ minimum: 0 }),
      l1_unloaded: Type.Integer({ minimum: 0 }),
      l2_candidates: Type.Integer({ minimum: 0 }),
      l2_archived: Type.Integer({ minimum: 0 }),
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
      now: Type.String({ format: "date-time", pattern: "Z$" }),
    },
    { additionalProperties: false },
  ),
);
const HealthResponseSchema = responseEnvelope(
  Type.Object(
    {
      status: Type.Union([Type.Literal("ok"), Type.Literal("not_ready")]),
      checks: Type.Record(
        Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" }),
        Type.Boolean(),
        { additionalProperties: false },
      ),
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
): Readonly<Record<string, unknown>> => ({
  "application/json": { schema },
});

const standardResponses = (successSchema: string): Readonly<Record<string, unknown>> => ({
  "200": {
    description: "Successful request",
    content: jsonContent(schemaReference(successSchema)),
  },
  "400": {
    description: "Invalid request",
    content: jsonContent(schemaReference("StandardErrorResponse")),
  },
  "401": {
    description: "Authentication required",
    content: jsonContent(schemaReference("StandardErrorResponse")),
  },
  "403": {
    description: "Capability denied",
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

const idempotencyHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", minLength: 8, maxLength: 256 },
} as const;

const adminBody = {
  required: true,
  content: jsonContent({
    type: "object",
    additionalProperties: false,
    required: ["request_id", "idempotency_key", "reason"],
    properties: {
      request_id: IdentifierSchema,
      idempotency_key: { type: "string", minLength: 8, maxLength: 256 },
      reason: { type: "string", minLength: 1, maxLength: 256 },
    },
  }),
} as const;

export const openApiDocument: Readonly<Record<string, unknown>> = {
  openapi: "3.1.0",
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "AgentNest Control Plane API",
    version: "0.1.0",
    description: "Tenant and business scoped control-plane contract for the AgentNest demo.",
  },
  servers: [{ url: "http://127.0.0.1:18080" }],
  tags: [{ name: "tasks" }, { name: "agents" }, { name: "admin" }, { name: "health" }],
  paths: {
    "/api/v1/tasks": {
      post: {
        operationId: "submitTask",
        tags: ["tasks"],
        security: [{ DemoBearerAuth: [] }],
        parameters: [idempotencyHeader],
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
    "/api/v1/tasks/{taskId}": {
      get: {
        operationId: "getTask",
        tags: ["tasks"],
        security: [{ DemoBearerAuth: [] }],
        parameters: [
          requestIdHeader,
          {
            name: "taskId",
            in: "path",
            required: true,
            schema: IdentifierSchema,
          },
        ],
        responses: standardResponses("TaskStatusResponse"),
      },
    },
    "/api/v1/agents/{logicalAgentId}": {
      get: {
        operationId: "getAgent",
        tags: ["agents"],
        security: [{ DemoBearerAuth: [] }],
        parameters: [
          requestIdHeader,
          {
            name: "logicalAgentId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^tb_[a-f0-9]{20}$" },
          },
        ],
        responses: standardResponses("AgentStatusResponse"),
      },
    },
    "/api/v1/admin/agents/{logicalAgentId}/checkpoint": {
      post: {
        operationId: "checkpointAgent",
        tags: ["admin"],
        security: [{ AdminBearerAuth: [] }],
        parameters: [
          idempotencyHeader,
          {
            name: "logicalAgentId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^tb_[a-f0-9]{20}$" },
          },
        ],
        requestBody: adminBody,
        responses: standardResponses("AdminActionResponse"),
      },
    },
    "/api/v1/admin/agents/{logicalAgentId}/unload": {
      post: {
        operationId: "unloadAgent",
        tags: ["admin"],
        security: [{ AdminBearerAuth: [] }],
        parameters: [
          idempotencyHeader,
          {
            name: "logicalAgentId",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^tb_[a-f0-9]{20}$" },
          },
        ],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            additionalProperties: false,
            required: ["request_id", "idempotency_key", "reason", "force"],
            properties: {
              request_id: IdentifierSchema,
              idempotency_key: { type: "string", minLength: 8, maxLength: 256 },
              reason: { type: "string", minLength: 1, maxLength: 256 },
              force: { type: "boolean", const: false },
            },
          }),
        },
        responses: standardResponses("AdminActionResponse"),
      },
    },
    "/api/v1/admin/reaper/run-once": {
      post: {
        operationId: "runReaperOnce",
        tags: ["admin"],
        security: [{ AdminBearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: jsonContent({
            type: "object",
            additionalProperties: false,
            required: ["request_id", "idempotency_key"],
            properties: {
              request_id: IdentifierSchema,
              idempotency_key: { type: "string", minLength: 8, maxLength: 256 },
            },
          }),
        },
        responses: standardResponses("ReaperResponse"),
      },
    },
    "/api/v1/admin/test-clock/advance": {
      post: {
        operationId: "advanceTestClock",
        description: "Available only in test or demo profiles on loopback/private bindings.",
        tags: ["admin"],
        security: [{ AdminBearerAuth: [] }],
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: jsonContent(schemaReference("ClockAdvanceRequest")),
        },
        responses: standardResponses("ClockAdvanceResponse"),
      },
    },
    "/health/live": {
      get: {
        operationId: "getLiveness",
        tags: ["health"],
        parameters: [requestIdHeader],
        responses: {
          "200": {
            description: "Process is alive",
            content: jsonContent(schemaReference("HealthResponse")),
          },
        },
      },
    },
    "/health/ready": {
      get: {
        operationId: "getReadiness",
        tags: ["health"],
        parameters: [requestIdHeader],
        responses: {
          "200": {
            description: "Dependencies are ready",
            content: jsonContent(schemaReference("HealthResponse")),
          },
          "503": {
            description: "A required dependency is unavailable",
            content: jsonContent(schemaReference("HealthResponse")),
          },
        },
      },
    },
    "/metrics": {
      get: {
        operationId: "getMetrics",
        tags: ["health"],
        parameters: [requestIdHeader],
        responses: {
          "200": {
            description: "Prometheus text exposition",
            headers: {
              "X-Request-Id": { schema: IdentifierSchema },
              "X-Trace-Id": { schema: IdentifierSchema },
            },
            content: {
              "text/plain": { schema: { type: "string" } },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      DemoBearerAuth: { type: "http", scheme: "bearer" },
      AdminBearerAuth: { type: "http", scheme: "bearer" },
    },
    schemas: {
      TaskRequest: TaskRequestSchema,
      CapabilitySnapshot: CapabilitySnapshotSchema,
      CapabilityTokenClaims: CapabilityTokenClaimsSchema,
      AgentState: AgentStateSchema,
      TraceEvent: TraceEventSchema,
      TaskAcceptedResponse: TaskAcceptedResponseSchema,
      TaskStatusResponse: TaskStatusResponseSchema,
      AgentStatusResponse: AgentStatusResponseSchema,
      AdminActionResponse: AdminActionResponseSchema,
      ReaperResponse: ReaperResponseSchema,
      ClockAdvanceResponse: ClockAdvanceResponseSchema,
      HealthResponse: HealthResponseSchema,
      StandardErrorResponse: StandardErrorResponseSchema,
      ClockAdvanceRequest: Type.Object(
        {
          request_id: IdentifierSchema,
          idempotency_key: Type.String({ minLength: 8, maxLength: 256 }),
          seconds: Type.Integer({ minimum: 0, maximum: 604_800 }),
        },
        { additionalProperties: false },
      ),
    },
  },
};
