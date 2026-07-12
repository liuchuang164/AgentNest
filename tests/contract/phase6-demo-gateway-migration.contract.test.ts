import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../infra/postgres/migrations/004_phase6_demo_gateway.sql",
  import.meta.url,
);
const seedUrl = new URL("../../infra/postgres/seeds/002_demo_resources.sql", import.meta.url);

describe("Phase 6 Demo Gateway PostgreSQL migration", () => {
  it("defines idempotent resource, side-effect, and trace tables", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS demo_resource");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS demo_gateway_operation");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS gateway_trace_event");
    expect(sql).toContain("CHECK (gateway_name IN ('DATA', 'EXTERNAL'))");
    expect(sql).toContain("CHECK (decision IN ('ALLOW', 'DENY'))");
  });

  it("prefixes Demo resource and side-effect keys and indexes with tenant/business scope", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("PRIMARY KEY (tenant_id, biz_domain, resource_type, resource_id)");
    expect(sql).toContain("PRIMARY KEY (tenant_id, biz_domain, operation_id)");
    expect(sql).toContain("FOREIGN KEY (tenant_id, biz_domain, resource_type, resource_id)");
    expect(sql).toContain("demo_gateway_operation_scope_task_idx");
    expect(sql).toContain("demo_gateway_operation_scope_resource_idx");
    expect(sql).toContain("gateway_trace_event_scope_trace_idx");
    expect(sql).not.toContain("UNIQUE (resource_id)");
    expect(sql).not.toContain("UNIQUE (task_id)");
  });

  it("seeds both case_001 tenants plus the robot device idempotently", async () => {
    const seed = await readFile(seedUrl, "utf8");

    expect(seed.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(seed.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(seed.match(/'case_001'/gu)).toHaveLength(2);
    expect(seed).toContain("'tenant_A', 'LEGAL', 'CASE', 'case_001'");
    expect(seed).toContain("'tenant_B', 'LEGAL', 'CASE', 'case_001'");
    expect(seed).toContain("'tenant_A', 'ROBOT_DOG', 'DEVICE', 'device_001'");
    expect(seed).toContain(
      "ON CONFLICT (tenant_id, biz_domain, resource_type, resource_id) DO UPDATE",
    );
  });

  it("does not introduce task-book-external platform infrastructure", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();
    for (const deferredFeature of [
      "capability_token",
      "jwt",
      "paseto",
      "nonce",
      "outbox",
      "kafka",
      "redis",
      "minio",
      "vector",
    ]) {
      expect(sql).not.toContain(deferredFeature);
    }
  });
});
