import { randomUUID } from "node:crypto";

import { normalizeTenantBizScope } from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";

import type { JsonObject } from "./phase5-persistence-repository.js";
import type { PostgresClient, PostgresPool, SqlQueryResult } from "./postgres.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type DemoGatewayName = "DATA" | "EXTERNAL";
export type DemoResourceType = "CASE" | "DEVICE";

export interface DemoGatewayOperationInput {
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
  readonly params: JsonObject;
  readonly now: Date;
}

export interface DemoGatewayOperationRecord extends DemoGatewayOperationInput {
  readonly operationId: string;
  readonly gatewayName: DemoGatewayName;
  readonly result: JsonObject;
}

export interface GatewayTracePersistenceRecord {
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
  readonly decision: "ALLOW" | "DENY";
  readonly reason: string;
  readonly createdAt: string;
}

export interface PersistedGatewayTraceRecord extends GatewayTracePersistenceRecord {
  readonly gatewayTraceEventId: string;
  readonly gatewayName: DemoGatewayName;
}

export interface PostgresDemoGatewayRepositoryOptions {
  readonly createId?: () => string;
}

export interface PostgresGatewayTraceRepositoryOptions {
  readonly gatewayName: DemoGatewayName;
  readonly createId?: () => string;
}

interface DemoResourceRow extends Record<string, unknown> {
  readonly payload_json: unknown;
}

interface GatewayOperationRow extends Record<string, unknown> {
  readonly operation_id: unknown;
  readonly gateway_name: unknown;
  readonly request_id: unknown;
  readonly trace_id: unknown;
  readonly execution_context_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly tool_name: unknown;
  readonly action: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly params_json: unknown;
  readonly result_json: unknown;
  readonly created_at: unknown;
}

interface GatewayTraceRow extends Record<string, unknown> {
  readonly gateway_trace_event_id: unknown;
  readonly gateway_name: unknown;
  readonly request_id: unknown;
  readonly trace_id: unknown;
  readonly execution_context_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly tool_name: unknown;
  readonly action: unknown;
  readonly resource_type: unknown;
  readonly resource_id: unknown;
  readonly decision: unknown;
  readonly reason: unknown;
  readonly created_at: unknown;
}

function assertIdentifier(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return normalized;
}

function assertUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return normalized;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  return structuredClone(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readNullableString(value: unknown, field: string): string | null {
  return value === null ? null : readString(value, field);
}

function readDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`PostgreSQL returned invalid ${field}`);
  }
  return parsed;
}

function firstRow<TRow extends Record<string, unknown>>(
  result: SqlQueryResult<TRow>,
  description: string,
): TRow {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`PostgreSQL did not return ${description}`);
  }
  return row;
}

async function rollbackPreservingOriginal(client: PostgresClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}

function normalizeOperationInput(input: DemoGatewayOperationInput): DemoGatewayOperationInput {
  const scope = normalizeTenantBizScope({ tenantId: input.tenantId, bizDomain: input.bizDomain });
  return {
    requestId: assertIdentifier(input.requestId, "requestId"),
    traceId: assertIdentifier(input.traceId, "traceId"),
    executionContextId: assertUuid(input.executionContextId, "executionContextId"),
    tenantId: scope.tenantId,
    bizDomain: scope.bizDomain,
    logicalAgentId: assertIdentifier(input.logicalAgentId, "logicalAgentId"),
    runtimeInstanceId: assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId"),
    sessionId: assertIdentifier(input.sessionId, "sessionId"),
    taskId: assertIdentifier(input.taskId, "taskId"),
    toolName: assertIdentifier(input.toolName, "toolName"),
    action: assertIdentifier(input.action, "action"),
    resourceType: assertIdentifier(input.resourceType, "resourceType"),
    resourceId: assertIdentifier(input.resourceId, "resourceId"),
    params: structuredClone(input.params),
    now: assertDate(input.now, "now"),
  };
}

