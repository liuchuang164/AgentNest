import { randomUUID } from "node:crypto";

import { normalizeTenantBizScope, type ToolActions } from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";

import type { PostgresPool, SqlQueryResult } from "./postgres.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LOGICAL_AGENT_ID = /^tb_[a-f0-9]{20}$/u;
const TOOL_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u;
const ACTION = /^[a-z][a-z0-9._-]*$/u;

export interface ExecutionResourceScope {
  readonly resourceType: string;
  readonly resourceIds: readonly string[];
}

export interface ExecutionContextRecord {
  readonly executionContextId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly allowedSkills: readonly string[];
  readonly allowedTools: ToolActions;
  readonly resourceScope: ExecutionResourceScope;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateExecutionContextInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly allowedSkills: readonly string[];
  readonly allowedTools: ToolActions;
  readonly resourceScope: ExecutionResourceScope;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface FindExecutionContextInput {
  readonly scope: TenantBizScope;
  readonly executionContextId: string;
}

export interface AuthorizeExecutionContextInput extends FindExecutionContextInput {
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly now: Date;
}

export enum ExecutionContextDenyReason {
  CONTEXT_NOT_FOUND = "CONTEXT_NOT_FOUND",
  CONTEXT_EXPIRED = "CONTEXT_EXPIRED",
  TOOL_NOT_ALLOWED = "TOOL_NOT_ALLOWED",
  ACTION_NOT_ALLOWED = "ACTION_NOT_ALLOWED",
  RESOURCE_TYPE_NOT_ALLOWED = "RESOURCE_TYPE_NOT_ALLOWED",
  RESOURCE_NOT_ALLOWED = "RESOURCE_NOT_ALLOWED",
}

export type ExecutionContextAuthorization =
  | {
      readonly allowed: true;
      readonly context: ExecutionContextRecord;
    }
  | {
      readonly allowed: false;
      readonly reason: ExecutionContextDenyReason;
    };

export interface ExecutionContextRepository {
  create(input: CreateExecutionContextInput): Promise<ExecutionContextRecord>;
  findById(input: FindExecutionContextInput): Promise<ExecutionContextRecord | null>;
  authorize(input: AuthorizeExecutionContextInput): Promise<ExecutionContextAuthorization>;
}

export interface PostgresExecutionContextRepositoryOptions {
  readonly createId?: () => string;
}

interface ExecutionContextRow extends Record<string, unknown> {
  readonly execution_context_id: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly logical_agent_id: unknown;
  readonly runtime_instance_id: unknown;
  readonly session_id: unknown;
  readonly task_id: unknown;
  readonly allowed_skills: unknown;
  readonly allowed_tools: unknown;
  readonly resource_scope: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export class ExecutionContextPersistenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ExecutionContextPersistenceError";
  }
}

export class ExecutionContextScopeError extends ExecutionContextPersistenceError {
  public constructor() {
    super("logical agent/runtime does not belong to the requested tenant/business scope");
    this.name = "ExecutionContextScopeError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExecutionContextPersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return value;
}

function readDate(value: unknown, field: string): Date {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new ExecutionContextPersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new ExecutionContextPersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  return result;
}

function assertDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid Date`);
  }
  return new Date(value.getTime());
}

function assertIdentifier(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new TypeError(`${field} must be a non-empty identifier`);
  }
  return normalized;
}

function assertUuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) {
    throw new TypeError("execution_context_id must be a UUID");
  }
  return normalized;
}

function readStringSet(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ExecutionContextPersistenceError(`PostgreSQL returned invalid ${field}`);
  }
  const strings = value.map((entry) => readString(entry, field));
  if (new Set(strings).size !== strings.length) {
    throw new ExecutionContextPersistenceError(`PostgreSQL returned duplicate ${field}`);
  }
  return strings;
}

function validateStringSet(values: readonly string[], field: string): readonly string[] {
  const normalized = values.map((value) => assertIdentifier(value, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicates`);
  }
  return normalized;
}

