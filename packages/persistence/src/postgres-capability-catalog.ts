import {
  UnknownTaskTemplateError,
  UnknownTenantBizScopeError,
  normalizeTenantBizScope,
  type TaskTemplate,
  type TenantCapabilityCatalog,
  type ToolActions,
} from "@agentnest/capability";
import type { CapabilityProfile, LifecyclePolicy, TenantBizScope } from "@agentnest/contracts";

import type { PostgresPool, SqlQueryResult } from "./postgres.js";

interface CapabilityProfileRow extends Record<string, unknown> {
  readonly profile_id: unknown;
  readonly version: unknown;
  readonly tenant_id: unknown;
  readonly biz_domain: unknown;
  readonly skills: unknown;
  readonly tools: unknown;
  readonly memory_scopes: unknown;
  readonly lifecycle: unknown;
  readonly created_at: unknown;
}

interface TaskTemplateRow extends Record<string, unknown> {
  readonly task_type: unknown;
  readonly biz_domain: unknown;
  readonly skills: unknown;
  readonly tools: unknown;
  readonly memory_scopes: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`PostgreSQL returned an invalid ${field}`);
  }
  return value;
}

function readPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`PostgreSQL returned an invalid ${field}`);
  }
  return value;
}

function readStringSet(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`PostgreSQL returned an invalid ${field}`);
  }
  const strings: string[] = [];
  for (const itemValue of value as readonly unknown[]) {
    if (typeof itemValue !== "string" || itemValue.length === 0) {
      throw new TypeError(`PostgreSQL returned an invalid ${field}`);
    }
    strings.push(itemValue);
  }
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`PostgreSQL returned duplicate values in ${field}`);
  }
  return strings;
}

function readToolActions(value: unknown): ToolActions {
  if (!isRecord(value)) {
    throw new TypeError("PostgreSQL returned invalid tool actions");
  }
  const result: Record<string, readonly string[]> = {};
  for (const [toolName, actions] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(toolName)) {
      throw new TypeError("PostgreSQL returned an invalid tool name");
    }
    const parsedActions = readStringSet(actions, `actions for ${toolName}`);
    if (
      parsedActions.length === 0 ||
      !parsedActions.every((action) => /^[a-z][a-z0-9._-]*$/.test(action))
    ) {
      throw new TypeError(`PostgreSQL returned invalid actions for ${toolName}`);
    }
    result[toolName] = parsedActions;
  }
  return result;
}

function readLifecycle(value: unknown): LifecyclePolicy {
  if (!isRecord(value)) {
    throw new TypeError("PostgreSQL returned an invalid lifecycle policy");
  }
  const l1IdleTtlSeconds = readPositiveInteger(value["l1_idle_ttl_seconds"], "l1_idle_ttl_seconds");
  const l2IdleTtlSeconds = readPositiveInteger(value["l2_idle_ttl_seconds"], "l2_idle_ttl_seconds");
  const maxActiveL2 = readPositiveInteger(value["max_active_l2"], "max_active_l2");
  if (l1IdleTtlSeconds < 60 || maxActiveL2 > 20) {
    throw new TypeError("PostgreSQL returned a lifecycle policy outside Demo limits");
  }
  return {
    l1_idle_ttl_seconds: l1IdleTtlSeconds,
    l2_idle_ttl_seconds: l2IdleTtlSeconds,
    max_active_l2: maxActiveL2,
  };
}

function readTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(readString(value, "created_at"));
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("PostgreSQL returned an invalid created_at");
  }
  return date.toISOString();
}

function firstRow<TRow extends Record<string, unknown>>(result: SqlQueryResult<TRow>): TRow | null {
  return result.rows[0] ?? null;
}

export class PostgresTenantCapabilityCatalog implements TenantCapabilityCatalog {
  public constructor(private readonly pool: PostgresPool) {}

  public async resolveProfile(scope: TenantBizScope): Promise<CapabilityProfile> {
    const normalized = normalizeTenantBizScope(scope);
    const client = await this.pool.connect();
    try {
      const result = await client.query<CapabilityProfileRow>(
        `SELECT profile.profile_id, profile.version, profile.tenant_id, profile.biz_domain,
                profile.skills, profile.tools, profile.memory_scopes, profile.lifecycle,
                profile.created_at
           FROM tenant_capability_profile AS profile
           JOIN tenant_business AS tenant_business
             ON tenant_business.tenant_id = profile.tenant_id
            AND tenant_business.biz_domain = profile.biz_domain
          WHERE profile.tenant_id = $1
            AND profile.biz_domain = $2
            AND tenant_business.enabled = true
          ORDER BY profile.version DESC
          LIMIT 1`,
        [normalized.tenantId, normalized.bizDomain],
      );
      const row = firstRow(result);
      if (row === null) {
        throw new UnknownTenantBizScopeError(normalized.tenantId, normalized.bizDomain);
      }
      const profile: CapabilityProfile = {
        profile_id: readString(row.profile_id, "profile_id"),
        version: readPositiveInteger(row.version, "profile version"),
        tenant_id: readString(row.tenant_id, "tenant_id"),
        biz_domain: readString(row.biz_domain, "biz_domain"),
        skills: [...readStringSet(row.skills, "skills")],
        tools: Object.fromEntries(
          Object.entries(readToolActions(row.tools)).map(([toolName, actions]) => [
            toolName,
            [...actions],
          ]),
        ),
        memory_scopes: [...readStringSet(row.memory_scopes, "memory_scopes")],
        lifecycle: readLifecycle(row.lifecycle),
        created_at: readTimestamp(row.created_at),
      };
      if (
        profile.tenant_id !== normalized.tenantId ||
        profile.biz_domain !== normalized.bizDomain
      ) {
        throw new Error("PostgreSQL returned a capability profile outside the requested scope");
      }
      return profile;
    } finally {
      client.release();
    }
  }

  public async resolveTaskTemplate(taskType: string): Promise<TaskTemplate> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<TaskTemplateRow>(
        `SELECT task_type, biz_domain, skills, tools, memory_scopes
           FROM task_template
          WHERE task_type = $1`,
        [taskType],
      );
      const row = firstRow(result);
      if (row === null) {
        throw new UnknownTaskTemplateError(taskType);
      }
      const storedTaskType = readString(row.task_type, "task_type");
      if (storedTaskType !== taskType) {
        throw new Error("PostgreSQL returned a different task template");
      }
      return {
        taskType: storedTaskType,
        bizDomain: readString(row.biz_domain, "biz_domain"),
        skills: readStringSet(row.skills, "skills"),
        tools: readToolActions(row.tools),
        memoryScopes: readStringSet(row.memory_scopes, "memory_scopes"),
      };
    } finally {
      client.release();
    }
  }
}
