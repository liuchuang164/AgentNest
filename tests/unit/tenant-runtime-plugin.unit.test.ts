import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TenantRuntimePluginRuntime,
  businessToolDefinitions,
  businessToolNames,
  formatControllerEnvelope,
  parsePluginConfig,
  type BusinessToolName,
  type GatewayFetch,
} from "../../packages/tenant-runtime-plugin/src/index.js";

const LEGAL_AGENT_ID = "l2_aaaaaaaaaaaaaaaaaaaa";
const ROBOT_AGENT_ID = "l2_bbbbbbbbbbbbbbbbbbbb";
const LEGAL_SESSION_KEY = `agent:${LEGAL_AGENT_ID}:subagent:legal-test`;
const ROBOT_SESSION_KEY = `agent:${ROBOT_AGENT_ID}:subagent:robot-test`;
const EXECUTION_CONTEXT_ID = "0f7e6c1a-9e75-45da-bae7-1d6235f8fd94";

interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>>;
}

class FetchHarness {
  public readonly requests: CapturedRequest[] = [];
  public responseStatus = 200;
  public responseBody: unknown = {
    success: true,
    code: "OK",
    message: "tool executed",
    request_id: "gateway_request",
    trace_id: "gateway_trace",
    data: { fixture: true },
    error: null,
  };