function readToolActions(value: unknown): ToolActions {
  if (!isRecord(value)) {
    throw new ExecutionContextPersistenceError("PostgreSQL returned invalid allowed_tools");
  }
  const result: Record<string, readonly string[]> = {};
  for (const [toolName, actions] of Object.entries(value)) {
    if (!TOOL_NAME.test(toolName)) {
      throw new ExecutionContextPersistenceError("PostgreSQL returned an invalid tool name");
    }
    const parsedActions = readStringSet(actions, `actions for ${toolName}`);
    if (parsedActions.length === 0 || !parsedActions.every((action) => ACTION.test(action))) {
      throw new ExecutionContextPersistenceError(
        `PostgreSQL returned invalid actions for ${toolName}`,
      );
    }
    result[toolName] = parsedActions;
  }
  return result;
}

function validateToolActions(value: ToolActions): ToolActions {
  const result: Record<string, readonly string[]> = {};
  for (const [toolName, actions] of Object.entries(value)) {
    if (!TOOL_NAME.test(toolName)) {
      throw new TypeError(`invalid tool name ${toolName}`);
    }
    const normalizedActions = validateStringSet(actions, `actions for ${toolName}`);
    if (
      normalizedActions.length === 0 ||
      !normalizedActions.every((action) => ACTION.test(action))
    ) {
      throw new TypeError(`invalid actions for ${toolName}`);
    }
    result[toolName] = normalizedActions;
  }
  return result;
}

function readResourceScope(value: unknown): ExecutionResourceScope {
  if (!isRecord(value)) {
    throw new ExecutionContextPersistenceError("PostgreSQL returned invalid resource_scope");
  }
  const resourceType = readString(value["resource_type"], "resource_scope.resource_type");
  const resourceIds = readStringSet(value["resource_ids"], "resource_scope.resource_ids");
  if (resourceIds.length === 0) {
    throw new ExecutionContextPersistenceError(
      "PostgreSQL returned an empty resource_scope.resource_ids",
    );
  }
  return { resourceType, resourceIds };
}

function validateResourceScope(value: ExecutionResourceScope): ExecutionResourceScope {
  const resourceType = assertIdentifier(value.resourceType, "resourceScope.resourceType");
  const resourceIds = validateStringSet(value.resourceIds, "resourceScope.resourceIds");
  if (resourceIds.length === 0) {
    throw new TypeError("resourceScope.resourceIds must not be empty");
  }
  return { resourceType, resourceIds };
}

function toRecord(row: ExecutionContextRow): ExecutionContextRecord {
  return {
    executionContextId: assertUuid(readString(row.execution_context_id, "execution_context_id")),
    tenantId: readString(row.tenant_id, "tenant_id"),
    bizDomain: readString(row.biz_domain, "biz_domain"),
    logicalAgentId: readString(row.logical_agent_id, "logical_agent_id"),
    runtimeInstanceId: readString(row.runtime_instance_id, "runtime_instance_id"),
    sessionId: readString(row.session_id, "session_id"),
    taskId: readString(row.task_id, "task_id"),
    allowedSkills: readStringSet(row.allowed_skills, "allowed_skills"),
    allowedTools: readToolActions(row.allowed_tools),
    resourceScope: readResourceScope(row.resource_scope),
    expiresAt: readDate(row.expires_at, "expires_at"),
    createdAt: readDate(row.created_at, "created_at"),
    updatedAt: readDate(row.updated_at, "updated_at"),
  };
}

function firstRow(result: SqlQueryResult<ExecutionContextRow>): ExecutionContextRow | null {
  return result.rows[0] ?? null;
}

