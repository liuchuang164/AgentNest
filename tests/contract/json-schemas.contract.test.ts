import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  AgentStateSchema,
  CapabilitySnapshotSchema,
  CapabilityTokenClaimsSchema,
  TaskRequestSchema,
  TraceEventSchema,
} from "../../packages/contracts/src/index.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as FormatsPlugin;
addFormats(ajv);

const compile = (schema: object): ValidateFunction => ajv.compile(schema);
const withoutProperty = (value: object, property: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== property));
const validTaskRequest = {
  request_id: "req_01",
  idempotency_key: "tenant-a-legal-case-001",
  tenant_id: "tenant_A",
  biz_domain: "LEGAL",
  user_id: "user_001",
  role: "lawyer",
  task_type: "LEGAL_EVIDENCE_CHECK",
  resource: { resource_type: "CASE", resource_id: "case_001" },
  input: { question: "check evidence" },
  execution: { async: true, model: null, thinking: null },
} as const;
const hash = `sha256:${"a".repeat(64)}`;
const validSnapshot = {
  snapshot_id: "caps_01",
  schema_version: "1.0",
  policy_version: 1,
  tenant_id: "tenant_A",
  biz_domain: "LEGAL",
  skills: [{ name: "legal-evidence-check", version: "1.0.0", content_hash: hash }],
  tools: [
    {
      name: "legal.case.read",
      actions: ["read"],
      constraints: { resource_types: ["CASE"] },
    },
  ],
  memory_scopes: [{ type: "CASE_MEMORY", resource_type: "CASE", access: ["read"] }],
  data_scopes: [{ resource_type: "CASE", operations: ["read"] }],
  sandbox_policy: { mode: "all", scope: "agent", exec_allowed: false },
  model_policy: {
    providers: ["openai"],
    models: ["configured-model"],
    allow_user_override: false,
  },
  lifecycle_policy: {
    l1_idle_ttl_seconds: 86_400,
    l2_idle_ttl_seconds: 3_600,
    max_active_l2: 5,
  },
  created_at: "2030-01-01T00:00:00.000Z",
  hash,
} as const;
const validTokenClaims = {
  iss: "agentnest-control-plane",
  aud: ["data-gateway"],
  jti: "captok_01",
  parent_jti: "parent_01",
  snapshot_id: "caps_01",
  tenant_id: "tenant_A",
  biz_domain: "LEGAL",
  logical_agent_id: `tb_${"a".repeat(20)}`,
  runtime_instance_id: "ari_01",
  agent_id: `tb_${"a".repeat(20)}`,
  session_id: "session_01",
  task_id: "task_01",
  tools: { "legal.case.read": ["read"] },
  memory_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
  data_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
  iat: 1_893_456_000,
  nbf: 1_893_456_000,
  exp: 1_893_459_600,
  nonce: "0123456789abcdef",
} as const;

describe("generated JSON Schema contracts", () => {
  it("accepts a valid tenant-scoped task and rejects cross-domain mismatch", () => {
    const validate = compile(TaskRequestSchema);
    expect(validate(validTaskRequest)).toBe(true);
    expect(validate({ ...validTaskRequest, biz_domain: "ROBOT_DOG" })).toBe(false);
    expect(validate({ ...validTaskRequest, input: { "": "invalid-key" } })).toBe(false);
  });

  it("requires the model policy in immutable capability snapshots", () => {
    const validate = compile(CapabilitySnapshotSchema);
    expect(validate(validSnapshot)).toBe(true);
    const withoutModelPolicy = withoutProperty(validSnapshot, "model_policy");
    expect(validate(withoutModelPolicy)).toBe(false);
  });

  it("requires every L2 token to bind a parent token", () => {
    const validate = compile(CapabilityTokenClaimsSchema);
    expect(validate(validTokenClaims)).toBe(true);
    const withoutParent = withoutProperty(validTokenClaims, "parent_jti");
    expect(validate(withoutParent)).toBe(false);
  });

  it("fails closed for unknown tools and invalid actions", () => {
    const validate = compile(CapabilityTokenClaimsSchema);
    expect(validate({ ...validTokenClaims, tools: { INVALID: ["read"] } })).toBe(false);
    expect(validate({ ...validTokenClaims, tools: { "legal.case.read": [] } })).toBe(false);
    expect(validate({ ...validTokenClaims, tools: { "legal.case.read": ["READ"] } })).toBe(false);
  });

  it("requires all AgentState correlation fields even when nullable", () => {
    const validate = compile(AgentStateSchema);
    const state = {
      schema_version: "1.0",
      level: "L1",
      tenant_id: "tenant_A",
      biz_domain: "LEGAL",
      logical_agent_id: `tb_${"a".repeat(20)}`,
      runtime_instance_id: "ari_01",
      agent_id: `tb_${"a".repeat(20)}`,
      session_id: null,
      task_id: null,
      trace_id: "tr_01",
      capability_snapshot_id: "caps_01",
      restored_from_runtime_instance_id: null,
      status: "ACTIVE",
      last_active_at: "2030-01-01T00:00:00.000Z",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
    };
    expect(validate(state)).toBe(true);
    const withoutTrace = withoutProperty(state, "trace_id");
    expect(validate(withoutTrace)).toBe(false);
    expect(validate(withoutProperty(state, "restored_from_runtime_instance_id"))).toBe(false);
  });

  it("requires every TraceEvent correlation field and UTC timestamps", () => {
    const validate = compile(TraceEventSchema);
    const event = {
      schema_version: "1.0",
      event_id: "event_01",
      trace_id: "tr_01",
      tenant_id: null,
      biz_domain: null,
      logical_agent_id: null,
      runtime_instance_id: null,
      agent_id: null,
      session_id: null,
      task_id: null,
      capability_snapshot_id: null,
      event_type: "REQUEST_ACCEPTED",
      payload: {},
      previous_hash: null,
      event_hash: null,
      timestamp: "2030-01-01T00:00:00.000Z",
      created_at: "2030-01-01T00:00:00.000Z",
    };
    expect(validate(event)).toBe(true);
    const withoutSession = withoutProperty(event, "session_id");
    expect(validate(withoutSession)).toBe(false);
    expect(validate({ ...event, created_at: "2030-01-01T08:00:00+08:00" })).toBe(false);
    expect(validate({ ...event, payload: { "": "invalid-key" } })).toBe(false);
  });
});
