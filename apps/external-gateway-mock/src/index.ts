import { ExecutionContextSchema, type ExecutionContext } from "@agentnest/contracts";
import type { ExecutionContextRecord } from "@agentnest/persistence";
import { FormatRegistry, Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance } from "fastify";

export const externalGatewayServiceName = "agentnest-external-gateway-mock";

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
const CorrelationSchema = Type.String({ minLength: 1, maxLength: 128 });
const ToolNameSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9_]*$",
});
const ActionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]*$",
});
const ParamsSchema = Type.Record(
  Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" }),
  Type.Unknown(),
  { additionalProperties: false, maxProperties: 50 },
);

export const ExternalGatewayToolRequestSchema = Type.Object(
  {
    request_id: CorrelationSchema,
    trace_id: CorrelationSchema,
    execution_context_id: Type.String({ format: "uuid" }),
    tool_name: ToolNameSchema,
    action: ActionSchema,
    resource: Type.Object(
      {
        resource_type: Type.String({ minLength: 1, maxLength: 64 }),
        resource_id: IdentifierSchema,
      },
      { additionalProperties: false },
    ),
    params: ParamsSchema,
  },
  { additionalProperties: false },
);

export type ExternalGatewayToolRequest = Static<typeof ExternalGatewayToolRequestSchema>;

const LegalResearchParamsSchema = Type.Object(
  { query: Type.String({ minLength: 1, maxLength: 1_000 }) },
  { additionalProperties: false },
);
const RobotTelemetryParamsSchema = Type.Object(
  {
    telemetry: Type.Array(Type.Number({ minimum: -1_000, maximum: 1_000 }), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);

FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
);
FormatRegistry.Set(
  "date-time",
  (value) => value.endsWith("Z") && Number.isFinite(Date.parse(value)),
);

export const ExternalGatewayDecision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
} as const;

export type ExternalGatewayDecision =
  (typeof ExternalGatewayDecision)[keyof typeof ExternalGatewayDecision];

export const ExternalGatewayDenyReason = {
  INVALID_REQUEST: "INVALID_REQUEST",
  CONTEXT_UNKNOWN: "EXECUTION_CONTEXT_UNKNOWN",
  CONTEXT_INVALID: "EXECUTION_CONTEXT_INVALID",
  CONTEXT_EXPIRED: "EXECUTION_CONTEXT_EXPIRED",
  CONTEXT_LOOKUP_FAILED: "EXECUTION_CONTEXT_LOOKUP_FAILED",
  TOOL_ACTION_DENIED: "TOOL_ACTION_DENIED",
  TOOL_UNSUPPORTED: "TOOL_UNSUPPORTED",
  BIZ_DOMAIN_DENIED: "BIZ_DOMAIN_DENIED",
  RESOURCE_SCOPE_DENIED: "RESOURCE_SCOPE_DENIED",
  RESOURCE_OWNERSHIP_DENIED: "RESOURCE_OWNERSHIP_DENIED",
  INVALID_TOOL_PARAMS: "INVALID_TOOL_PARAMS",
} as const;

export type ExternalGatewayDenyReason =
  (typeof ExternalGatewayDenyReason)[keyof typeof ExternalGatewayDenyReason];

export interface ExternalGatewayTraceRecord {
  readonly requestId: string;
  readonly traceId: string;
  readonly executionContextId: string | null;
  readonly tenantId: string | null;
  readonly bizDomain: string | null;
  readonly logicalAgentId: string | null;
  readonly runtimeInstanceId: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly toolName: string | null;
  readonly action: string | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly decision: ExternalGatewayDecision;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ExternalGatewayTraceSink {
  append(record: ExternalGatewayTraceRecord): Promise<void>;
}

export interface ExternalExecutionContextLookup {
  findExecutionContext(executionContextId: string): Promise<unknown>;
}

export interface ExternalGatewayExecutionContextRecordLookup {
  findByGatewayId(executionContextId: string): Promise<ExecutionContextRecord | null>;
}

/** Maps the persistence camelCase record into the contracts/Gateway shape. */
export class PostgresExternalGatewayExecutionContextLookup implements ExternalExecutionContextLookup {
  readonly #repository: ExternalGatewayExecutionContextRecordLookup;

  public constructor(repository: ExternalGatewayExecutionContextRecordLookup) {
    this.#repository = repository;
  }