function assertCreatedRecordMatches(
  record: ExecutionContextRecord,
  input: CreateExecutionContextInput,
  executionContextId: string,
): void {
  const normalizedScope = normalizeTenantBizScope(input.scope);
  if (
    record.executionContextId !== executionContextId ||
    record.tenantId !== normalizedScope.tenantId ||
    record.bizDomain !== normalizedScope.bizDomain ||
    record.logicalAgentId !== input.logicalAgentId ||
    record.runtimeInstanceId !== assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId") ||
    record.sessionId !== assertIdentifier(input.sessionId, "sessionId") ||
    record.taskId !== assertIdentifier(input.taskId, "taskId")
  ) {
    throw new ExecutionContextPersistenceError(
      "PostgreSQL returned an execution context outside the requested identity",
    );
  }
}

export function authorizeExecutionContext(
  context: ExecutionContextRecord | null,
  input: AuthorizeExecutionContextInput,
): ExecutionContextAuthorization {
  if (context === null) {
    return { allowed: false, reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND };
  }
  const normalizedScope = normalizeTenantBizScope(input.scope);
  if (
    context.executionContextId !== input.executionContextId.trim().toLowerCase() ||
    context.tenantId !== normalizedScope.tenantId ||
    context.bizDomain !== normalizedScope.bizDomain
  ) {
    return { allowed: false, reason: ExecutionContextDenyReason.CONTEXT_NOT_FOUND };
  }
  const now = assertDate(input.now, "now");
  if (now.getTime() >= context.expiresAt.getTime()) {
    return { allowed: false, reason: ExecutionContextDenyReason.CONTEXT_EXPIRED };
  }
  const actions = context.allowedTools[input.toolName];
  if (actions === undefined) {
    return { allowed: false, reason: ExecutionContextDenyReason.TOOL_NOT_ALLOWED };
  }
  if (!actions.includes(input.action)) {
    return { allowed: false, reason: ExecutionContextDenyReason.ACTION_NOT_ALLOWED };
  }
  if (context.resourceScope.resourceType !== input.resourceType) {
    return { allowed: false, reason: ExecutionContextDenyReason.RESOURCE_TYPE_NOT_ALLOWED };
  }
  if (!context.resourceScope.resourceIds.includes(input.resourceId)) {
    return { allowed: false, reason: ExecutionContextDenyReason.RESOURCE_NOT_ALLOWED };
  }
  return { allowed: true, context };
}

export class PostgresExecutionContextRepository implements ExecutionContextRepository {
  readonly #pool: PostgresPool;
  readonly #createId: () => string;

  public constructor(pool: PostgresPool, options: PostgresExecutionContextRepositoryOptions = {}) {
    this.#pool = pool;
    this.#createId = options.createId ?? randomUUID;
  }

