import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  AgentStateSchema,
  CapabilityProfileSchema,
  ExecutionContextSchema,
  TaskRequestSchema,
  TraceEventSchema,
  schemaArtifacts,
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
  task_type: "LEGAL_EVIDENCE_CHECK",
  resource: { resource_type: "CASE", resource_id: "case_001" },
  input: { question: "check evidence" },
} as const;
const validProfile = {
  profile_id: "cap_tenant_a_legal_v1",
  version: 1,
  tenant_id: "tenant_A",
  biz_domain: "LEGAL",
  skills: ["legal-evidence-check"],
  tools: {
    legal_case_read: ["read"],
    legal_analysis_write: ["write"],
    legal_research_query: ["query"],
  },
  memory_scopes: ["TENANT_BIZ_MEMORY", "RESOURCE_MEMORY"],
  lifecycle: {
    l1_idle_ttl_seconds: 86_400,
    l2_idle_ttl_seconds: 3_600,
    max_active_l2: 5,
  },
  created_at: "2030-01-01T00:00:00.000Z",
} as const;
const validExecutionContext = {
  execution_context_id: "0f7e6c1a-9e75-45da-bae7-1d6235f8fd94",
  tenant_id: "tenant_A",
  biz_domain: "LEGAL",
  logical_agent_id: `tb_${"a".repeat(20)}`,
  runtime_instance_id: "ari_01",
  session_id: "session_01",
  task_id: "task_01",
  allowed_skills: ["legal-evidence-check"],
  allowed_tools: { legal_case_read: ["read"] },
  resource_scope: { resource_type: "CASE", resource_ids: ["case_001"] },
  expires_at: "2030-01-01T01:00:00.000Z",
} as const;

describe("lean JSON Schema contracts", () => {
  it("accepts a valid task and rejects a cross-domain task shape", () => {
    const validate = compile(TaskRequestSchema);
    expect(validate(validTaskRequest)).toBe(true);
    expect(validate({ ...validTaskRequest, biz_domain: "ROBOT_DOG" })).toBe(false);
    expect(
      validate({
        ...validTaskRequest,
        resource: { ...validTaskRequest.resource, resource_type: "DEVICE" },
      }),
    ).toBe(false);
  });

  it("validates the versioned tenant capability profile", () => {
    const validate = compile(CapabilityProfileSchema);
    expect(validate(validProfile)).toBe(true);
    expect(validate(withoutProperty(validProfile, "tools"))).toBe(false);
    expect(validate({ ...validProfile, token_policy: {} })).toBe(false);
    expect(validate({ ...validProfile, tools: { "INVALID TOOL": ["read"] } })).toBe(false);
  });

  it("validates the server-side execution context without signed-token fields", () => {
    const validate = compile(ExecutionContextSchema);
    expect(validate(validExecutionContext)).toBe(true);
    expect(validate({ ...validExecutionContext, execution_context_id: "not-a-uuid" })).toBe(false);
    expect(validate({ ...validExecutionContext, jti: "not-supported" })).toBe(false);
    expect(
      validate({ ...validExecutionContext, allowed_tools: { legal_case_read: ["READ"] } }),
    ).toBe(false);
  });

  it("requires the lean capability profile reference in AgentState", () => {
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
      capability_profile_id: "cap_tenant_a_legal_v1",
      restored_from_runtime_instance_id: null,
      status: "ACTIVE",
      last_active_at: "2030-01-01T00:00:00.000Z",
      created_at: "2030-01-01T00:00:00.000Z",
      updated_at: "2030-01-01T00:00:00.000Z",
    };
    expect(validate(state)).toBe(true);
    expect(validate(withoutProperty(state, "capability_profile_id"))).toBe(false);
    expect(validate({ ...state, capability_snapshot_id: "obsolete" })).toBe(false);
  });

  it("requires tenant/biz correlation and a simple decision on TraceEvent", () => {
    const validate = compile(TraceEventSchema);
    const event = {
      schema_version: "1.0",
      event_id: "event_01",
      trace_id: "tr_01",
      tenant_id: "tenant_A",
      biz_domain: "LEGAL",
      logical_agent_id: null,
      runtime_instance_id: null,
      agent_id: null,
      session_id: null,
      task_id: null,
      execution_context_id: null,
      event_type: "REQUEST_ACCEPTED",
      decision: null,
      reason: null,
      payload: {},
      created_at: "2030-01-01T00:00:00.000Z",
    };
    expect(validate(event)).toBe(true);
    expect(validate(withoutProperty(event, "tenant_id"))).toBe(false);
    expect(validate({ ...event, event_hash: "not-supported" })).toBe(false);
  });

  it("generates only the five current lean schema artifacts", () => {
    expect(schemaArtifacts.map(({ fileName }) => fileName).sort()).toEqual([
      "agent-state.schema.json",
      "capability-profile.schema.json",
      "execution-context.schema.json",
      "task-request.schema.json",
      "trace-event.schema.json",
    ]);
  });
});
