import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_L1_IDLE_TTL_MS,
  DEFAULT_L2_IDLE_TTL_MS,
  LifecycleReaper,
  LifecycleReaperFailurePhase,
  isActiveL2Status,
  lifecycleTtlFromEnvironment,
  type L1LifecycleIdentity,
  type L1LifecycleRecord,
  type L2LifecycleIdentity,
  type L2LifecycleRecord,
  type LifecycleCheckpointWriter,
  type LifecycleRepository,
  type LifecycleRuntimeUnloader,
} from "../../apps/control-plane/src/application/lifecycle-reaper.js";
import { MutableTestClock } from "../../packages/test-support/src/clock.js";

const INITIAL_TIME = new Date("2030-01-01T00:00:00.000Z");
const DEMO_SCOPES = [
  { tenantId: "tenant_A", bizDomain: "LEGAL" },
  { tenantId: "tenant_A", bizDomain: "ROBOT_DOG" },
  { tenantId: "tenant_B", bizDomain: "LEGAL" },
] as const satisfies readonly TenantBizScope[];

function scopeKey(scope: TenantBizScope): string {
  return `${scope.tenantId}/${scope.bizDomain}`;
}

function sameScope(left: TenantBizScope, right: TenantBizScope): boolean {
  return left.tenantId === right.tenantId && left.bizDomain === right.bizDomain;
}

function l1Record(
  scope: TenantBizScope,
  logicalAgentId: string,
  overrides: Partial<L1LifecycleRecord> = {},
): L1LifecycleRecord {
  return {
    scope,
    logicalAgentId,
    runtimeInstanceId: `ari_${logicalAgentId}`,
    status: L1RuntimeStatus.IDLE,
    lastActiveAt: INITIAL_TIME,
    ...overrides,
  };
}

function l2Record(
  scope: TenantBizScope,
  logicalAgentId: string,
  overrides: Partial<L2LifecycleRecord> = {},
): L2LifecycleRecord {
  return {
    scope,
    logicalAgentId,
    runtimeInstanceId: `ari_${logicalAgentId}`,
    sessionId: `session_${logicalAgentId}`,
    taskId: `task_${logicalAgentId}`,
    status: L2TaskStatus.WAITING_INPUT,
    lastActiveAt: INITIAL_TIME,
    ...overrides,
  };
}

class InMemoryLifecycleRepository implements LifecycleRepository {
  public readonly queriedL1Scopes: string[] = [];
  public readonly queriedL2Scopes: string[] = [];
  public readonly unloadedL2TaskIds = new Set<string>();

  public constructor(
    public l1Records: L1LifecycleRecord[],
    public l2Records: L2LifecycleRecord[],
  ) {}

  public listL2LifecycleRecords(scope: TenantBizScope): Promise<readonly L2LifecycleRecord[]> {
    this.queriedL2Scopes.push(scopeKey(scope));
    return Promise.resolve(
      this.l2Records.filter(
        (record) => sameScope(record.scope, scope) && !this.unloadedL2TaskIds.has(record.taskId),
      ),
    );
  }

  public listL1LifecycleRecords(scope: TenantBizScope): Promise<readonly L1LifecycleRecord[]> {
    this.queriedL1Scopes.push(scopeKey(scope));
    return Promise.resolve(this.l1Records.filter((record) => sameScope(record.scope, scope)));
  }

  public hasActiveL2(input: L1LifecycleIdentity): Promise<boolean> {
    return Promise.resolve(
      this.l2Records.some(
        (record) =>
          sameScope(record.scope, input.scope) &&
          record.logicalAgentId === input.logicalAgentId &&
          record.runtimeInstanceId === input.runtimeInstanceId &&
          !this.unloadedL2TaskIds.has(record.taskId) &&
          isActiveL2Status(record.status),
      ),
    );
  }

  public markL2Unloaded(input: L2LifecycleIdentity & { readonly unloadedAt: Date }): Promise<void> {
    this.unloadedL2TaskIds.add(input.taskId);
    this.l2Records = this.l2Records.map((record) =>
      sameScope(record.scope, input.scope) && record.taskId === input.taskId
        ? {
            ...record,
            status:
              record.status === L2TaskStatus.WAITING_INPUT
                ? L2TaskStatus.WAITING_INPUT
                : L2TaskStatus.UNLOADED,
            lastActiveAt: input.unloadedAt,
          }
        : record,
    );
    return Promise.resolve();
  }