  public async findExecutionContext(executionContextId: string): Promise<unknown> {
    const record = await this.#repository.findByGatewayId(executionContextId);
    if (record === null) {
      return null;
    }
    const context: ExecutionContext = {
      execution_context_id: record.executionContextId,
      tenant_id: record.tenantId,
      biz_domain: record.bizDomain,
      logical_agent_id: record.logicalAgentId,
      runtime_instance_id: record.runtimeInstanceId,
      session_id: record.sessionId,
      task_id: record.taskId,
      allowed_skills: [...record.allowedSkills],
      allowed_tools: Object.fromEntries(
        Object.entries(record.allowedTools).map(([toolName, actions]) => [toolName, [...actions]]),
      ),
      resource_scope: {
        resource_type: record.resourceScope.resourceType,
        resource_ids: [...record.resourceScope.resourceIds],
      },
      expires_at: record.expiresAt.toISOString(),
    };
    deepFreeze(context);
    return context;
  }
}

export interface ExternalGatewayClock {
  now(): Date;
}

export interface ExternalGatewayResponse {
  readonly success: boolean;
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: Readonly<{ reason: string }> | null;
}

interface ExternalOperationFixture {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly toolName: string;
  readonly resourceId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface OwnedResourceFixture {
  readonly tenantId: string;
  readonly bizDomain: "LEGAL" | "ROBOT_DOG";
  readonly resourceType: "CASE" | "DEVICE";
  readonly resourceId: string;
}

export interface ExternalGatewayFixtureSnapshot {
  readonly operations: readonly ExternalOperationFixture[];
}

export interface ExternalGatewayPersistenceOperation {
  readonly requestId: string;
  readonly traceId: string;
  readonly executionContextId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly now: Date;
}

export interface ExternalGatewayPersistence {
  ownsResource(
    tenantId: string,
    bizDomain: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean>;
  executeExternalOperation(
    input: ExternalGatewayPersistenceOperation,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export class InMemoryExternalGatewayFixtures implements ExternalGatewayPersistence {
  readonly #resources: readonly OwnedResourceFixture[];
  readonly #operations: ExternalOperationFixture[] = [];

  public constructor() {
    this.#resources = Object.freeze([
      Object.freeze({
        tenantId: "tenant_A",
        bizDomain: "LEGAL",
        resourceType: "CASE",
        resourceId: "case_001",
      }),
      Object.freeze({
        tenantId: "tenant_B",
        bizDomain: "LEGAL",
        resourceType: "CASE",
        resourceId: "case_001",
      }),
      Object.freeze({
        tenantId: "tenant_B",
        bizDomain: "LEGAL",
        resourceType: "CASE",
        resourceId: "case_B_only",
      }),
      Object.freeze({
        tenantId: "tenant_A",
        bizDomain: "ROBOT_DOG",
        resourceType: "DEVICE",
        resourceId: "device_001",
      }),
    ]);
  }

  public ownsResource(
    tenantId: string,
    bizDomain: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.#resources.some(
        (resource) =>
          resource.tenantId === tenantId &&
          resource.bizDomain === bizDomain &&
          resource.resourceType === resourceType &&
          resource.resourceId === resourceId,
      ),
    );
  }

  public recordOperation(operation: ExternalOperationFixture): void {
    this.#operations.push(
      Object.freeze({ ...operation, params: Object.freeze(structuredClone(operation.params)) }),
    );
  }

  public executeExternalOperation(
    input: ExternalGatewayPersistenceOperation,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.recordOperation({
      tenantId: input.tenantId,
      bizDomain: input.bizDomain,
      toolName: input.toolName,
      resourceId: input.resourceId,
      params: input.params,
    });
    if (input.toolName === "legal_research_query") {
      const query = input.params["query"];
      if (typeof query !== "string") {
        throw new TypeError("query must be a string");
      }
      const tenantMarker = input.tenantId === "tenant_A" ? "ALPHA" : "BETA";
      return Promise.resolve({
        query,
        citations: [`${tenantMarker}-STATUTE-101`, `${tenantMarker}-PRECEDENT-7`],
      });
    }
    if (input.toolName === "robot_telemetry_enrich") {
      const telemetry = input.params["telemetry"];
      if (!Array.isArray(telemetry) || !telemetry.every((sample) => typeof sample === "number")) {
        throw new TypeError("telemetry must be a numeric array");
      }
      const sum = telemetry.reduce<number>((total, sample) => total + sample, 0);
      const average = sum / telemetry.length;
      return Promise.resolve({
        sample_count: telemetry.length,
        average,
        health_band: average >= 0 ? "NOMINAL" : "CHECK_REQUIRED",
      });
    }
    throw new TypeError("unsupported External Gateway operation");
  }

