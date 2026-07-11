import { createHash } from "node:crypto";

import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginDefinition,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const pluginId = "agentnest-tenant-runtime";
export const controllerEnvelopePrefix = "AGENTNEST_CONTROLLER_CONTEXT_V1 ";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const AGENT_ID_PATTERN = "^[a-z][a-z0-9_-]{0,63}$";
const IDENTIFIER_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const BIZ_DOMAIN_PATTERN = "^[A-Z][A-Z0-9_]*$";

const AgentScopeSchema = Type.Object(
  {
    bizDomain: Type.String({ maxLength: 64, pattern: BIZ_DOMAIN_PATTERN }),
  },
  { additionalProperties: false },
);

export const TenantRuntimePluginConfigSchema = Type.Object(
  {
    dataGatewayUrl: Type.String({ minLength: 1, maxLength: 512 }),
    externalGatewayUrl: Type.String({ minLength: 1, maxLength: 512 }),
    requestTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: 30_000, default: 5_000 }),
    ),
    agentScopes: Type.Record(Type.String({ pattern: AGENT_ID_PATTERN }), AgentScopeSchema, {
      minProperties: 1,
    }),
  },
  { additionalProperties: false },
);

const ControllerEnvelopeSchema = Type.Object(
  {
    execution_context_id: Type.String({ pattern: UUID_PATTERN }),
  },
  { additionalProperties: false },
);

const ResourceIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: IDENTIFIER_PATTERN,
});
const ReadParametersSchema = Type.Object(
  { resource_id: ResourceIdSchema },
  { additionalProperties: false },
);
const LegalAnalysisParametersSchema = Type.Object(
  {
    resource_id: ResourceIdSchema,
    analysis: Type.String({ minLength: 1, maxLength: 2_000 }),
  },
  { additionalProperties: false },
);
const LegalResearchParametersSchema = Type.Object(
  {
    resource_id: ResourceIdSchema,
    query: Type.String({ minLength: 1, maxLength: 1_000 }),
  },
  { additionalProperties: false },
);
const RobotHealthParametersSchema = Type.Object(
  {
    resource_id: ResourceIdSchema,
    health_status: Type.Union([
      Type.Literal("HEALTHY"),
      Type.Literal("DEGRADED"),
      Type.Literal("FAULT"),
    ]),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  { additionalProperties: false },
);
const RobotTelemetryParametersSchema = Type.Object(
  {
    resource_id: ResourceIdSchema,
    telemetry: Type.Array(Type.Number({ minimum: -1_000, maximum: 1_000 }), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  { additionalProperties: false },
);

export const businessToolNames = [
  "legal_case_read",
  "legal_analysis_write",
  "legal_research_query",
  "robot_device_read",
  "robot_health_write",
  "robot_telemetry_enrich",
] as const;

export type BusinessToolName = (typeof businessToolNames)[number];
export type BizDomain = "LEGAL" | "ROBOT_DOG";
export type GatewayKind = "data" | "external";
export type ResourceType = "CASE" | "DEVICE";

interface AgentScope {
  readonly bizDomain: string;
}

export interface TenantRuntimePluginConfig {
  readonly dataGatewayUrl: string;
  readonly externalGatewayUrl: string;
  readonly requestTimeoutMs: number;
  readonly agentScopes: Readonly<Record<string, AgentScope>>;
}

interface ToolDefinition {
  readonly name: BusinessToolName;
  readonly label: string;
  readonly description: string;
  readonly bizDomain: BizDomain;
  readonly gateway: GatewayKind;
  readonly action: "read" | "write" | "query";
  readonly resourceType: ResourceType;
  readonly parameters: TSchema;
  readonly buildParams: (
    input: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

const readParams = (): Readonly<Record<string, unknown>> => Object.freeze({});

export const businessToolDefinitions: Readonly<Record<BusinessToolName, ToolDefinition>> =
  Object.freeze({
    legal_case_read: Object.freeze({
      name: "legal_case_read",
      label: "Read legal case",
      description: "Read one LEGAL case in the current AgentNest execution context.",
      bizDomain: "LEGAL",
      gateway: "data",
      action: "read",
      resourceType: "CASE",
      parameters: ReadParametersSchema,
      buildParams: readParams,
    }),
    legal_analysis_write: Object.freeze({
      name: "legal_analysis_write",
      label: "Write legal analysis",
      description: "Write deterministic analysis for one scoped LEGAL case.",
      bizDomain: "LEGAL",
      gateway: "data",
      action: "write",
      resourceType: "CASE",
      parameters: LegalAnalysisParametersSchema,
      buildParams: (input: Readonly<Record<string, unknown>>) =>
        Object.freeze({ analysis: input["analysis"] }),
    }),
    legal_research_query: Object.freeze({
      name: "legal_research_query",
      label: "Query legal research",
      description: "Run one deterministic research query for a scoped LEGAL case.",
      bizDomain: "LEGAL",
      gateway: "external",
      action: "query",
      resourceType: "CASE",
      parameters: LegalResearchParametersSchema,
      buildParams: (input: Readonly<Record<string, unknown>>) =>
        Object.freeze({ query: input["query"] }),
    }),
    robot_device_read: Object.freeze({
      name: "robot_device_read",
      label: "Read robot device",
      description: "Read one ROBOT_DOG device in the current AgentNest execution context.",
      bizDomain: "ROBOT_DOG",
      gateway: "data",
      action: "read",
      resourceType: "DEVICE",
      parameters: ReadParametersSchema,
      buildParams: readParams,
    }),
    robot_health_write: Object.freeze({
      name: "robot_health_write",
      label: "Write robot health",
      description: "Write deterministic health state for one scoped ROBOT_DOG device.",
      bizDomain: "ROBOT_DOG",
      gateway: "data",
      action: "write",
      resourceType: "DEVICE",
      parameters: RobotHealthParametersSchema,
      buildParams: (input: Readonly<Record<string, unknown>>) =>
        Object.freeze({
          health_status: input["health_status"],
          ...(input["note"] === undefined ? {} : { note: input["note"] }),
        }),
    }),
    robot_telemetry_enrich: Object.freeze({
      name: "robot_telemetry_enrich",
      label: "Enrich robot telemetry",
      description: "Enrich deterministic telemetry for one scoped ROBOT_DOG device.",
      bizDomain: "ROBOT_DOG",
      gateway: "external",
      action: "query",
      resourceType: "DEVICE",
      parameters: RobotTelemetryParametersSchema,
      buildParams: (input: Readonly<Record<string, unknown>>) =>
        Object.freeze({ telemetry: input["telemetry"] }),
    }),
  });

interface ExecutionContextBinding {
  readonly executionContextId: string;
  readonly agentId: string;
}

export class ExecutionContextBindingCache {
  readonly #bindings = new Map<string, ExecutionContextBinding>();

  public bind(sessionKey: string, agentId: string, executionContextId: string): void {
    this.#bindings.set(sessionKey, Object.freeze({ executionContextId, agentId }));
  }

  public clear(sessionKey: string): void {
    this.#bindings.delete(sessionKey);
  }

  public resolve(sessionKey: string, agentId: string): string | null {
    const binding = this.#bindings.get(sessionKey);
    return binding?.agentId === agentId ? binding.executionContextId : null;
  }
}

export class TenantRuntimeToolDeniedError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super(`AgentNest tenant runtime tool denied: ${code}`);
    this.name = "TenantRuntimeToolDeniedError";
    this.code = code;
  }
}

export type GatewayFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TrustedAgentRunContext {
  readonly agentId?: string;
  readonly sessionKey?: string;
}

export type InputGateDecision =
  | { readonly outcome: "pass" }
  | {
      readonly outcome: "block";
      readonly reason: string;
      readonly message?: string;
      readonly category?: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrivateGatewayHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")) {
    return true;
  }
  if (hostname.startsWith("10.") || hostname.startsWith("192.168.")) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (ipv4 !== null) {
    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    return first === 172 && second >= 16 && second <= 31;
  }
  return /^[a-z][a-z0-9-]{0,62}$/u.test(hostname);
}

function normalizeGatewayUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("Gateway URL must be an absolute private HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    !isPrivateGatewayHostname(parsed.hostname)
  ) {
    throw new TypeError("Gateway URL must be an absolute private HTTP URL");
  }
  parsed.pathname = "/";
  return parsed.toString().replace(/\/$/u, "");
}

export function parsePluginConfig(value: unknown): TenantRuntimePluginConfig | null {
  if (
    !Value.Check(TenantRuntimePluginConfigSchema, value) ||
    !Object.keys(value.agentScopes).every((agentId) =>
      new RegExp(AGENT_ID_PATTERN, "u").test(agentId),
    )
  ) {
    return null;
  }
  const agentScopes: Record<string, AgentScope> = {};
  for (const [agentId, scope] of Object.entries(value.agentScopes)) {
    agentScopes[agentId] = Object.freeze({
      bizDomain: scope.bizDomain,
    });
  }
  try {
    return Object.freeze({
      dataGatewayUrl: normalizeGatewayUrl(value.dataGatewayUrl),
      externalGatewayUrl: normalizeGatewayUrl(value.externalGatewayUrl),
      requestTimeoutMs: value.requestTimeoutMs ?? 5_000,
      agentScopes: Object.freeze(agentScopes),
    });
  } catch {
    return null;
  }
}

export function formatControllerEnvelope(executionContextId: string, prompt: string): string {
  const envelope = { execution_context_id: executionContextId };
  if (!Value.Check(ControllerEnvelopeSchema, envelope)) {
    throw new TypeError("executionContextId must be a UUID");
  }
  return `${controllerEnvelopePrefix}${JSON.stringify(envelope)}\n${prompt}`;
}

function parseControllerEnvelope(prompt: string): string | null {
  const firstLineEnd = prompt.search(/\r?\n/u);
  const firstLine = firstLineEnd === -1 ? prompt : prompt.slice(0, firstLineEnd);
  if (!firstLine.startsWith(controllerEnvelopePrefix)) {
    return null;
  }
  const rawEnvelope = firstLine.slice(controllerEnvelopePrefix.length);
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawEnvelope);
  } catch {
    return null;
  }
  if (
    !Value.Check(ControllerEnvelopeSchema, envelope) ||
    firstLine !== `${controllerEnvelopePrefix}${JSON.stringify(envelope)}`
  ) {
    return null;
  }
  return envelope.execution_context_id;
}