function makeDataResult(
  operationId: string,
  input: DemoGatewayOperationInput,
  resource: JsonObject,
): JsonObject {
  if (input.toolName === "legal_case_read" && input.action === "read") {
    return {
      resource_id: input.resourceId,
      title: typeof resource["title"] === "string" ? resource["title"] : "",
      facts: Array.isArray(resource["facts"]) ? structuredClone(resource["facts"]) : [],
    };
  }
  if (input.toolName === "legal_analysis_write" && input.action === "write") {
    return {
      result_id: `legal_analysis_${operationId.replaceAll("-", "").slice(0, 12)}`,
      stored: true,
    };
  }
  if (input.toolName === "robot_device_read" && input.action === "read") {
    return {
      resource_id: input.resourceId,
      model: typeof resource["model"] === "string" ? resource["model"] : "",
      firmware: typeof resource["firmware"] === "string" ? resource["firmware"] : "",
    };
  }
  if (input.toolName === "robot_health_write" && input.action === "write") {
    return {
      result_id: `robot_health_${operationId.replaceAll("-", "").slice(0, 12)}`,
      stored: true,
    };
  }
  throw new TypeError("unsupported Data Gateway operation");
}

function makeExternalResult(input: DemoGatewayOperationInput): JsonObject {
  if (input.toolName === "legal_research_query" && input.action === "query") {
    const query = input.params["query"];
    if (typeof query !== "string") {
      throw new TypeError("legal research query must be a string");
    }
    const tenantMarker = input.tenantId === "tenant_A" ? "ALPHA" : "BETA";
    return {
      query,
      citations: [`${tenantMarker}-STATUTE-101`, `${tenantMarker}-PRECEDENT-7`],
    };
  }
  if (input.toolName === "robot_telemetry_enrich" && input.action === "query") {
    const telemetry = input.params["telemetry"];
    if (!Array.isArray(telemetry) || !telemetry.every((sample) => typeof sample === "number")) {
      throw new TypeError("robot telemetry must be a numeric array");
    }
    const sum = telemetry.reduce<number>((total, sample) => total + sample, 0);
    const average = sum / telemetry.length;
    return {
      sample_count: telemetry.length,
      average,
      health_band: average >= 0 ? "NOMINAL" : "CHECK_REQUIRED",
    };
  }
  throw new TypeError("unsupported External Gateway operation");
}

function toOperationRecord(row: GatewayOperationRow): DemoGatewayOperationRecord {
  const gatewayName = readString(row.gateway_name, "gateway_name");
  if (gatewayName !== "DATA" && gatewayName !== "EXTERNAL") {
    throw new TypeError("PostgreSQL returned invalid gateway_name");
  }
  return {
    operationId: assertUuid(readString(row.operation_id, "operation_id"), "operation_id"),
    gatewayName,
    requestId: readString(row.request_id, "request_id"),
    traceId: readString(row.trace_id, "trace_id"),
    executionContextId: assertUuid(
      readString(row.execution_context_id, "execution_context_id"),
      "execution_context_id",
    ),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    toolName: readString(row.tool_name, "tool_name"),
    action: readString(row.action, "action"),
    resourceType: readString(row.resource_type, "resource_type"),
    resourceId: readString(row.resource_id, "resource_id"),
    params: readJsonObject(row.params_json, "params_json"),
    result: readJsonObject(row.result_json, "result_json"),
    now: readDate(row.created_at, "created_at"),
  };
}

export class PostgresDemoGatewayRepository {
  readonly #createId: () => string;

  public constructor(
    private readonly pool: PostgresPool,
    options: PostgresDemoGatewayRepositoryOptions = {},
  ) {
    this.#createId = options.createId ?? randomUUID;
  }

