import { Type, type Static, type TSchema } from "@sinclair/typebox";

import { AgentLevel, L1RuntimeStatus, L2TaskStatus, TraceEventType } from "./states.js";

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
const NullableIdentifierSchema = Type.Union([IdentifierSchema, Type.Null()]);
const BizDomainSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_]*$",
});
const UtcDateTimeSchema = Type.String({
  format: "date-time",
  pattern: "Z$",
});
const Sha256Schema = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const NullableSha256Schema = Type.Union([Sha256Schema, Type.Null()]);
const ToolNameSchema = Type.String({
  minLength: 3,
  maxLength: 128,
  pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$",
});
const ObjectKeySchema = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$",
});
const ActionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z][a-z0-9._-]*$",
});

const TaskInputSchema = Type.Record(ObjectKeySchema, Type.Unknown(), {
  maxProperties: 50,
  additionalProperties: false,
});

const TaskExecutionSchema = Type.Object(
  {
    async: Type.Boolean(),
    model: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    thinking: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
  },
  { additionalProperties: false },
);

const TaskIdentityProperties = {
  request_id: IdentifierSchema,
  idempotency_key: Type.String({ minLength: 8, maxLength: 256 }),
  tenant_id: IdentifierSchema,
  user_id: IdentifierSchema,
  role: Type.String({ minLength: 1, maxLength: 64 }),
  input: TaskInputSchema,
  execution: TaskExecutionSchema,
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
  title: "AgentNest Task Request",
});

const SkillGrantSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    content_hash: Sha256Schema,
  },
  { additionalProperties: false },
);

const ToolGrantSchema = Type.Object(
  {
    name: ToolNameSchema,
    actions: Type.Array(ActionSchema, { minItems: 1, uniqueItems: true }),
    constraints: Type.Object(
      {
        resource_types: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const MemoryScopeSchema = Type.Object(
  {
    type: Type.String({ minLength: 1, maxLength: 64 }),
    resource_type: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    access: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write")]), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const DataScopeSchema = Type.Object(
  {
    resource_type: Type.String({ minLength: 1, maxLength: 64 }),
    operations: Type.Array(ActionSchema, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const CapabilitySnapshotSchema = Type.Object(
  {
    snapshot_id: IdentifierSchema,
    schema_version: Type.Literal("1.0"),
    policy_version: Type.Integer({ minimum: 1 }),
    tenant_id: IdentifierSchema,
    biz_domain: BizDomainSchema,
    skills: Type.Array(SkillGrantSchema, { uniqueItems: true }),
    tools: Type.Array(ToolGrantSchema, { uniqueItems: true }),
    memory_scopes: Type.Array(MemoryScopeSchema, { uniqueItems: true }),
    data_scopes: Type.Array(DataScopeSchema, { uniqueItems: true }),
    sandbox_policy: Type.Object(
      {
        mode: Type.Literal("all"),
        scope: Type.Literal("agent"),
        exec_allowed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    model_policy: Type.Object(
      {
        providers: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
          minItems: 1,
          uniqueItems: true,
        }),
        models: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1,
          uniqueItems: true,
        }),
        allow_user_override: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    lifecycle_policy: Type.Object(
      {
        l1_idle_ttl_seconds: Type.Integer({ minimum: 60 }),
        l2_idle_ttl_seconds: Type.Integer({ minimum: 1 }),
        max_active_l2: Type.Integer({ minimum: 1, maximum: 20 }),
      },
      { additionalProperties: false },
    ),
    created_at: UtcDateTimeSchema,
    hash: Sha256Schema,
  },
  {
    $id: "https://agentnest.example/schemas/capability-snapshot.schema.json",
    title: "AgentNest Capability Snapshot",
    additionalProperties: false,
  },
);

const ResourceScopeSchema = Type.Object(
  {
    resource_type: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
    resource_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const CapabilityTokenClaimsSchema = Type.Object(
  {
    iss: Type.Literal("agentnest-control-plane"),
    aud: Type.Array(Type.Union([Type.Literal("data-gateway"), Type.Literal("external-gateway")]), {
      minItems: 1,
      uniqueItems: true,
    }),
    jti: IdentifierSchema,
    parent_jti: IdentifierSchema,
    snapshot_id: IdentifierSchema,
    tenant_id: IdentifierSchema,
    biz_domain: BizDomainSchema,
    logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
    runtime_instance_id: IdentifierSchema,
    agent_id: IdentifierSchema,
    session_id: IdentifierSchema,
    task_id: IdentifierSchema,
    tools: Type.Record(
      ToolNameSchema,
      Type.Array(ActionSchema, { minItems: 1, uniqueItems: true }),
      { minProperties: 1, additionalProperties: false },
    ),
    memory_scope: ResourceScopeSchema,
    data_scope: ResourceScopeSchema,
    iat: Type.Integer({ minimum: 0 }),
    nbf: Type.Integer({ minimum: 0 }),
    exp: Type.Integer({ minimum: 1 }),
    nonce: Type.String({ minLength: 16, maxLength: 256 }),
  },
  {
    $id: "https://agentnest.example/schemas/capability-token-claims.schema.json",
    title: "AgentNest L2 Capability Token Claims",
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
  logical_agent_id: Type.String({ pattern: "^tb_[a-f0-9]{20}$" }),
  runtime_instance_id: IdentifierSchema,
  agent_id: IdentifierSchema,
  trace_id: IdentifierSchema,
  capability_snapshot_id: IdentifierSchema,
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

export const TraceEventSchema = Type.Object(
  {
    schema_version: Type.Literal("1.0"),
    event_id: IdentifierSchema,
    trace_id: IdentifierSchema,
    tenant_id: NullableIdentifierSchema,
    biz_domain: Type.Union([BizDomainSchema, Type.Null()]),
    logical_agent_id: NullableIdentifierSchema,
    runtime_instance_id: NullableIdentifierSchema,
    agent_id: NullableIdentifierSchema,
    session_id: NullableIdentifierSchema,
    task_id: NullableIdentifierSchema,
    capability_snapshot_id: NullableIdentifierSchema,
    event_type: TraceEventTypeSchema,
    payload: Type.Record(ObjectKeySchema, Type.Unknown(), { additionalProperties: false }),
    previous_hash: NullableSha256Schema,
    event_hash: NullableSha256Schema,
    timestamp: UtcDateTimeSchema,
    created_at: UtcDateTimeSchema,
  },
  {
    $id: "https://agentnest.example/schemas/trace-event.schema.json",
    title: "AgentNest Trace Event",
    additionalProperties: false,
  },
);

export interface SchemaArtifact {
  readonly fileName: string;
  readonly schema: TSchema;
}

export const schemaArtifacts: readonly SchemaArtifact[] = [
  { fileName: "task-request.schema.json", schema: TaskRequestSchema },
  { fileName: "capability-snapshot.schema.json", schema: CapabilitySnapshotSchema },
  { fileName: "capability-token-claims.schema.json", schema: CapabilityTokenClaimsSchema },
  { fileName: "agent-state.schema.json", schema: AgentStateSchema },
  { fileName: "trace-event.schema.json", schema: TraceEventSchema },
];

export type TaskRequest = Static<typeof TaskRequestSchema>;
export type CapabilitySnapshot = Static<typeof CapabilitySnapshotSchema>;
export type CapabilityTokenClaims = Static<typeof CapabilityTokenClaimsSchema>;
export type AgentState = Static<typeof AgentStateSchema>;
export type TraceEvent = Static<typeof TraceEventSchema>;
