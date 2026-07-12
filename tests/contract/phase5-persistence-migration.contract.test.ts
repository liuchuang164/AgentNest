import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../infra/postgres/migrations/003_phase5_lifecycle_persistence.sql",
  import.meta.url,
);
const runtimeMigrationUrl = new URL(
  "../../infra/postgres/migrations/001_phase2_tenant_registry.sql",
  import.meta.url,
);

describe("Phase 5 lifecycle persistence migration", () => {
  it("defines the lean Demo task, memory, summary, trace, checkpoint, and completion tables", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const table of [
      "agent_task",
      "agent_session_summary",
      "agent_memory",
      "agent_trace",
      "agent_checkpoint_artifact",
      "demo_tool_completion_marker",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(sql.match(/tenant_id text NOT NULL/gu)).toHaveLength(6);
    expect(sql.match(/biz_domain text NOT NULL/gu)).toHaveLength(6);
    expect(sql).toContain("last_active_at timestamptz NOT NULL");
    expect(sql).toContain("snapshot_path text NOT NULL");
    expect(sql).toContain("transcript_path text NOT NULL");
    expect(await readFile(runtimeMigrationUrl, "utf8")).toContain(
      "restored_from_runtime_instance_id text",
    );
  });

  it("uses tenant/business-prefixed keys and scoped restore indexes", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("PRIMARY KEY (tenant_id, biz_domain, task_id)");
    expect(sql).toContain("PRIMARY KEY (tenant_id, biz_domain, memory_id)");
    expect(sql).toContain("PRIMARY KEY (tenant_id, biz_domain, trace_event_id)");
    expect(sql).toContain("UNIQUE (tenant_id, biz_domain, logical_agent_id, task_id, dedupe_key)");
    expect(sql).toContain("UNIQUE (tenant_id, biz_domain, task_id, event_key)");
    expect(sql).toContain("agent_task_scope_status_activity_idx");
    expect(sql).toContain("agent_memory_scope_created_idx");
    expect(sql).toContain("agent_trace_scope_created_idx");
    expect(sql).not.toContain("UNIQUE (task_id)");
    expect(sql).not.toContain("UNIQUE (memory_id)");
  });

  it("keeps checkpoint paths relative and the Demo tool completion marker idempotent", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toContain("snapshot_path !~ '(^/|(^|/)\\.\\.(/|$))'");
    expect(sql).toContain("transcript_path !~ '(^/|(^|/)\\.\\.(/|$))'");
    expect(sql).toContain(
      "tenant_id, biz_domain, task_id, tool_name, action, resource_type, resource_id",
    );
    expect(sql).toContain("CHECK (checkpoint_level IN ('L1', 'L2'))");
    expect(sql).toContain("UNIQUE NULLS NOT DISTINCT");
    expect(sql).toContain("checkpoint_level = 'L1' AND session_id IS NULL AND task_id IS NULL");
    expect(sql).toContain(
      "checkpoint_level = 'L2' AND session_id IS NOT NULL AND task_id IS NOT NULL",
    );
  });

  it("does not add production security or distributed infrastructure", async () => {
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
