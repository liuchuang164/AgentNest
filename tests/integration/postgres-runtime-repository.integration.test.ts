import {
  PostgresTenantCapabilityCatalog,
  PostgresTenantRuntimeRepository,
  type PostgresClient,
  type PostgresPool,
  type SqlQueryResult,
} from "@agentnest/persistence";
import { L1RuntimeStatus } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

function requiredValue(values: readonly unknown[] | undefined, index: number): unknown {
  const value = values?.[index];
  if (value === undefined) {
    throw new TypeError(`missing SQL value at index ${String(index)}`);
  }
  return value;
}

function requiredString(values: readonly unknown[] | undefined, index: number): string {
  const value = requiredValue(values, index);
  if (typeof value !== "string") {
    throw new TypeError(`SQL value at index ${String(index)} is not a string`);
  }
  return value;
}

class RecordingPostgresClient implements PostgresClient {
  public readonly statements: string[] = [];
  public releaseCount = 0;
  #logical: Record<string, unknown> | null = null;
  #runtime: Record<string, unknown> | null = null;

  public get logicalStatus(): unknown {
    return this.#logical?.["status"];
  }

  public get runtimeStatus(): unknown {
    return this.#runtime?.["status"];
  }

  public query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    this.statements.push(text.replaceAll(/\s+/g, " ").trim());
    let rows: readonly Record<string, unknown>[] = [];
    if (text.includes("FROM tenant_capability_profile")) {
      rows = [
        {
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
          created_at: new Date("2030-01-01T00:00:00.000Z"),
        },
      ];
    } else if (text.includes("FROM task_template")) {
      rows = [
        {
          task_type: "LEGAL_EVIDENCE_CHECK",
          biz_domain: "LEGAL",
          skills: ["legal-evidence-check"],
          tools: { legal_case_read: ["read"] },
          memory_scopes: ["RESOURCE_MEMORY"],
        },
      ];
    } else if (text.includes("INSERT INTO tenant_biz_agent")) {
      if (this.#logical === null) {
        this.#logical = {
          logical_agent_id: requiredString(values, 0),
          tenant_id: requiredString(values, 1),
          biz_domain: requiredString(values, 2),
          capability_profile_id: requiredString(values, 3),
          status: "PROVISIONING",
          current_runtime_instance_id: null,
          last_active_at: requiredValue(values, 4),
        };
      }
      rows = [this.#logical];
    } else if (text.includes("FROM agent_runtime_instance")) {
      rows = this.#runtime === null ? [] : [this.#runtime];
    } else if (text.includes("INSERT INTO agent_runtime_instance")) {
      this.#runtime = {
        runtime_instance_id: requiredString(values, 0),
        logical_agent_id: requiredString(values, 1),
        openclaw_agent_id: requiredString(values, 2),
        status: "PROVISIONING",
        started_at: requiredValue(values, 3),
        last_active_at: requiredValue(values, 3),
        restored_from_runtime_instance_id: values?.[4] ?? null,
      };
      rows = [this.#runtime];
    } else if (text.includes("UPDATE agent_runtime_instance AS runtime")) {
      if (
        this.#runtime !== null &&
        this.#logical !== null &&
        this.#logical["tenant_id"] === requiredString(values, 0) &&
        this.#logical["biz_domain"] === requiredString(values, 1) &&
        this.#runtime["logical_agent_id"] === requiredString(values, 2) &&
        this.#runtime["runtime_instance_id"] === requiredString(values, 3)
      ) {
        this.#runtime["status"] = requiredString(values, 4);
        this.#runtime["last_active_at"] = requiredValue(values, 5);
        rows = [{ runtime_instance_id: this.#runtime["runtime_instance_id"] }];
      }
    } else if (text.includes("UPDATE tenant_biz_agent")) {
      if (this.#logical === null) {
        throw new Error("logical agent must exist before update");
      }
      if (text.includes("SET status = $5")) {
        this.#logical["status"] = requiredString(values, 4);
        this.#logical["last_active_at"] = requiredValue(values, 5);
        rows = [{ logical_agent_id: this.#logical["logical_agent_id"] }];
      } else {
        this.#logical = {
          ...this.#logical,
          current_runtime_instance_id: requiredString(values, 1),
          last_active_at: requiredValue(values, 2),
        };
        rows = [this.#logical];
      }
    }
    return Promise.resolve({ rows: rows as readonly TRow[], rowCount: rows.length });
  }

  public release(): void {
    this.releaseCount += 1;
  }
}

class RecordingPostgresPool implements PostgresPool {
  public constructor(public readonly client: RecordingPostgresClient) {}

  public connect(): Promise<PostgresClient> {
    return Promise.resolve(this.client);
  }
}

describe("Postgres tenant runtime repository adapter", () => {
  it("loads the authoritative capability profile and task template from PostgreSQL", async () => {
    const client = new RecordingPostgresClient();
    const catalog = new PostgresTenantCapabilityCatalog(new RecordingPostgresPool(client));
    const profile = await catalog.resolveProfile({ tenantId: "tenant_A", bizDomain: "legal" });
    const template = await catalog.resolveTaskTemplate("LEGAL_EVIDENCE_CHECK");

    expect(profile.profile_id).toBe("cap_tenant_a_legal_v1");
    expect(profile.tools).toEqual({
      legal_case_read: ["read"],
      legal_analysis_write: ["write"],
      legal_research_query: ["query"],
    });
    expect(template.tools).toEqual({ legal_case_read: ["read"] });
    expect(
      client.statements.some((statement) => statement.includes("tenant_business.enabled")),
    ).toBe(true);
    expect(client.releaseCount).toBe(2);
  });

  it("uses an advisory transaction and reuses the authoritative active runtime", async () => {
    const client = new RecordingPostgresClient();
    const repository = new PostgresTenantRuntimeRepository(new RecordingPostgresPool(client));
    const now = new Date("2030-01-01T00:00:00.000Z");
    const first = await repository.ensureActiveRuntime({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      capabilityProfileId: "cap_tenant_a_legal_v1",
      candidateRuntimeInstanceId: "ari_01",
      openclawAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      now,
    });
    const second = await repository.ensureActiveRuntime({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      capabilityProfileId: "cap_tenant_a_legal_v1",
      candidateRuntimeInstanceId: "ari_02",
      openclawAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      now,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.runtime.runtimeInstanceId).toBe("ari_01");
    expect(client.statements.filter((statement) => statement === "BEGIN")).toHaveLength(2);
    expect(client.statements.filter((statement) => statement === "COMMIT")).toHaveLength(2);
    expect(
      client.statements.filter((statement) => statement.includes("pg_advisory_xact_lock")),
    ).toHaveLength(2);
    expect(client.releaseCount).toBe(2);
  });

  it("moves the provisioned runtime and logical agent to an explicit ready state", async () => {
    const client = new RecordingPostgresClient();
    const repository = new PostgresTenantRuntimeRepository(new RecordingPostgresPool(client));
    const now = new Date("2030-01-01T00:00:00.000Z");
    await repository.ensureActiveRuntime({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      capabilityProfileId: "cap_tenant_a_legal_v1",
      candidateRuntimeInstanceId: "ari_01",
      openclawAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      now,
    });

    await repository.markRuntimeReady({
      scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
      logicalAgentId: "tb_aaaaaaaaaaaaaaaaaaaa",
      runtimeInstanceId: "ari_01",
      status: L1RuntimeStatus.IDLE,
      now,
    });

    expect(client.logicalStatus).toBe(L1RuntimeStatus.IDLE);
    expect(client.runtimeStatus).toBe(L1RuntimeStatus.IDLE);
    const updateStatements = client.statements.filter((statement) =>
      statement.startsWith("UPDATE"),
    );
    expect(updateStatements).toHaveLength(3);
    expect(updateStatements.at(-1)).toContain("tenant_id = $1");
    expect(updateStatements.at(-1)).toContain("biz_domain = $2");
  });
});