  public async create(input: CreateExecutionContextInput): Promise<ExecutionContextRecord> {
    const normalizedScope = normalizeTenantBizScope(input.scope);
    if (!LOGICAL_AGENT_ID.test(input.logicalAgentId)) {
      throw new TypeError("logicalAgentId must be a stable tenant/business hash ID");
    }
    const runtimeInstanceId = assertIdentifier(input.runtimeInstanceId, "runtimeInstanceId");
    const sessionId = assertIdentifier(input.sessionId, "sessionId");
    const taskId = assertIdentifier(input.taskId, "taskId");
    const allowedSkills = validateStringSet(input.allowedSkills, "allowedSkills");
    const allowedTools = validateToolActions(input.allowedTools);
    const resourceScope = validateResourceScope(input.resourceScope);
    const now = assertDate(input.now, "now");
    const expiresAt = assertDate(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= now.getTime()) {
      throw new TypeError("expiresAt must be later than now");
    }
    const executionContextId = assertUuid(this.#createId());
    const client = await this.#pool.connect();
    try {
      const result = await client.query<ExecutionContextRow>(
        `INSERT INTO execution_context (
           execution_context_id, tenant_id, biz_domain, logical_agent_id,
           runtime_instance_id, session_id, task_id, allowed_skills, allowed_tools,
           resource_scope, expires_at, created_at, updated_at
         )
         SELECT $1::uuid, agent.tenant_id, agent.biz_domain, agent.logical_agent_id,
                runtime.runtime_instance_id, $6, $7, $8::jsonb, $9::jsonb,
                $10::jsonb, $11, $12, $12
           FROM tenant_biz_agent AS agent
           JOIN agent_runtime_instance AS runtime
             ON runtime.logical_agent_id = agent.logical_agent_id
            AND runtime.runtime_instance_id = $5
          WHERE agent.tenant_id = $2
            AND agent.biz_domain = $3
            AND agent.logical_agent_id = $4
         RETURNING execution_context_id, tenant_id, biz_domain, logical_agent_id,
                   runtime_instance_id, session_id, task_id, allowed_skills, allowed_tools,
                   resource_scope, expires_at, created_at, updated_at`,
        [
          executionContextId,
          normalizedScope.tenantId,
          normalizedScope.bizDomain,
          input.logicalAgentId,
          runtimeInstanceId,
          sessionId,
          taskId,
          JSON.stringify(allowedSkills),
          JSON.stringify(allowedTools),
          JSON.stringify({
            resource_type: resourceScope.resourceType,
            resource_ids: resourceScope.resourceIds,
          }),
          expiresAt,
          now,
        ],
      );
      const row = firstRow(result);
      if (row === null) {
        throw new ExecutionContextScopeError();
      }
      const record = toRecord(row);
      assertCreatedRecordMatches(record, input, executionContextId);
      return record;
    } finally {
      client.release();
    }
  }

  public async findById(input: FindExecutionContextInput): Promise<ExecutionContextRecord | null> {
    const normalizedScope = normalizeTenantBizScope(input.scope);
    const executionContextId = assertUuid(input.executionContextId);
    const client = await this.#pool.connect();
    try {
      const result = await client.query<ExecutionContextRow>(
        `SELECT execution_context_id, tenant_id, biz_domain, logical_agent_id,
                runtime_instance_id, session_id, task_id, allowed_skills, allowed_tools,
                resource_scope, expires_at, created_at, updated_at
           FROM execution_context
          WHERE execution_context_id = $1::uuid
            AND tenant_id = $2
            AND biz_domain = $3
          LIMIT 1`,
        [executionContextId, normalizedScope.tenantId, normalizedScope.bizDomain],
      );
      const row = firstRow(result);
      if (row === null) {
        return null;
      }
      const record = toRecord(row);
      if (
        record.executionContextId !== executionContextId ||
        record.tenantId !== normalizedScope.tenantId ||
        record.bizDomain !== normalizedScope.bizDomain
      ) {
        throw new ExecutionContextPersistenceError(
          "PostgreSQL returned an execution context outside the requested scope",
        );
      }
      return record;
    } finally {
      client.release();
    }
  }

  /**
   * Resolves the random UUID presented by the private Gateway and returns the
   * stored tenant/business identity as authoritative data.
   */
  public async findByGatewayId(executionContextId: string): Promise<ExecutionContextRecord | null> {
    const normalizedId = assertUuid(executionContextId);
    const client = await this.#pool.connect();
    try {
      const result = await client.query<ExecutionContextRow>(
        `SELECT execution_context_id, tenant_id, biz_domain, logical_agent_id,
                runtime_instance_id, session_id, task_id, allowed_skills, allowed_tools,
                resource_scope, expires_at, created_at, updated_at
           FROM execution_context
          WHERE execution_context_id = $1::uuid
          LIMIT 1`,
        [normalizedId],
      );
      const row = firstRow(result);
      if (row === null) {
        return null;
      }
      const record = toRecord(row);
      if (record.executionContextId !== normalizedId) {
        throw new ExecutionContextPersistenceError(
          "PostgreSQL returned a different execution context ID",
        );
      }
      return record;
    } finally {
      client.release();
    }
  }

  public async authorize(
    input: AuthorizeExecutionContextInput,
  ): Promise<ExecutionContextAuthorization> {
    const context = await this.findById(input);
    return authorizeExecutionContext(context, input);
  }
}