  public snapshot(): ExternalGatewayFixtureSnapshot {
    return structuredClone({ operations: this.#operations });
  }
}

export class InMemoryExternalGatewayTraceSink implements ExternalGatewayTraceSink {
  public readonly records: ExternalGatewayTraceRecord[] = [];

  public append(record: ExternalGatewayTraceRecord): Promise<void> {
    this.records.push(structuredClone(record));
    return Promise.resolve();
  }
}

export interface ExternalGatewayApplicationOptions {
  readonly contextLookup: ExternalExecutionContextLookup;
  readonly traceSink: ExternalGatewayTraceSink;
  readonly fixtures: ExternalGatewayPersistence;
  readonly clock: ExternalGatewayClock;
}

interface ExternalToolDefinition {
  readonly action: "query";
  readonly bizDomain: "LEGAL" | "ROBOT_DOG";
  readonly resourceType: "CASE" | "DEVICE";
}

const EXTERNAL_TOOL_DEFINITIONS: Readonly<Record<string, ExternalToolDefinition>> = Object.freeze({
  legal_research_query: Object.freeze({
    action: "query",
    bizDomain: "LEGAL",
    resourceType: "CASE",
  }),
  robot_telemetry_enrich: Object.freeze({
    action: "query",
    bizDomain: "ROBOT_DOG",
    resourceType: "DEVICE",
  }),
});

function deepFreeze(value: unknown, visited = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return;
  }
  visited.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, visited);
  }
  Object.freeze(value);
}

function cloneUnknown(value: unknown): unknown {
  try {
    const clone: unknown = structuredClone(value);
    deepFreeze(clone);
    return clone;
  } catch {
    return null;
  }
}

function safeCorrelation(value: unknown, key: "request_id" | "trace_id", fallback: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 128
    ? candidate
    : fallback;
}

function responseStatus(response: ExternalGatewayResponse): number {
  if (response.success) {
    return 200;
  }
  if (response.code === "INVALID_REQUEST") {
    return 400;
  }
  if (response.code === "CONTEXT_LOOKUP_FAILED") {
    return 503;
  }
  return 403;
}

export class ExternalGatewayApplication {
  readonly #contextLookup: ExternalExecutionContextLookup;
  readonly #traceSink: ExternalGatewayTraceSink;
  readonly #fixtures: ExternalGatewayPersistence;
  readonly #clock: ExternalGatewayClock;

  public constructor(options: ExternalGatewayApplicationOptions) {
    this.#contextLookup = options.contextLookup;
    this.#traceSink = options.traceSink;
    this.#fixtures = options.fixtures;
    this.#clock = options.clock;
  }

