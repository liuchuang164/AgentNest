import { deriveLogicalAgentId } from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import {
  DemoToolOnceGuard,
  type DemoToolCompletionKey,
  type DemoToolCompletionRecord,
  type DemoToolCompletionRepository,
  type DemoToolExecutionIdentity,
  type RecordDemoToolCompletionInput,
} from "../../apps/control-plane/src/application/lifecycle-tool-once.js";
import { MutableTestClock } from "../../packages/test-support/src/clock.js";

const NOW = new Date("2030-01-03T00:00:00.000Z");
const TENANT_A = { tenantId: "tenant_A", bizDomain: "LEGAL" } as const;
const TENANT_B = { tenantId: "tenant_B", bizDomain: "LEGAL" } as const;

function completionKey(input: DemoToolCompletionKey): string {
  return JSON.stringify([
    input.scope.tenantId,
    input.scope.bizDomain,
    input.logicalAgentId,
    input.taskId,
    input.toolName,
    input.action,
    input.resourceType,
    input.resourceId,
  ]);
}

class InMemoryToolCompletionRepository implements DemoToolCompletionRepository {
  readonly #records = new Map<string, DemoToolCompletionRecord>();

  public findToolCompletion(
    input: DemoToolCompletionKey,
  ): Promise<DemoToolCompletionRecord | null> {
    return Promise.resolve(this.#records.get(completionKey(input)) ?? null);
  }

  public recordToolCompletion(input: RecordDemoToolCompletionInput): Promise<{
    readonly record: DemoToolCompletionRecord;
    readonly created: boolean;
  }> {
    const key = completionKey(input);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      return Promise.resolve({ record: existing, created: false });
    }
    const record: DemoToolCompletionRecord = { ...input };
    this.#records.set(key, record);
    return Promise.resolve({ record, created: true });
  }
}

function identity(
  scope: TenantBizScope = TENANT_A,
  overrides: Partial<DemoToolExecutionIdentity> = {},
): DemoToolExecutionIdentity {
  return {
    scope,
    logicalAgentId: deriveLogicalAgentId(scope),
    runtimeInstanceId: "ari_initial",
    sessionId: "session_initial",
    taskId: "task_001",
    toolName: "legal_analysis_write",
    action: "write",
    resourceType: "CASE",
    resourceId: "case_001",
    ...overrides,
  };
}

describe("DemoToolOnceGuard", () => {
  it("reuses a completed Demo Tool result instead of executing the write again", async () => {
    const repository = new InMemoryToolCompletionRepository();
    const guard = new DemoToolOnceGuard(repository, new MutableTestClock(NOW));
    let sideEffects = 0;
    const operation = (): Promise<Readonly<Record<string, unknown>>> => {
      sideEffects += 1;
      return Promise.resolve({ analysisId: "analysis_001" });
    };

    const first = await guard.execute(identity(), operation);
    const afterRestore = await guard.execute(
      identity(TENANT_A, {
        runtimeInstanceId: "ari_restored",
        sessionId: "session_restored",
      }),
      operation,
    );

    expect(first.executed).toBe(true);
    expect(afterRestore.executed).toBe(false);
    expect(afterRestore.result).toEqual({ analysisId: "analysis_001" });
    expect(sideEffects).toBe(1);
  });

  it("collapses concurrent calls for the same scoped task and Tool write", async () => {
    const repository = new InMemoryToolCompletionRepository();
    const guard = new DemoToolOnceGuard(repository, new MutableTestClock(NOW));
    let sideEffects = 0;
    const operation = async (): Promise<Readonly<Record<string, unknown>>> => {
      sideEffects += 1;
      await Promise.resolve();
      return { analysisId: "analysis_concurrent" };
    };

    const [first, second, third] = await Promise.all([
      guard.execute(identity(), operation),
      guard.execute(identity(), operation),
      guard.execute(identity(), operation),
    ]);

    expect(sideEffects).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("does not share completion markers across tenant scopes with the same task/resource IDs", async () => {
    const repository = new InMemoryToolCompletionRepository();
    const guard = new DemoToolOnceGuard(repository, new MutableTestClock(NOW));
    let sideEffects = 0;
    const operation = (): Promise<Readonly<Record<string, unknown>>> => {
      sideEffects += 1;
      return Promise.resolve({ writeNumber: sideEffects });
    };

    const tenantAResult = await guard.execute(identity(TENANT_A), operation);
    const tenantBResult = await guard.execute(identity(TENANT_B), operation);

    expect(tenantAResult.executed).toBe(true);
    expect(tenantBResult.executed).toBe(true);
    expect(sideEffects).toBe(2);
  });

  it("does not persist a completion marker when the Tool operation fails", async () => {
    const repository = new InMemoryToolCompletionRepository();
    const guard = new DemoToolOnceGuard(repository, new MutableTestClock(NOW));
    let attempts = 0;

    await expect(
      guard.execute(identity(), () => {
        attempts += 1;
        return Promise.reject(new Error("injected Tool failure"));
      }),
    ).rejects.toThrow("injected Tool failure");

    const retry = await guard.execute(identity(), () => {
      attempts += 1;
      return Promise.resolve({ analysisId: "analysis_retry" });
    });
    expect(retry.executed).toBe(true);
    expect(attempts).toBe(2);
  });
});
