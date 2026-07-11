import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { AgentLevel, L1RuntimeStatus, L2TaskStatus, TraceEventType } from "./states.js";

export const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
export const BizDomainSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_]*$",
});
export const LogicalAgentIdSchema = Type.String({ pattern: "^tb_[a-f0-9]{20}$" });
export const UtcDateTimeSchema = Type.String({ format: "date-time" });

const NullableIdentifierSchema = Type.Union([IdentifierSchema, Type.Null()]);
const ToolNameSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$",
});
const ActionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]*$",
});
const StringSetSchema = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
  uniqueItems: true,
});
const ToolActionsSchema = Type.Record(
  ToolNameSchema,
  Type.Array(ActionSchema, { minItems: 1, uniqueItems: true }),
  { additionalProperties: false },
);
const TaskInputSchema = Type.Record(
  Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" }),
  Type.Unknown(),
  { additionalProperties: false, maxProperties: 50 },
);

const TaskIdentityProperties = {
  request_id: IdentifierSchema,
  idempotency_key: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  tenant_id: IdentifierSchema,
  user_id: Type.Optional(IdentifierSchema),
  input: TaskInputSchema,
} as const;

const LegalTaskRequestSchema = Type.Object(
  {
    ...TaskIdentityProperties,
    biz_domain: Type.Literal("LEGAL"),
    task_type: Type.Literal("LEGAL_EVIDENCE_CHECK"),
    resource: Type.Object(
      {
        resource_type: Type.Literal("CASE"),
        resource_id: IdentifierSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const RobotDogTaskRequestSchema = Type.Object(
  {
    ...TaskIdentityProperties,
    biz_domain: Type.Literal("ROBOT_DOG"),
    task_type: Type.Literal("ROBOT_DOG_HEALTH_CHECK"),
    resource: Type.Object(
      {
        resource_type: Type.Literal("DEVICE"),
        resource_id: IdentifierSchema,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TaskRequestSchema = Type.Union([LegalTaskRequestSchema, RobotDogTaskRequestSchema], {
  $id: "https://agentnest.example/schemas/task-request.schema.json",
  title: "AgentNest Demo Task Request",
});

export const LifecyclePolicySchema = Type.Object(
  {
    l1_idle_ttl_seconds: Type.Integer({ minimum: 60 }),
    l2_idle_ttl_seconds: Type.Integer({ minimum: 1 }),
    max_active_l2: Type.Integer({ minimum: 1, maximum: 20 }),
  },
  { additionalProperties: false },
);

export const CapabilityProfileSchema = Type.Object(
  {
    profile_id: IdentifierSchema,
    version: Type.Integer({ minimum: 1 }),
    tenant_id: IdentifierSchema,
    biz_domain: BizDomainSchema,
    skills: StringSetSchema,
    tools: ToolActionsSchema,
    memory_scopes: StringSetSchema,
    lifecycle: LifecyclePolicySchema,
    created_at: UtcDateTimeSchema,
  },
  {
    $id: "https://agentnest.example/schemas/capability-profile.schema.json",
    title: "AgentNest Demo Tenant Capability Profile",
    additionalProperties: false,
  },
);

export const ResourceScopeSchema = Type.Object(
  {
    resource_type: Type.String({ minLength: 1, maxLength: 64 }),
    resource_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const ExecutionContextSchema = Type.Object(
  {
    execution_context_id: Type.String({ format: "uuid" }),
    tenant_id: IdentifierSchema,
    biz_domain: BizDomainSchema,
    logical_agent_id: LogicalAgentIdSchema,
    runtime_instance_id: IdentifierSchema,
    session_id: IdentifierSchema,
    task_id: IdentifierSchema,
    allowed_skills: StringSetSchema,
    allowed_tools: ToolActionsSchema,
    resource_scope: ResourceScopeSchema,
    expires_at: UtcDateTimeSchema,
  },
  {
    $id: "https://agentnest.example/schemas/execution-context.schema.json",
    title: "AgentNest Demo Execution Context",
    additionalProperties: false,
  },
);

const L1StatusSchema = Type.Union(
  Object.values(L1RuntimeStatus).map((status) => Type.Literal(status)),
);
const L2StatusSchema = Type.Union(
  Object.values(L2TaskStatus).map((status) => Type.Literal(status)),
);
const AgentStateCommon = {
  schema_version: Type.Literal("1.0"),
  tenant_id: IdentifierSchema,
  biz_domain: BizDomainSchema,
  logical_agent_id: LogicalAgentIdSchema,
  runtime_instance_id: IdentifierSchema,
  agent_id: IdentifierSchema,
  trace_id: IdentifierSchema,
  capability_profile_id: IdentifierSchema,
  restored_from_runtime_instance_id: NullableIdentifierSchema,
  last_active_at: UtcDateTimeSchema,
  created_at: UtcDateTimeSchema,
  updated_at: UtcDateTimeSchema,
} as const;

const L1AgentStateSchema = Type.Object(
  {
    ...AgentStateCommon,
    level: Type.Literal(AgentLevel.L1),
    session_id: NullableIdentifierSchema,
    task_id: NullableIdentifierSchema,
    status: L1StatusSchema,
  },
  { additionalProperties: false },
);
const L2AgentStateSchema = Type.Object(
  {
    ...AgentStateCommon,
    level: Type.Literal(AgentLevel.L2),
    session_id: IdentifierSchema,
    task_id: IdentifierSchema,
    status: L2StatusSchema,
  },
  { additionalProperties: false },
);

export const AgentStateSchema = Type.Union([L1AgentStateSchema, L2AgentStateSchema], {
  $id: "https://agentnest.example/schemas/agent-state.schema.json",
  title: "AgentNest Agent State",
});

const TraceEventTypeSchema = Type.Union(
  Object.values(TraceEventType).map((eventType) => Type.Literal(eventType)),
);
const TraceDecisionSchema = Type.Union([Type.Literal("ALLOW"), Type.Literal("DENY"), Type.Null()]);

export const TraceEventSchema = Type.Object(
  {
    schema_version: Type.Literal("1.0"),
    event_id: IdentifierSchema,
    trace_id: IdentifierSchema,
    tenant_id: IdentifierSchema,
    biz_domain: BizDomainSchema,
    logical_agent_id: NullableIdentifierSchema,
    runtime_instance_id: NullableIdentifierSchema,
    agent_id: NullableIdentifierSchema,
    session_id: NullableIdentifierSchema,
    task_id: NullableIdentifierSchema,
    execution_context_id: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    event_type: TraceEventTypeSchema,
    decision: TraceDecisionSchema,
    reason: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
    payload: Type.Record(
      Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" }),
      Type.Unknown(),
      { additionalProperties: false },
    ),
    created_at: UtcDateTimeSchema,
  },
  {
    $id: "https://agentnest.example/schemas/trace-event.schema.json",
    title: "AgentNest Demo Trace Event",
    additionalProperties: false,
  },
);

export interface SchemaArtifact {
  readonly fileName: string;
  readonly schema: TSchema;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  { fileName: "task-request.schema.json", schema: TaskRequestSchema },
  { fileName: "capability-profile.schema.json", schema: CapabilityProfileSchema },
  { fileName: "execution-context.schema.json", schema: ExecutionContextSchema },
  { fileName: "agent-state.schema.json", schema: AgentStateSchema },
  { fileName: "trace-event.schema.json", schema: TraceEventSchema },
];

export interface TenantBizScope {
  readonly tenantId: string;
  readonly bizDomain: string;
}

export type TaskRequest = Static<typeof TaskRequestSchema>;
export type LifecyclePolicy = Static<typeof LifecyclePolicySchema>;
export type CapabilityProfile = Static<typeof CapabilityProfileSchema>;
export type ExecutionContext = Static<typeof ExecutionContextSchema>;
export type ResourceScope = Static<typeof ResourceScopeSchema>;
export type AgentState = Static<typeof AgentStateSchema>;
export type TraceEvent = Static<typeof TraceEventSchema>;