  public async execute(untrustedInput: unknown): Promise<ExternalGatewayResponse> {
    const clone = cloneUnknown(untrustedInput);
    if (clone === null || !Value.Check(ExternalGatewayToolRequestSchema, clone)) {
      return this.#deny(null, null, ExternalGatewayDenyReason.INVALID_REQUEST, untrustedInput);
    }
    const request = clone;
    let rawContext: unknown;
    try {
      rawContext = await this.#contextLookup.findExecutionContext(request.execution_context_id);
    } catch {
      return this.#deny(
        request,
        null,
        ExternalGatewayDenyReason.CONTEXT_LOOKUP_FAILED,
        untrustedInput,
      );
    }
    if (rawContext === null) {
      return this.#deny(request, null, ExternalGatewayDenyReason.CONTEXT_UNKNOWN, untrustedInput);
    }
    const contextClone = cloneUnknown(rawContext);
    if (contextClone === null || !Value.Check(ExecutionContextSchema, contextClone)) {
      return this.#deny(request, null, ExternalGatewayDenyReason.CONTEXT_INVALID, untrustedInput);
    }
    const context = contextClone;
    if (Date.parse(context.expires_at) <= this.#clock.now().getTime()) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.CONTEXT_EXPIRED,
        untrustedInput,
      );
    }

    const allowedActions = context.allowed_tools[request.tool_name];
    if (!allowedActions?.includes(request.action)) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.TOOL_ACTION_DENIED,
        untrustedInput,
      );
    }
    const definition = EXTERNAL_TOOL_DEFINITIONS[request.tool_name];
    if (definition?.action !== request.action) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.TOOL_UNSUPPORTED,
        untrustedInput,
      );
    }
    if (definition.bizDomain !== context.biz_domain) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.BIZ_DOMAIN_DENIED,
        untrustedInput,
      );
    }
    if (
      request.resource.resource_type !== context.resource_scope.resource_type ||
      !context.resource_scope.resource_ids.includes(request.resource.resource_id) ||
      definition.resourceType !== request.resource.resource_type
    ) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.RESOURCE_SCOPE_DENIED,
        untrustedInput,
      );
    }
    if (
      !(await this.#fixtures.ownsResource(
        context.tenant_id,
        context.biz_domain,
        request.resource.resource_type,
        request.resource.resource_id,
      ))
    ) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.RESOURCE_OWNERSHIP_DENIED,
        untrustedInput,
      );
    }
    if (!this.#hasValidParams(request)) {
      return this.#deny(
        request,
        context,
        ExternalGatewayDenyReason.INVALID_TOOL_PARAMS,
        untrustedInput,
      );
    }

    const data = await this.#executeTool(context, request);
    await this.#trace(request, context, ExternalGatewayDecision.ALLOW, "TOOL_EXECUTED");
    return Object.freeze({
      success: true,
      code: "OK",
      message: "tool executed",
      request_id: request.request_id,
      trace_id: request.trace_id,
      data: Object.freeze(data),
      error: null,
    });
  }

  #hasValidParams(request: ExternalGatewayToolRequest): boolean {
    if (request.tool_name === "legal_research_query") {
      return Value.Check(LegalResearchParamsSchema, request.params);
    }
    if (request.tool_name === "robot_telemetry_enrich") {
      return Value.Check(RobotTelemetryParamsSchema, request.params);
    }
    return false;
  }

  #executeTool(
    context: ExecutionContext,
    request: ExternalGatewayToolRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#fixtures.executeExternalOperation({
      requestId: request.request_id,
      traceId: request.trace_id,
      executionContextId: context.execution_context_id,
      tenantId: context.tenant_id,
      bizDomain: context.biz_domain,
      logicalAgentId: context.logical_agent_id,
      runtimeInstanceId: context.runtime_instance_id,
      sessionId: context.session_id,
      taskId: context.task_id,
      toolName: request.tool_name,
      action: request.action,
      resourceType: request.resource.resource_type,
      resourceId: request.resource.resource_id,
      params: request.params,
      now: this.#clock.now(),
    });
  }

  async #deny(
    request: ExternalGatewayToolRequest | null,
    context: ExecutionContext | null,
    reason: ExternalGatewayDenyReason,
    originalInput: unknown,
  ): Promise<ExternalGatewayResponse> {
    const requestId =
      request?.request_id ?? safeCorrelation(originalInput, "request_id", "invalid_request");
    const traceId =
      request?.trace_id ?? safeCorrelation(originalInput, "trace_id", "invalid_trace");
    await this.#trace(request, context, ExternalGatewayDecision.DENY, reason, requestId, traceId);
    const code =
      reason === ExternalGatewayDenyReason.INVALID_REQUEST
        ? "INVALID_REQUEST"
        : reason === ExternalGatewayDenyReason.CONTEXT_LOOKUP_FAILED
          ? "CONTEXT_LOOKUP_FAILED"
          : reason.startsWith("EXECUTION_CONTEXT_")
            ? "EXECUTION_CONTEXT_DENIED"
            : reason.includes("RESOURCE")
              ? "RESOURCE_NOT_ALLOWED"
              : "TOOL_NOT_ALLOWED";
    return Object.freeze({
      success: false,
      code,
      message: "tool execution denied",
      request_id: requestId,
      trace_id: traceId,
      data: null,
      error: Object.freeze({ reason }),
    });
  }

  async #trace(
    request: ExternalGatewayToolRequest | null,
    context: ExecutionContext | null,
    decision: ExternalGatewayDecision,
    reason: string,
    requestId = request?.request_id ?? "invalid_request",
    traceId = request?.trace_id ?? "invalid_trace",
  ): Promise<void> {
    await this.#traceSink.append(
      Object.freeze({
        requestId,
        traceId,
        executionContextId: request?.execution_context_id ?? null,
        tenantId: context?.tenant_id ?? null,
        bizDomain: context?.biz_domain ?? null,
        logicalAgentId: context?.logical_agent_id ?? null,
        runtimeInstanceId: context?.runtime_instance_id ?? null,
        sessionId: context?.session_id ?? null,
        taskId: context?.task_id ?? null,
        toolName: request?.tool_name ?? null,
        action: request?.action ?? null,
        resourceType: request?.resource.resource_type ?? null,
        resourceId: request?.resource.resource_id ?? null,
        decision,
        reason,
        createdAt: this.#clock.now().toISOString(),
      }),
    );
  }
}

export function buildExternalGatewayMockServer(
  options: ExternalGatewayApplicationOptions,
): FastifyInstance {
  const server = Fastify({
    logger: false,
    ajv: {
      customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false },
    },
  });
  const application = new ExternalGatewayApplication(options);
  server.post<{ Body: unknown }>(
    "/v1/tools/execute",
    {
      attachValidation: true,
      schema: { body: ExternalGatewayToolRequestSchema },
    },
    async (request, reply) => {
      const response = await application.execute(request.body);
      return reply.code(responseStatus(response)).send(response);
    },
  );
  return server;
}
