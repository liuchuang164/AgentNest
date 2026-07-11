import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve("infra/postgres/migrations/001_phase2_tenant_registry.sql");
const seedPath = resolve("infra/postgres/seeds/001_demo_scopes.sql");

describe("Phase 2 PostgreSQL contract", () => {
  it("defines the authoritative profile and runtime registry tables transactionally", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const table of [
      "tenant_business",
      "tenant_capability_profile",
      "task_template",
      "tenant_biz_agent",
      "agent_runtime_instance",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toContain("UNIQUE (tenant_id, biz_domain)");
    expect(sql).toContain("agent_runtime_instance_one_active_idx");
    expect(sql).toContain("timestamptz");
  });

  it("seeds exactly the three required tenant/biz scopes and two task templates", async () => {
    const sql = await readFile(seedPath, "utf8");
    const scopeRows = [...sql.matchAll(/\('tenant_[AB]', '(?:LEGAL|ROBOT_DOG)'\)/g)].map(
      ([row]) => row,
    );
    expect(scopeRows).toEqual([
      "('tenant_A', 'LEGAL')",
      "('tenant_A', 'ROBOT_DOG')",
      "('tenant_B', 'LEGAL')",
    ]);
    expect(sql).toContain("LEGAL_EVIDENCE_CHECK");
    expect(sql).toContain("ROBOT_DOG_HEALTH_CHECK");
    expect(sql).toContain("legal_research_query");
    expect(sql).toContain("robot_telemetry_enrich");
  });

  it("does not reintroduce production security infrastructure", async () => {
    const text = `${await readFile(migrationPath, "utf8")}\n${await readFile(seedPath, "utf8")}`;
    for (const forbidden of [
      "capability_token",
      "jws",
      "nonce",
      "revocation",
      "replay",
      "outbox",
      "redis",
      "minio",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});