  public markL1Unloaded(input: L1LifecycleIdentity & { readonly unloadedAt: Date }): Promise<void> {
    this.l1Records = this.l1Records.map((record) =>
      sameScope(record.scope, input.scope) &&
      record.logicalAgentId === input.logicalAgentId &&
      record.runtimeInstanceId === input.runtimeInstanceId
        ? { ...record, status: L1RuntimeStatus.UNLOADED, lastActiveAt: input.unloadedAt }
        : record,
    );
    return Promise.resolve();
  }
}

class RecordingCheckpointWriter implements LifecycleCheckpointWriter {
  public readonly l1Checkpointed: string[] = [];
  public readonly l2Checkpointed: string[] = [];
  public readonly failingIds = new Set<string>();

  public checkpointL2(record: L2LifecycleRecord): Promise<void> {
    if (this.failingIds.has(record.taskId)) {
      return Promise.reject(new Error("injected checkpoint failure"));
    }
    this.l2Checkpointed.push(record.taskId);
    return Promise.resolve();
  }

  public checkpointL1(record: L1LifecycleRecord): Promise<void> {
    if (this.failingIds.has(record.runtimeInstanceId)) {
      return Promise.reject(new Error("injected checkpoint failure"));
    }
    this.l1Checkpointed.push(record.runtimeInstanceId);
    return Promise.resolve();
  }
}

class RecordingRuntimeUnloader implements LifecycleRuntimeUnloader {
  public readonly l1Unloaded: string[] = [];
  public readonly l2Unloaded: string[] = [];

  public unloadL2(record: L2LifecycleRecord): Promise<void> {
    this.l2Unloaded.push(record.taskId);
    return Promise.resolve();
  }

  public unloadL1(record: L1LifecycleRecord): Promise<void> {
    this.l1Unloaded.push(record.runtimeInstanceId);
    return Promise.resolve();
  }
}

function createHarness(l1Records: L1LifecycleRecord[], l2Records: L2LifecycleRecord[]) {
  const repository = new InMemoryLifecycleRepository(l1Records, l2Records);
  const checkpoints = new RecordingCheckpointWriter();
  const unloader = new RecordingRuntimeUnloader();
  const clock = new MutableTestClock(INITIAL_TIME);
  const reaper = new LifecycleReaper(repository, checkpoints, unloader, clock, {
    scopes: DEMO_SCOPES,
  });
  return { repository, checkpoints, unloader, clock, reaper };
}