  public readonly fetch: GatewayFetch = (url, init) => {
    if (typeof init.body !== "string") {
      return Promise.reject(new TypeError("expected a JSON request body"));
    }
    const parsed: unknown = JSON.parse(init.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Promise.reject(new TypeError("expected a JSON object request body"));
    }
    this.requests.push({
      url,
      headers: new Headers(init.headers),
      body: structuredClone(parsed) as Readonly<Record<string, unknown>>,
    });
    return Promise.resolve(
      new Response(JSON.stringify(this.responseBody), {
        status: this.responseStatus,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function config() {
  const parsed = parsePluginConfig({
    dataGatewayUrl: "http://data-gateway-mock:18081",
    externalGatewayUrl: "http://external-gateway-mock:18082",
    requestTimeoutMs: 1_000,
    agentScopes: {
      [LEGAL_AGENT_ID]: { bizDomain: "LEGAL" },
      [ROBOT_AGENT_ID]: { bizDomain: "ROBOT_DOG" },
    },
  });
  if (parsed === null) {
    throw new TypeError("test plugin config must be valid");
  }
  return parsed;
}

function requireTool(
  runtime: TenantRuntimePluginRuntime,
  name: BusinessToolName,
  agentId: string,
  sessionKey: string,
) {
  const tool = runtime.createTool(name, { agentId, sessionKey });
  if (tool === null) {
    throw new TypeError(`expected ${name} to be visible`);
  }
  return tool;
}

function bind(
  runtime: TenantRuntimePluginRuntime,
  agentId = LEGAL_AGENT_ID,
  sessionKey = LEGAL_SESSION_KEY,
): void {
  expect(
    runtime.beforeAgentRun(
      formatControllerEnvelope(EXECUTION_CONTEXT_ID, "perform the scoped Demo task"),
      { agentId, sessionKey },
    ),
  ).toEqual({ outcome: "pass" });
}

describe("AgentNest OpenClaw tenant runtime plugin", () => {
  it("keeps execution context and trusted scope out of all model-facing schemas", async () => {
    const harness = new FetchHarness();
    const runtime = new TenantRuntimePluginRuntime({ config: config(), fetch: harness.fetch });
    bind(runtime);

    for (const definition of Object.values(businessToolDefinitions)) {
      const schema = JSON.stringify(definition.parameters);
      expect(schema).not.toContain("execution_context_id");
      expect(schema).not.toContain("tenant_id");
      expect(schema).not.toContain("biz_domain");
      expect(schema).not.toContain("tool_name");
      expect(schema).not.toContain("resource_type");
      expect(schema).not.toContain('"action"');
    }

    const tool = requireTool(runtime, "legal_case_read", LEGAL_AGENT_ID, LEGAL_SESSION_KEY);
    await expect(
      tool.execute("override-attempt", {
        resource_id: "case_001",
        execution_context_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tenant_id: "tenant_B",
        biz_domain: "ROBOT_DOG",
      }),
    ).rejects.toMatchObject({
      name: "TenantRuntimeToolDeniedError",
      code: "TOOL_INPUT_INVALID",
    });
    expect(harness.requests).toHaveLength(0);

    await tool.execute("valid-call", { resource_id: "case_001" });
    const request = harness.requests[0];
    expect(request?.body).toMatchObject({
      execution_context_id: EXECUTION_CONTEXT_ID,
      tool_name: "legal_case_read",
      action: "read",
      resource: { resource_type: "CASE", resource_id: "case_001" },
      params: {},
    });
    expect(request?.body).not.toHaveProperty("tenant_id");
    expect(request?.body).not.toHaveProperty("biz_domain");
    expect([...(request?.headers.keys() ?? [])]).toEqual(["content-type"]);
  });

  it("binds only a canonical controller envelope and clears stale bindings", async () => {
    const harness = new FetchHarness();
    const runtime = new TenantRuntimePluginRuntime({ config: config(), fetch: harness.fetch });
    bind(runtime);
    const tool = requireTool(runtime, "legal_case_read", LEGAL_AGENT_ID, LEGAL_SESSION_KEY);
    const canonicalEnvelopeLine =
      formatControllerEnvelope(EXECUTION_CONTEXT_ID, "task").split("\n")[0] ?? "";

    expect(
      runtime.beforeAgentRun(`${canonicalEnvelopeLine} \nmalformed`, {
        agentId: LEGAL_AGENT_ID,
        sessionKey: LEGAL_SESSION_KEY,
      }),
    ).toMatchObject({ outcome: "block", category: "agentnest_context_missing" });
    await expect(
      tool.execute("after-malformed-envelope", { resource_id: "case_001" }),
    ).rejects.toMatchObject({
      name: "TenantRuntimeToolDeniedError",
      code: "EXECUTION_CONTEXT_BINDING_MISSING",
    });
    expect(harness.requests).toHaveLength(0);
  });

  it("fails closed when the trusted session binding, config, or Gateway allow is missing", async () => {
    const harness = new FetchHarness();
    const runtime = new TenantRuntimePluginRuntime({ config: config(), fetch: harness.fetch });
    const tool = requireTool(runtime, "legal_case_read", LEGAL_AGENT_ID, LEGAL_SESSION_KEY);
    await expect(
      tool.execute("missing-binding", { resource_id: "case_001" }),
    ).rejects.toMatchObject({
      name: "TenantRuntimeToolDeniedError",
      code: "EXECUTION_CONTEXT_BINDING_MISSING",
    });

    expect(
      new TenantRuntimePluginRuntime({ config: null, fetch: harness.fetch }).createTool(
        "legal_case_read",
        { agentId: LEGAL_AGENT_ID, sessionKey: LEGAL_SESSION_KEY },
      ),
    ).toBeNull();

    bind(runtime);
    harness.responseStatus = 403;
    harness.responseBody = {
      success: false,
      code: "TOOL_NOT_ALLOWED",
      message: "denied",
      data: null,
      error: { reason: "TOOL_ACTION_DENIED" },
    };
    await expect(tool.execute("gateway-deny", { resource_id: "case_001" })).rejects.toMatchObject({
      name: "TenantRuntimeToolDeniedError",
      code: "GATEWAY_DENIED",
    });
  });

  it.each([
    {
      name: "legal_case_read",
      agentId: LEGAL_AGENT_ID,
      sessionKey: LEGAL_SESSION_KEY,
      gateway: "http://data-gateway-mock:18081/v1/tools/execute",
      action: "read",
      resourceType: "CASE",
      input: { resource_id: "case_001" },
      params: {},
    },
    {
      name: "legal_analysis_write",
      agentId: LEGAL_AGENT_ID,
      sessionKey: LEGAL_SESSION_KEY,
      gateway: "http://data-gateway-mock:18081/v1/tools/execute",
      action: "write",
      resourceType: "CASE",
      input: { resource_id: "case_001", analysis: "evidence chain complete" },
      params: { analysis: "evidence chain complete" },
    },
    {
      name: "legal_research_query",
      agentId: LEGAL_AGENT_ID,
      sessionKey: LEGAL_SESSION_KEY,
      gateway: "http://external-gateway-mock:18082/v1/tools/execute",
      action: "query",
      resourceType: "CASE",
      input: { resource_id: "case_001", query: "contract evidence rule" },
      params: { query: "contract evidence rule" },
    },
    {
      name: "robot_device_read",
      agentId: ROBOT_AGENT_ID,
      sessionKey: ROBOT_SESSION_KEY,
      gateway: "http://data-gateway-mock:18081/v1/tools/execute",
      action: "read",
      resourceType: "DEVICE",
      input: { resource_id: "device_001" },
      params: {},
    },
    {
      name: "robot_health_write",
      agentId: ROBOT_AGENT_ID,
      sessionKey: ROBOT_SESSION_KEY,
      gateway: "http://data-gateway-mock:18081/v1/tools/execute",
      action: "write",
      resourceType: "DEVICE",
      input: { resource_id: "device_001", health_status: "HEALTHY", note: "nominal" },
      params: { health_status: "HEALTHY", note: "nominal" },
    },
    {
      name: "robot_telemetry_enrich",
      agentId: ROBOT_AGENT_ID,
      sessionKey: ROBOT_SESSION_KEY,
      gateway: "http://external-gateway-mock:18082/v1/tools/execute",
      action: "query",
      resourceType: "DEVICE",
      input: { resource_id: "device_001", telemetry: [1, 2, 3] },
      params: { telemetry: [1, 2, 3] },
    },
  ] as const)("fixes routing and action for $name", async (testCase) => {
    const harness = new FetchHarness();
    const runtime = new TenantRuntimePluginRuntime({ config: config(), fetch: harness.fetch });
    bind(runtime, testCase.agentId, testCase.sessionKey);
    const tool = requireTool(runtime, testCase.name, testCase.agentId, testCase.sessionKey);

    await tool.execute(`call-${testCase.name}`, testCase.input);

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.url).toBe(testCase.gateway);
    expect(harness.requests[0]?.body).toMatchObject({
      tool_name: testCase.name,
      action: testCase.action,
      resource: {
        resource_type: testCase.resourceType,
        resource_id: testCase.input.resource_id,
      },
      params: testCase.params,
    });
  });

  it("keeps business-domain tools invisible outside the trusted configured scope", () => {
    const runtime = new TenantRuntimePluginRuntime({ config: config() });
    expect(
      runtime.createTool("robot_device_read", {
        agentId: LEGAL_AGENT_ID,
        sessionKey: LEGAL_SESSION_KEY,
      }),
    ).toBeNull();
    expect(
      runtime.createTool("legal_case_read", {
        agentId: ROBOT_AGENT_ID,
        sessionKey: ROBOT_SESSION_KEY,
      }),
    ).toBeNull();
  });

  it("keeps manifest tool ownership, optional metadata, config, and activation consistent", async () => {
    const raw: unknown = JSON.parse(
      await readFile(resolve("packages/tenant-runtime-plugin/openclaw.plugin.json"), "utf8"),
    );
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("plugin manifest must be an object");
    }
    const manifest = raw as Readonly<Record<string, unknown>>;
    const contracts = manifest["contracts"] as Readonly<Record<string, unknown>>;
    const metadata = manifest["toolMetadata"] as Readonly<Record<string, unknown>>;
    const activation = manifest["activation"] as Readonly<Record<string, unknown>>;
    const configSchema = manifest["configSchema"] as Readonly<Record<string, unknown>>;

    expect(contracts["tools"]).toEqual(businessToolNames);
    expect(Object.keys(metadata).sort()).toEqual([...businessToolNames].sort());
    for (const name of businessToolNames) {
      expect(metadata[name]).toEqual({ optional: true });
    }
    expect(activation["onStartup"]).toBe(true);
    expect(configSchema["additionalProperties"]).toBe(false);
    expect(configSchema["required"]).toEqual([
      "dataGatewayUrl",
      "externalGatewayUrl",
      "agentScopes",
    ]);
  });
});