  public async ownsResource(
    tenantId: string,
    bizDomain: string,
    resourceType: string,
    resourceId: string,
  ): Promise<boolean> {
    const scope = normalizeTenantBizScope({ tenantId, bizDomain });
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ readonly owned: unknown }>(
        `SELECT EXISTS (
           SELECT 1
             FROM demo_resource
            WHERE tenant_id = $1
              AND biz_domain = $2
              AND resource_type = $3
              AND resource_id = $4
         ) AS owned`,
        [
          scope.tenantId,
          scope.bizDomain,
          assertIdentifier(resourceType, "resourceType"),
          assertIdentifier(resourceId, "resourceId"),
        ],
      );
      return firstRow(result, "the resource ownership result").owned === true;
    } finally {
      client.release();
    }
  }

  public executeDataOperation(input: DemoGatewayOperationInput): Promise<JsonObject> {
    return this.#execute("DATA", input);
  }

  public executeExternalOperation(input: DemoGatewayOperationInput): Promise<JsonObject> {
    return this.#execute("EXTERNAL", input);
  }

  async #execute(
    gatewayName: DemoGatewayName,
    rawInput: DemoGatewayOperationInput,
  ): Promise<JsonObject> {
    const input = normalizeOperationInput(rawInput);
    const operationId = assertUuid(this.#createId(), "operationId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const resourceResult = await client.query<DemoResourceRow>(
        `SELECT payload_json
           FROM demo_resource
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND resource_type = $3
            AND resource_id = $4
          FOR SHARE`,
        [input.tenantId, input.bizDomain, input.resourceType, input.resourceId],
      );
      const resourceRow = resourceResult.rows[0];
      if (resourceRow === undefined) {
        throw new Error("demo resource is outside the requested tenant/business scope");
      }
      const resource = readJsonObject(resourceRow.payload_json, "payload_json");
      const result =
        gatewayName === "DATA"
          ? makeDataResult(operationId, input, resource)
          : makeExternalResult(input);
      await client.query(
        `INSERT INTO demo_gateway_operation (
           tenant_id, biz_domain, operation_id, gateway_name, request_id, trace_id,
           execution_context_id, logical_agent_id, runtime_instance_id, session_id,
           task_id, tool_name, action, resource_type, resource_id, params_json,
           result_json, created_at
         ) VALUES (
           $1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10,
           $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::timestamptz
         )`,
        [
          input.tenantId,
          input.bizDomain,
          operationId,
          gatewayName,
          input.requestId,
          input.traceId,
          input.executionContextId,
          input.logicalAgentId,
          input.runtimeInstanceId,
          input.sessionId,
          input.taskId,
          input.toolName,
          input.action,
          input.resourceType,
          input.resourceId,
          JSON.stringify(input.params),
          JSON.stringify(result),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await rollbackPreservingOriginal(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listOperations(input: {
    readonly scope: TenantBizScope;
    readonly taskId: string;
  }): Promise<readonly DemoGatewayOperationRecord[]> {
    const scope = normalizeTenantBizScope(input.scope);
    const client = await this.pool.connect();
    try {
      const result = await client.query<GatewayOperationRow>(
        `SELECT operation_id, gateway_name, request_id, trace_id, execution_context_id,
                tenant_id, biz_domain, logical_agent_id, runtime_instance_id, session_id,
                task_id, tool_name, action, resource_type, resource_id, params_json,
                result_json, created_at
           FROM demo_gateway_operation
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND task_id = $3
          ORDER BY created_at, operation_id`,
        [scope.tenantId, scope.bizDomain, assertIdentifier(input.taskId, "taskId")],
      );
      return result.rows.map(toOperationRecord);
    } finally {
      client.release();
    }
  }
}

function toTraceRecord(row: GatewayTraceRow): PersistedGatewayTraceRecord {
  const gatewayName = readString(row.gateway_name, "gateway_name");
  const decision = readString(row.decision, "decision");
  if (gatewayName !== "DATA" && gatewayName !== "EXTERNAL") {
    throw new TypeError("PostgreSQL returned invalid gateway_name");
  }
  if (decision !== "ALLOW" && decision !== "DENY") {
    throw new TypeError("PostgreSQL returned invalid decision");
  }
  return {
    gatewayTraceEventId: assertUuid(
      readString(row.gateway_trace_event_id, "gateway_trace_event_id"),
      "gateway_trace_event_id",
    ),
    gatewayName,
    requestId: readString(row.request_id, "request_id"),
    traceId: readString(row.trace_id, "trace_id"),
    executionContextId: readNullableString(row.execution_context_id, "execution_context_id"),
    tenantId: readNullableString(row.tenant_id, "tenant_id"),
    bizDomain: readNullableString(row.biz_domain, "biz_domain"),
    logicalAgentId: readNullableString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readNullableString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readNullableString(row.session_id, "session_id"),
    taskId: readNullableString(row.task_id, "task_id"),
    toolName: readNullableString(row.tool_name, "tool_name"),
    action: readNullableString(row.action, "action"),
    resourceType: readNullableString(row.resource_type, "resource_type"),
    resourceId: readNullableString(row.resource_id, "resource_id"),
    decision,
    reason: readString(row.reason, "reason"),
    createdAt: readDate(row.created_at, "created_at").toISOString(),
  };
}

export class PostgresGatewayTraceRepository {
  readonly #createId: () => string;

  public constructor(
    private readonly pool: PostgresPool,
    private readonly options: PostgresGatewayTraceRepositoryOptions,
  ) {
    this.#createId = options.createId ?? randomUUID;
  }

  public async append(record: GatewayTracePersistenceRecord): Promise<void> {
    const eventId = assertUuid(this.#createId(), "gatewayTraceEventId");
    const createdAt = new Date(record.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new TypeError("createdAt must be a valid ISO timestamp");
    }
    const scopedValues = [
      record.tenantId,
      record.bizDomain,
      record.logicalAgentId,
      record.runtimeInstanceId,
      record.sessionId,
      record.taskId,
    ];
    const hasNull = scopedValues.some((value) => value === null);
    const hasValue = scopedValues.some((value) => value !== null);
    if (hasNull && hasValue) {
      throw new TypeError("Gateway trace scope identity must be entirely present or absent");
    }
    if (!hasNull) {
      normalizeTenantBizScope({
        tenantId: record.tenantId ?? "",
        bizDomain: record.bizDomain ?? "",
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO gateway_trace_event (
           gateway_trace_event_id, gateway_name, request_id, trace_id,
           execution_context_id, tenant_id, biz_domain, logical_agent_id,
           runtime_instance_id, session_id, task_id, tool_name, action,
           resource_type, resource_id, decision, reason, created_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18::timestamptz
         )`,
        [
          eventId,
          this.options.gatewayName,
          assertIdentifier(record.requestId, "requestId"),
          assertIdentifier(record.traceId, "traceId"),
          record.executionContextId,
          record.tenantId,
          record.bizDomain,
          record.logicalAgentId,
          record.runtimeInstanceId,
          record.sessionId,
          record.taskId,
          record.toolName,
          record.action,
          record.resourceType,
          record.resourceId,
          record.decision,
          assertIdentifier(record.reason, "reason"),
          createdAt,
        ],
      );
    } finally {
      client.release();
    }
  }

  public async listByTrace(input: {
    readonly scope: TenantBizScope;
    readonly traceId: string;
  }): Promise<readonly PersistedGatewayTraceRecord[]> {
    const scope = normalizeTenantBizScope(input.scope);
    const client = await this.pool.connect();
    try {
      const result = await client.query<GatewayTraceRow>(
        `SELECT gateway_trace_event_id, gateway_name, request_id, trace_id,
                execution_context_id, tenant_id, biz_domain, logical_agent_id,
                runtime_instance_id, session_id, task_id, tool_name, action,
                resource_type, resource_id, decision, reason, created_at
           FROM gateway_trace_event
          WHERE tenant_id = $1
            AND biz_domain = $2
            AND trace_id = $3
          ORDER BY created_at, gateway_trace_event_id`,
        [scope.tenantId, scope.bizDomain, assertIdentifier(input.traceId, "traceId")],
      );
      return result.rows.map(toTraceRecord);
    } finally {
      client.release();
    }
  }
}