describe("LifecycleReaper", () => {
  it("uses explicit tenant/biz-scoped scans for all three Demo scopes", async () => {
    const harness = createHarness([], []);

    await harness.reaper.runOnce();

    const expected = DEMO_SCOPES.map(scopeKey);
    expect(harness.repository.queriedL1Scopes).toEqual(expected);
    expect(harness.repository.queriedL2Scopes).toEqual(expected);
  });

  it("does not unload L2 at 1h minus 1 second and unloads at the exact 1h boundary", async () => {
    const task = l2Record(DEMO_SCOPES[0], "tb_11111111111111111111");
    const harness = createHarness([], [task]);
    harness.clock.advance(DEFAULT_L2_IDLE_TTL_MS - 1_000);

    const beforeBoundary = await harness.reaper.runOnce();
    expect(beforeBoundary.l2Unloaded).toBe(0);
    expect(harness.checkpoints.l2Checkpointed).toEqual([]);

    harness.clock.advance(1_000);
    const atBoundary = await harness.reaper.runOnce();
    expect(atBoundary.l2Unloaded).toBe(1);
    expect(harness.checkpoints.l2Checkpointed).toEqual([task.taskId]);
    expect(harness.unloader.l2Unloaded).toEqual([task.taskId]);
    expect(harness.repository.l2Records[0]?.status).toBe(L2TaskStatus.WAITING_INPUT);
    expect(harness.repository.unloadedL2TaskIds).toContain(task.taskId);
  });

  it("does not unload L1 at 24h minus 1 second and unloads at the exact 24h boundary", async () => {
    const agent = l1Record(DEMO_SCOPES[2], "tb_22222222222222222222");
    const harness = createHarness([agent], []);
    harness.clock.advance(DEFAULT_L1_IDLE_TTL_MS - 1_000);

    const beforeBoundary = await harness.reaper.runOnce();
    expect(beforeBoundary.l1Unloaded).toBe(0);

    harness.clock.advance(1_000);
    const atBoundary = await harness.reaper.runOnce();
    expect(atBoundary.l1Unloaded).toBe(1);
    expect(harness.checkpoints.l1Checkpointed).toEqual([agent.runtimeInstanceId]);
    expect(harness.repository.l1Records[0]?.status).toBe(L1RuntimeStatus.UNLOADED);
  });

  it("keeps L1 loaded while an active L2 exists", async () => {
    const logicalAgentId = "tb_33333333333333333333";
    const agent = l1Record(DEMO_SCOPES[1], logicalAgentId);
    const activeTask = l2Record(DEMO_SCOPES[1], logicalAgentId, {
      status: L2TaskStatus.RUNNING,
    });
    const harness = createHarness([agent], [activeTask]);
    harness.clock.advance(DEFAULT_L1_IDLE_TTL_MS);

    const result = await harness.reaper.runOnce();

    expect(result.l1Unloaded).toBe(0);
    expect(result.skippedActive).toBe(2);
    expect(harness.checkpoints.l1Checkpointed).toEqual([]);
    expect(harness.unloader.l1Unloaded).toEqual([]);
    expect(harness.repository.l1Records[0]?.status).toBe(L1RuntimeStatus.IDLE);
  });

  it("never unloads or marks L1/L2 UNLOADED when checkpoint persistence fails", async () => {
    const l1 = l1Record(DEMO_SCOPES[2], "tb_44444444444444444444");
    const l2 = l2Record(DEMO_SCOPES[0], "tb_55555555555555555555");
    const harness = createHarness([l1], [l2]);
    harness.checkpoints.failingIds.add(l1.runtimeInstanceId);
    harness.checkpoints.failingIds.add(l2.taskId);
    harness.clock.advance(DEFAULT_L1_IDLE_TTL_MS);

    const result = await harness.reaper.runOnce();

    expect(result.failed).toBe(2);
    expect(result.failures.map((failure) => failure.phase)).toEqual([
      LifecycleReaperFailurePhase.CHECKPOINT,
      LifecycleReaperFailurePhase.CHECKPOINT,
    ]);
    expect(harness.unloader.l1Unloaded).toEqual([]);
    expect(harness.unloader.l2Unloaded).toEqual([]);
    expect(harness.repository.l1Records[0]?.status).toBe(L1RuntimeStatus.IDLE);
    expect(harness.repository.l2Records[0]?.status).toBe(L2TaskStatus.WAITING_INPUT);
  });

  it("does not repeat persistence for an already CHECKPOINTED L2", async () => {
    const task = l2Record(DEMO_SCOPES[0], "tb_66666666666666666666", {
      status: L2TaskStatus.CHECKPOINTED,
    });
    const harness = createHarness([], [task]);
    harness.clock.advance(DEFAULT_L2_IDLE_TTL_MS);

    const result = await harness.reaper.runOnce();

    expect(result.l2Unloaded).toBe(1);
    expect(harness.checkpoints.l2Checkpointed).toEqual([]);
    expect(harness.unloader.l2Unloaded).toEqual([task.taskId]);
  });

  it("loads TTLs from seconds without permitting invalid or zero values", () => {
    expect(lifecycleTtlFromEnvironment({})).toEqual({
      l1IdleTtlMs: DEFAULT_L1_IDLE_TTL_MS,
      l2IdleTtlMs: DEFAULT_L2_IDLE_TTL_MS,
    });
    expect(
      lifecycleTtlFromEnvironment({
        L1_IDLE_TTL_SECONDS: "10",
        L2_IDLE_TTL_SECONDS: "20",
      }),
    ).toEqual({ l1IdleTtlMs: 10_000, l2IdleTtlMs: 20_000 });
    expect(() => lifecycleTtlFromEnvironment({ L2_IDLE_TTL_SECONDS: "0" })).toThrow(TypeError);
  });
});