function correlationId(prefix: string, values: readonly string[]): string {
  const digest = createHash("sha256")
    .update(values.join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function safeGatewayResult(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value) || value["success"] !== true || typeof value["code"] !== "string") {
    return null;
  }
  return Object.freeze(structuredClone(value));
}

export class TenantRuntimePluginRuntime {
  readonly #config: TenantRuntimePluginConfig | null;
  readonly #bindings: ExecutionContextBindingCache;
  readonly #fetch: GatewayFetch;

  public constructor(options: {
    readonly config: TenantRuntimePluginConfig | null;
    readonly bindings?: ExecutionContextBindingCache;
    readonly fetch?: GatewayFetch;
  }) {
    this.#config = options.config;
    this.#bindings = options.bindings ?? new ExecutionContextBindingCache();
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  public beforeAgentRun(prompt: string, context: TrustedAgentRunContext): InputGateDecision {
    const { agentId, sessionKey } = context;
    if (agentId === undefined || sessionKey === undefined) {
      return { outcome: "pass" };
    }
    const scope = this.#config?.agentScopes[agentId];
    if (scope === undefined) {
      this.#bindings.clear(sessionKey);
      return { outcome: "pass" };
    }
    this.#bindings.clear(sessionKey);
    const executionContextId = parseControllerEnvelope(prompt);
    if (executionContextId === null) {
      return {
        outcome: "block",
        reason: "controller execution context envelope missing or invalid",
        message: "AgentNest execution context is required for this agent.",
        category: "agentnest_context_missing",
      };
    }
    this.#bindings.bind(sessionKey, agentId, executionContextId);
    return { outcome: "pass" };
  }

  public createTool(
    name: BusinessToolName,
    context: OpenClawPluginToolContext,
  ): AnyAgentTool | null {
    const definition = businessToolDefinitions[name];
    const agentId = context.agentId;
    const sessionKey = context.sessionKey;
    if (this.#config === null || agentId === undefined || sessionKey === undefined) {
      return null;
    }
    const scope = this.#config.agentScopes[agentId];
    if (scope?.bizDomain !== definition.bizDomain) {
      return null;
    }
    return {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (toolCallId: string, params: unknown, signal?: AbortSignal) => {
        if (!Value.Check(definition.parameters, params) || !isRecord(params)) {
          throw new TenantRuntimeToolDeniedError("TOOL_INPUT_INVALID");
        }
        const executionContextId = this.#bindings.resolve(sessionKey, agentId);
        if (executionContextId === null) {
          throw new TenantRuntimeToolDeniedError("EXECUTION_CONTEXT_BINDING_MISSING");
        }
        return await this.#execute(definition, {
          toolCallId,
          sessionKey,
          executionContextId,
          resourceId: String(params["resource_id"]),
          params: definition.buildParams(params),
          ...(signal === undefined ? {} : { signal }),
        });
      },
    };
  }

  async #execute(
    definition: ToolDefinition,
    input: {
      readonly toolCallId: string;
      readonly sessionKey: string;
      readonly executionContextId: string;
      readonly resourceId: string;
      readonly params: Readonly<Record<string, unknown>>;
      readonly signal?: AbortSignal;
    },
  ): Promise<Awaited<ReturnType<AnyAgentTool["execute"]>>> {
    if (this.#config === null) {
      throw new TenantRuntimeToolDeniedError("PLUGIN_CONFIG_MISSING");
    }
    const requestId = correlationId("plugin_req", [
      input.toolCallId,
      input.sessionKey,
      definition.name,
      input.resourceId,
    ]);
    const traceId = correlationId("plugin_trace", [input.executionContextId, requestId]);
    const baseUrl =
      definition.gateway === "data" ? this.#config.dataGatewayUrl : this.#config.externalGatewayUrl;
    const timeoutSignal = AbortSignal.timeout(this.#config.requestTimeoutMs);
    const requestSignal =
      input.signal === undefined ? timeoutSignal : AbortSignal.any([input.signal, timeoutSignal]);
    let response: Response;
    try {
      response = await this.#fetch(`${baseUrl}/v1/tools/execute`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request_id: requestId,
          trace_id: traceId,
          execution_context_id: input.executionContextId,
          tool_name: definition.name,
          action: definition.action,
          resource: {
            resource_type: definition.resourceType,
            resource_id: input.resourceId,
          },
          params: input.params,
        }),
        signal: requestSignal,
      });
    } catch {
      throw new TenantRuntimeToolDeniedError("GATEWAY_UNAVAILABLE");
    }
    let rawResult: unknown;
    try {
      rawResult = await response.json();
    } catch {
      throw new TenantRuntimeToolDeniedError("GATEWAY_RESPONSE_INVALID");
    }
    const result = response.ok ? safeGatewayResult(rawResult) : null;
    if (result === null) {
      throw new TenantRuntimeToolDeniedError("GATEWAY_DENIED");
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      details: {
        status: "ok",
        tool_name: definition.name,
        action: definition.action,
        request_id: requestId,
        trace_id: traceId,
      },
    };
  }
}

const runtimeConfigSchema = buildJsonPluginConfigSchema(
  TenantRuntimePluginConfigSchema as unknown as Record<string, unknown>,
);

const tenantRuntimePlugin: OpenClawPluginDefinition = definePluginEntry({
  id: pluginId,
  name: "AgentNest Tenant Runtime",
  description: "Scoped AgentNest Demo tools backed by server-side execution contexts.",
  configSchema: runtimeConfigSchema,
  register(api) {
    const runtime = new TenantRuntimePluginRuntime({ config: parsePluginConfig(api.pluginConfig) });
    api.on("before_agent_run", (event, context) => runtime.beforeAgentRun(event.prompt, context));
    for (const name of businessToolNames) {
      api.registerTool((context) => runtime.createTool(name, context), {
        name,
        optional: true,
      });
    }
  },
});

export default tenantRuntimePlugin;
