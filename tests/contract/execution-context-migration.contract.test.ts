import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../infra/postgres/migrations/002_phase4_execution_context.sql",
  import.meta.url,
);

describe("Phase 4 execution_context migration", () => {
  it("persists the complete lean Demo authority context and tenant/business indexes", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    for (const column of [
      "execution_context_id uuid PRIMARY KEY",
      "tenant_id text NOT NULL",
      "biz_domain text NOT NULL",
      "logical_agent_id text NOT NULL",
      "runtime_instance_id text NOT NULL",
      "session_id text NOT NULL",
      "task_id text NOT NULL",
      "allowed_skills jsonb NOT NULL",
      "allowed_tools jsonb NOT NULL",
      "resource_scope jsonb NOT NULL",
      "expires_at timestamptz NOT NULL",
      "created_at timestamptz NOT NULL",
      "updated_at timestamptz NOT NULL",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("FOREIGN KEY (tenant_id, biz_domain, logical_agent_id)");
    expect(sql).toContain("FOREIGN KEY (logical_agent_id, runtime_instance_id)");
    expect(sql).toContain("(tenant_id, biz_domain, execution_context_id)");
    expect(sql).toContain("(tenant_id, biz_domain, task_id)");
    expect(sql).toContain("CHECK (expires_at > created_at)");
  });

  it("does not introduce production token, replay, or messaging infrastructure", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();
    for (const deferredFeature of [
      "jwt",
      "paseto",
      "nonce",
      "revocation",
      "outbox",
      "kafka",
      "redis",
    ]) {
      expect(sql).not.toContain(deferredFeature);
    }
  });
});
