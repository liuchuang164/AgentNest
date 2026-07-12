import { ExecutionContextSchema, type ExecutionContext } from "@agentnest/contracts";
import type { ExecutionContextRecord } from "@agentnest/persistence";
import { FormatRegistry, Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import Fastify, { type FastifyInstance } from "fastify";

export const dataGatewayServiceName = "agentnest-data-gateway-mock";

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

export const DataGatewayToolRequestSchema = Type.Object(
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

export type DataGatewayToolRequest = Static<typeof DataGatewayToolRequestSchema>;

const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });
const LegalAnalysisParamsSchema = Type.Object(
  { analysis: Type.String({ minLength: 1, maxLength: 2_000 }) },
  { additionalProperties: false },
);
const RobotHealthParamsSchema = Type.Object(
  {
    health_status: Type.Union([
      Type.Literal("HEALTHY"),
      Type.Literal("DEGRADED"),
      Type.Literal("FAULT"),
    ]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
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

export const GatewayDecision = {
  ALLOW: "ALLOW",
  DENY: "DENY",
} as const;

export type GatewayDecision = (typeof GatewayDecision)[keyof typeof GatewayDecision];

export const GatewayDenyReason = {
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

export type GatewayDenyReason = (typeof GatewayDenyReason)[keyof typeof GatewayDenyReason];

export interface GatewayTraceRecord {
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
  readonly decision: GatewayDecision;
  readonly reason: string;
  readonly createdAt: string;
}

export interface GatewayTraceSink {
  append(record: GatewayTraceRecord): Promise<void>;
}

export interface ExecutionContextLookup {
  findExecutionContext(executionContextId: string): Promise<unknown>;
}

export interface GatewayExecutionContextRecordLookup {
  findByGatewayId(executionContextId: string): Promise<ExecutionContextRecord | null>;
}

/** Maps the persistence camelCase record into the contracts/Gateway shape. */
export class PostgresDataGatewayExecutionContextLookup implements ExecutionContextLookup {
  readonly #repository: GatewayExecutionContextRecordLookup;

  public constructor(repository: GatewayExecutionContextRecordLookup) {
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

export interface GatewayClock {
  now(): Date;
}

export interface DataGatewayToolExecutionIdentity {
  readonly scope: {
    readonly tenantId: string;
    readonly bizDomain: string;
  };
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface DataGatewayToolOnceResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly executed: boolean;
}

/** Minimal port implemented by the control-plane DemoToolOnceGuard. */
export interface DataGatewayToolOnceGuard {
  execute(
    identity: DataGatewayToolExecutionIdentity,
    operation: () => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<DataGatewayToolOnceResult>;
}

export interface DataGatewayResponse {
  readonly success: boolean;
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: Readonly<{ reason: string }> | null;
}

interface LegalCaseFixture {
  readonly tenantId: string;
  readonly bizDomain: "LEGAL";
  readonly resourceId: string;
  readonly title: string;
  readonly facts: readonly string[];
}

interface RobotDeviceFixture {
  readonly tenantId: string;
  readonly bizDomain: "ROBOT_DOG";
  readonly resourceId: string;
  readonly model: string;
  readonly firmware: string;
}

interface LegalAnalysisFixture {
  readonly resultId: string;
  readonly tenantId: string;
  readonly bizDomain: "LEGAL";
  readonly resourceId: string;
  readonly analysis: string;
}

interface RobotHealthFixture {
  readonly resultId: string;
  readonly tenantId: string;
  readonly bizDomain: "ROBOT_DOG";
  readonly resourceId: string;
  readonly healthStatus: "HEALTHY" | "DEGRADED" | "FAULT";
  readonly note: string | null;
}

interface DataOperationFixture {
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceId: string;
}

export interface DataGatewayFixtureSnapshot {
  readonly legalAnalyses: readonly LegalAnalysisFixture[];
  readonly robotHealthResults: readonly RobotHealthFixture[];
  readonly operations: readonly DataOperationFixture[];
}

export interface DataGatewayPersistenceOperation {
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

export interface DataGatewayPersistence {
  ownsResource(
    tenantId: string,
    bizDomain: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean>;
  executeDataOperation(
    input: DataGatewayPersistenceOperation,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export class InMemoryDataGatewayFixtures implements DataGatewayPersistence {
  readonly #legalCases: readonly LegalCaseFixture[];
  readonly #robotDevices: readonly RobotDeviceFixture[];
  readonly #legalAnalyses: LegalAnalysisFixture[] = [];
  readonly #robotHealthResults: RobotHealthFixture[] = [];
  readonly #operations: DataOperationFixture[] = [];

  public constructor() {
    this.#legalCases = Object.freeze([
      Object.freeze({
        tenantId: "tenant_A",
        bizDomain: "LEGAL",
        resourceId: "case_001",
        title: "Alpha contract evidence",
        facts: Object.freeze(["alpha-signed-contract", "alpha-payment-record"]),
      }),
      Object.freeze({
        tenantId: "tenant_B",
        bizDomain: "LEGAL",
        resourceId: "case_001",
        title: "Beta delivery evidence",
        facts: Object.freeze(["beta-delivery-note", "beta-email-confirmation"]),
      }),
      Object.freeze({
        tenantId: "tenant_B",
        bizDomain: "LEGAL",
        resourceId: "case_B_only",
        title: "Beta private case",
        facts: Object.freeze(["beta-private-fact"]),
      }),
    ]);
    this.#robotDevices = Object.freeze([
      Object.freeze({
        tenantId: "tenant_A",
        bizDomain: "ROBOT_DOG",
        resourceId: "device_001",
        model: "AgentNest-Dog-1",
        firmware: "demo-1.0.0",
      }),
    ]);
  }

  #findLegalCase(tenantId: string, bizDomain: string, resourceId: string): LegalCaseFixture | null {
    return (
      this.#legalCases.find(
        (fixture) =>
          fixture.tenantId === tenantId &&
          fixture.bizDomain === bizDomain &&
          fixture.resourceId === resourceId,
      ) ?? null
    );
  }

  #findRobotDevice(
    tenantId: string,
    bizDomain: string,
    resourceId: string,
  ): RobotDeviceFixture | null {
    return (
      this.#robotDevices.find(
        (fixture) =>
          fixture.tenantId === tenantId &&
          fixture.bizDomain === bizDomain &&
          fixture.resourceId === resourceId,
      ) ?? null
    );
  }

  #recordLegalAnalysis(
    tenantId: string,
    resourceId: string,
    analysis: string,
  ): LegalAnalysisFixture {
    const result = Object.freeze({
      resultId: `legal_analysis_${String(this.#legalAnalyses.length + 1).padStart(3, "0")}`,
      tenantId,
      bizDomain: "LEGAL",
      resourceId,
      analysis,
    });
    this.#legalAnalyses.push(result);
    return result;
  }

  #recordRobotHealth(
    tenantId: string,
    resourceId: string,
    healthStatus: "HEALTHY" | "DEGRADED" | "FAULT",
    note: string | null,
  ): RobotHealthFixture {
    const result = Object.freeze({
      resultId: `robot_health_${String(this.#robotHealthResults.length + 1).padStart(3, "0")}`,
      tenantId,
      bizDomain: "ROBOT_DOG",
      resourceId,
      healthStatus,
      note,
    });
    this.#robotHealthResults.push(result);
    return result;
  }

  #recordOperation(operation: DataOperationFixture): void {
    this.#operations.push(Object.freeze({ ...operation }));
  }

  public ownsResource(
    tenantId: string,
    bizDomain: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean> {
    if (resourceType === "CASE") {
      return Promise.resolve(this.#findLegalCase(tenantId, bizDomain, resourceId) !== null);
    }
    if (resourceType === "DEVICE") {
      return Promise.resolve(this.#findRobotDevice(tenantId, bizDomain, resourceId) !== null);
    }
    return Promise.resolve(false);
  }

  public executeDataOperation(
    input: DataGatewayPersistenceOperation,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#recordOperation({
      tenantId: input.tenantId,
      bizDomain: input.bizDomain,
      toolName: input.toolName,
      action: input.action,
      resourceId: input.resourceId,
    });
    if (input.toolName === "legal_case_read") {
      const legalCase = this.#findLegalCase(input.tenantId, input.bizDomain, input.resourceId);
      return Promise.resolve({
        resource_id: input.resourceId,
        title: legalCase?.title ?? "",
        facts: legalCase?.facts ?? [],
      });
    }
    if (input.toolName === "legal_analysis_write") {
      const analysis = input.params["analysis"];
      if (typeof analysis !== "string") {
        throw new TypeError("analysis must be a string");
      }
      const result = this.#recordLegalAnalysis(input.tenantId, input.resourceId, analysis);
      return Promise.resolve({ result_id: result.resultId, stored: true });
    }
    if (input.toolName === "robot_device_read") {
      const device = this.#findRobotDevice(input.tenantId, input.bizDomain, input.resourceId);
      return Promise.resolve({
        resource_id: input.resourceId,
        model: device?.model ?? "",
        firmware: device?.firmware ?? "",
      });
    }
    if (input.toolName === "robot_health_write") {
      const healthStatus = input.params["health_status"];
      if (healthStatus !== "HEALTHY" && healthStatus !== "DEGRADED" && healthStatus !== "FAULT") {
        throw new TypeError("health_status is invalid");
      }
      const note = input.params["note"];
      if (note !== undefined && typeof note !== "string") {
        throw new TypeError("note must be a string");
      }
      const result = this.#recordRobotHealth(
        input.tenantId,
        input.resourceId,
        healthStatus,
        note ?? null,
      );
      return Promise.resolve({ result_id: result.resultId, stored: true });
    }
    throw new TypeError("unsupported Data Gateway operation");
  }

  public snapshot(): DataGatewayFixtureSnapshot {
    return structuredClone({
      legalAnalyses: this.#legalAnalyses,
      robotHealthResults: this.#robotHealthResults,
      operations: this.#operations,
    });
  }
}

