import { deriveLogicalAgentId } from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";
import type {
  PostgresPhase5PersistenceRepository,
  RecordToolCompletionInput as PersistenceRecordToolCompletionInput,
  RecordToolCompletionResult,
  ToolCompletionLookupKey,
  ToolCompletionRecord,
} from "@agentnest/persistence";
import { describe, expect, it } from "vitest";

import { DemoToolOnceGuard } from "../../apps/control-plane/src/application/lifecycle-tool-once.js";
import {
  Phase5AdapterError,
  Phase5DemoToolCompletionRepositoryAdapter,
} from "../../apps/control-plane/src/infrastructure/phase5-adapters.js";
import { MutableTestClock } from "../../packages/test-support/src/clock.js";

const SCOPE = { tenantId: "tenant_A", bizDomain: "LEGAL" } as const satisfies TenantBizScope;
const LOGICAL_AGENT_ID = deriveLogicalAgentId(SCOPE);
const NOW = new Date("2030-01-03T00:00:00.000Z");

type ToolPersistence = Pick<
  PostgresPhase5PersistenceRepository,
  "findToolCompletion" | "recordToolCompletion"
>;

function markerKey(input: ToolCompletionLookupKey): string {
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

class InMemoryPhase5ToolPersistence implements ToolPersistence {
  readonly #records = new Map<string, ToolCompletionRecord>();
  #sequence = 0;

  public findToolCompletion(input: ToolCompletionLookupKey): Promise<ToolCompletionRecord | null> {
    return Promise.resolve(this.#records.get(markerKey(input)) ?? null);
  }

  public recordToolCompletion(
    input: PersistenceRecordToolCompletionInput,
  ): Promise<RecordToolCompletionResult> {
    const key = markerKey(input);
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      return Promise.resolve({ record: existing, created: false });
    }
    this.#sequence += 1;
    const record: ToolCompletionRecord = {
      markerId: `00000000-0000-4000-8000-${this.#sequence.toString().padStart(12, "0")}`,
      tenantId: input.scope.tenantId,
      bizDomain: input.scope.bizDomain,
      logicalAgentId: input.logicalAgentId,
      runtimeInstanceId: input.runtimeInstanceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolName: input.toolName,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      result: structuredClone(input.result),
      completedAt: new Date(input.completedAt.getTime()),
    };
    this.#records.set(key, record);
    return Promise.resolve({ record, created: true });
  }
}

function completionInput(runtimeInstanceId: string, sessionId: string) {
  return {
    scope: SCOPE,
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId,
    sessionId,
    taskId: "task_001",
    toolName: "legal_analysis_write",
    action: "write",
    resourceType: "CASE",
    resourceId: "case_001",
    result: { analysisId: "analysis_001" },
    completedAt: NOW,
  } as const;
}

describe("Phase 5 concrete Tool completion adapter", () => {
  it("preserves the durable created flag and marker across restored runtimes", async () => {
    const adapter = new Phase5DemoToolCompletionRepositoryAdapter(
      new InMemoryPhase5ToolPersistence(),
    );

    const first = await adapter.recordToolCompletion(
      completionInput("ari_initial", "session_initial"),
    );
    const afterRestore = await adapter.recordToolCompletion(
      completionInput("ari_restored", "session_restored"),
    );

    expect(first.created).toBe(true);
    expect(afterRestore.created).toBe(false);
    expect(afterRestore.record.scope).toEqual(SCOPE);
    expect(afterRestore.record.runtimeInstanceId).toBe("ari_initial");
    expect(afterRestore.record.result).toEqual({ analysisId: "analysis_001" });
  });

  it("composes with DemoToolOnceGuard so a restored runtime does not repeat a write", async () => {
    const adapter = new Phase5DemoToolCompletionRepositoryAdapter(
      new InMemoryPhase5ToolPersistence(),
    );
    const guard = new DemoToolOnceGuard(adapter, new MutableTestClock(NOW));
    let sideEffects = 0;
    const operation = (): Promise<Readonly<Record<string, unknown>>> => {
      sideEffects += 1;
      return Promise.resolve({ analysisId: "analysis_001" });
    };

    const first = await guard.execute(completionInput("ari_initial", "session_initial"), operation);
    const afterRestore = await guard.execute(
      completionInput("ari_restored", "session_restored"),
      operation,
    );

    expect(first.executed).toBe(true);
    expect(afterRestore.executed).toBe(false);
    expect(sideEffects).toBe(1);
  });

  it("fails closed if persistence returns a Tool marker from another tenant", async () => {
    const persistence: ToolPersistence = {
      findToolCompletion: (input) =>
        Promise.resolve({
          markerId: "00000000-0000-4000-8000-000000000099",
          tenantId: "tenant_B",
          bizDomain: input.scope.bizDomain,
          logicalAgentId: input.logicalAgentId,
          runtimeInstanceId: "ari_other",
          sessionId: "session_other",
          taskId: input.taskId,
          toolName: input.toolName,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          result: {},
          completedAt: NOW,
        }),
      recordToolCompletion: () => {
        throw new Error("not used");
      },
    };
    const adapter = new Phase5DemoToolCompletionRepositoryAdapter(persistence);

    await expect(
      adapter.findToolCompletion(completionInput("ari_initial", "session_initial")),
    ).rejects.toThrow(Phase5AdapterError);
  });
});