export class InMemoryGatewayTraceSink implements GatewayTraceSink {
  public readonly records: GatewayTraceRecord[] = [];

  public append(record: GatewayTraceRecord): Promise<void> {
    this.records.push(structuredClone(record));
    return Promise.resolve();
  }
}

export interface DataGatewayApplicationOptions {
  readonly contextLookup: ExecutionContextLookup;
  readonly traceSink: GatewayTraceSink;
  readonly fixtures: DataGatewayPersistence;
  readonly clock: GatewayClock;
  readonly toolOnceGuard: DataGatewayToolOnceGuard;
}

interface ToolDefinition {
  readonly action: "read" | "write";
  readonly bizDomain: "LEGAL" | "ROBOT_DOG";
  readonly resourceType: "CASE" | "DEVICE";
}

const DATA_TOOL_DEFINITIONS: Readonly<Record<string, ToolDefinition>> = Object.freeze({
  legal_case_read: Object.freeze({ action: "read", bizDomain: "LEGAL", resourceType: "CASE" }),
  legal_analysis_write: Object.freeze({
    action: "write",
    bizDomain: "LEGAL",
    resourceType: "CASE",
  }),
  robot_device_read: Object.freeze({
    action: "read",
    bizDomain: "ROBOT_DOG",
    resourceType: "DEVICE",
  }),
  robot_health_write: Object.freeze({
    action: "write",
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

function responseStatus(response: DataGatewayResponse): number {
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

export class DataGatewayApplication {
  readonly #contextLookup: ExecutionContextLookup;
  readonly #traceSink: GatewayTraceSink;
  readonly #fixtures: DataGatewayPersistence;
  readonly #clock: GatewayClock;
  readonly #toolOnceGuard: DataGatewayToolOnceGuard;

  public constructor(options: DataGatewayApplicationOptions) {
    this.#contextLookup = options.contextLookup;
    this.#traceSink = options.traceSink;
    this.#fixtures = options.fixtures;
    this.#clock = options.clock;
    this.#toolOnceGuard = options.toolOnceGuard;
  }

  public async execute(untrustedInput: unknown): Promise<DataGatewayResponse> {
    const clone = cloneUnknown(untrustedInput);
    if (clone === null || !Value.Check(DataGatewayToolRequestSchema, clone)) {
      return this.#deny(null, null, GatewayDenyReason.INVALID_REQUEST, untrustedInput);
    }
    const request = clone;
    let rawContext: unknown;
    try {
      rawContext = await this.#contextLookup.findExecutionContext(request.execution_context_id);
    } catch {
      return this.#deny(request, null, GatewayDenyReason.CONTEXT_LOOKUP_FAILED, untrustedInput);
    }
    if (rawContext === null) {
      return this.#deny(request, null, GatewayDenyReason.CONTEXT_UNKNOWN, untrustedInput);
    }
    const contextClone = cloneUnknown(rawContext);
    if (contextClone === null || !Value.Check(ExecutionContextSchema, contextClone)) {
      return this.#deny(request, null, GatewayDenyReason.CONTEXT_INVALID, untrustedInput);
    }
    const context = contextClone;
    if (Date.parse(context.expires_at) <= this.#clock.now().getTime()) {
      return this.#deny(request, context, GatewayDenyReason.CONTEXT_EXPIRED, untrustedInput);
    }

    const allowedActions = context.allowed_tools[request.tool_name];
    if (!allowedActions?.includes(request.action)) {
      return this.#deny(request, context, GatewayDenyReason.TOOL_ACTION_DENIED, untrustedInput);
    }
    const definition = DATA_TOOL_DEFINITIONS[request.tool_name];
    if (definition?.action !== request.action) {
      return this.#deny(request, context, GatewayDenyReason.TOOL_UNSUPPORTED, untrustedInput);
    }
    if (definition.bizDomain !== context.biz_domain) {
      return this.#deny(request, context, GatewayDenyReason.BIZ_DOMAIN_DENIED, untrustedInput);
    }
    if (
      request.resource.resource_type !== context.resource_scope.resource_type ||
      !context.resource_scope.resource_ids.includes(request.resource.resource_id) ||
      definition.resourceType !== request.resource.resource_type
    ) {
      return this.#deny(request, context, GatewayDenyReason.RESOURCE_SCOPE_DENIED, untrustedInput);
    }
    if (!(await this.#ownsResource(context, request))) {
      return this.#deny(
        request,
        context,
        GatewayDenyReason.RESOURCE_OWNERSHIP_DENIED,
        untrustedInput,
      );
    }
    if (!this.#hasValidParams(request)) {
      return this.#deny(request, context, GatewayDenyReason.INVALID_TOOL_PARAMS, untrustedInput);
    }

    const toolResult = await this.#executeTool(context, request, definition);
    await this.#trace(
      request,
      context,
      GatewayDecision.ALLOW,
      toolResult.executed ? "TOOL_EXECUTED" : "TOOL_RESULT_REUSED",
    );
    return Object.freeze({
      success: true,
      code: "OK",
      message: "tool executed",
      request_id: request.request_id,
      trace_id: request.trace_id,
      data: Object.freeze(toolResult.result),
      error: null,
    });
  }

  #ownsResource(context: ExecutionContext, request: DataGatewayToolRequest): Promise<boolean> {
    return this.#fixtures.ownsResource(
      context.tenant_id,
      context.biz_domain,
      request.resource.resource_type,
      request.resource.resource_id,
    );
  }

  #hasValidParams(request: DataGatewayToolRequest): boolean {
    if (request.tool_name === "legal_case_read" || request.tool_name === "robot_device_read") {
      return Value.Check(EmptyParamsSchema, request.params);
    }
    if (request.tool_name === "legal_analysis_write") {
      return Value.Check(LegalAnalysisParamsSchema, request.params);
    }
    if (request.tool_name === "robot_health_write") {
      return Value.Check(RobotHealthParamsSchema, request.params);
    }
    return false;
  }

  async #executeTool(
    context: ExecutionContext,
    request: DataGatewayToolRequest,
    definition: ToolDefinition,
  ): Promise<DataGatewayToolOnceResult> {
    if (definition.action === "read") {
      return {
        result: await this.#executeFixtureOperation(context, request),
        executed: true,
      };
    }

    return this.#toolOnceGuard.execute(
      {
        scope: {
          tenantId: context.tenant_id,
          bizDomain: context.biz_domain,
        },
        logicalAgentId: context.logical_agent_id,
        runtimeInstanceId: context.runtime_instance_id,
        sessionId: context.session_id,
        taskId: context.task_id,
        toolName: request.tool_name,
        action: definition.action,
        resourceType: definition.resourceType,
        resourceId: request.resource.resource_id,
      },
      () => this.#executeFixtureOperation(context, request),
    );
  }

  #executeFixtureOperation(
    context: ExecutionContext,
    request: DataGatewayToolRequest,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#fixtures.executeDataOperation({
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
    request: DataGatewayToolRequest | null,
    context: ExecutionContext | null,
    reason: GatewayDenyReason,
    originalInput: unknown,
  ): Promise<DataGatewayResponse> {
    const requestId =
      request?.request_id ?? safeCorrelation(originalInput, "request_id", "invalid_request");
    const traceId =
      request?.trace_id ?? safeCorrelation(originalInput, "trace_id", "invalid_trace");
    await this.#trace(request, context, GatewayDecision.DENY, reason, requestId, traceId);
    const code =
      reason === GatewayDenyReason.INVALID_REQUEST
        ? "INVALID_REQUEST"
        : reason === GatewayDenyReason.CONTEXT_LOOKUP_FAILED
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
    request: DataGatewayToolRequest | null,
    context: ExecutionContext | null,
    decision: GatewayDecision,
    reason: string,
    requestId = request?.request_id ?? "invalid_request",
    traceId = request?.trace_id ?? "invalid_trace",
  ): Promise<void> {
    const createdAt = this.#clock.now().toISOString();
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
        createdAt,
      }),
    );
  }
}

export function buildDataGatewayMockServer(
  options: DataGatewayApplicationOptions,
): FastifyInstance {
  const server = Fastify({
    logger: false,
    ajv: {
      customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false },
    },
  });
  const application = new DataGatewayApplication(options);
  server.post<{ Body: unknown }>(
    "/v1/tools/execute",
    {
      attachValidation: true,
      schema: { body: DataGatewayToolRequestSchema },
    },
    async (request, reply) => {
      const response = await application.execute(request.body);
      return reply.code(responseStatus(response)).send(response);
    },
  );
  return server;
}
