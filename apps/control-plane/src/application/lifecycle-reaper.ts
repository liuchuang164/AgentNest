import { normalizeTenantBizScope } from "@agentnest/capability";
import { L1RuntimeStatus, L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";

export const DEFAULT_L1_IDLE_TTL_MS = 86_400_000;
export const DEFAULT_L2_IDLE_TTL_MS = 3_600_000;

export interface LifecycleClock {
  now(): Date;
}

export interface LifecycleTtlOptions {
  readonly l1IdleTtlMs: number;
  readonly l2IdleTtlMs: number;
}

export interface LifecycleReaperOptions extends Partial<LifecycleTtlOptions> {
  readonly scopes: readonly TenantBizScope[];
}

export interface L1LifecycleRecord {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly status: L1RuntimeStatus;
  readonly lastActiveAt: Date;
}

export interface L2LifecycleRecord {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly status: L2TaskStatus;
  readonly lastActiveAt: Date;
}

export interface L1LifecycleIdentity {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
}

export interface L2LifecycleIdentity extends L1LifecycleIdentity {
  readonly sessionId: string;
  readonly taskId: string;
}

export interface LifecycleRepository {
  listL2LifecycleRecords(scope: TenantBizScope): Promise<readonly L2LifecycleRecord[]>;
  listL1LifecycleRecords(scope: TenantBizScope): Promise<readonly L1LifecycleRecord[]>;
  hasActiveL2(input: L1LifecycleIdentity): Promise<boolean>;
  markL2Unloaded(input: L2LifecycleIdentity & { readonly unloadedAt: Date }): Promise<void>;
  markL1Unloaded(input: L1LifecycleIdentity & { readonly unloadedAt: Date }): Promise<void>;
}

/**
 * A concrete adapter must persist the Phase 5 TaskState, Session Summary, Memory,
 * Trace and checkpoint artifact before resolving either method.
 */
export interface LifecycleCheckpointWriter {
  checkpointL2(record: L2LifecycleRecord, checkpointedAt: Date): Promise<void>;
  checkpointL1(record: L1LifecycleRecord, checkpointedAt: Date): Promise<void>;
}

export interface LifecycleRuntimeUnloader {
  unloadL2(record: L2LifecycleRecord): Promise<void>;
  unloadL1(record: L1LifecycleRecord): Promise<void>;
}

export enum LifecycleReaperFailurePhase {
  CHECKPOINT = "CHECKPOINT",
  RUNTIME_UNLOAD = "RUNTIME_UNLOAD",
  STATE_UPDATE = "STATE_UPDATE",
  ACTIVE_CHILD_LOOKUP = "ACTIVE_CHILD_LOOKUP",
}

export interface LifecycleReaperFailure {
  readonly level: "L1" | "L2";
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly taskId: string | null;
  readonly phase: LifecycleReaperFailurePhase;
}

export interface LifecycleReaperResult {
  readonly l1Scanned: number;
  readonly l1Unloaded: number;
  readonly l2Scanned: number;
  readonly l2Unloaded: number;
  readonly skippedActive: number;
  readonly failed: number;
  readonly failures: readonly LifecycleReaperFailure[];
}

function parseTtlSeconds(value: string | undefined, name: string, fallbackMs: number): number {
  if (value === undefined) {
    return fallbackMs;
  }
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/u.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer number of seconds`);
  }
  const milliseconds = Number(normalized) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError(`${name} is outside the supported range`);
  }
  return milliseconds;
}

export function lifecycleTtlFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): LifecycleTtlOptions {
  return {
    l1IdleTtlMs: parseTtlSeconds(
      environment["L1_IDLE_TTL_SECONDS"],
      "L1_IDLE_TTL_SECONDS",
      DEFAULT_L1_IDLE_TTL_MS,
    ),
    l2IdleTtlMs: parseTtlSeconds(
      environment["L2_IDLE_TTL_SECONDS"],
      "L2_IDLE_TTL_SECONDS",
      DEFAULT_L2_IDLE_TTL_MS,
    ),
  };
}

export function isLifecycleIdleExpired(lastActiveAt: Date, now: Date, ttlMs: number): boolean {
  const lastActiveTimestamp = lastActiveAt.getTime();
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(lastActiveTimestamp) || !Number.isFinite(nowTimestamp)) {
    throw new RangeError("lifecycle timestamps must be valid Dates");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("lifecycle TTL must be a positive safe integer");
  }
  return nowTimestamp - lastActiveTimestamp >= ttlMs;
}

export function isActiveL2Status(status: L2TaskStatus): boolean {
  return [
    L2TaskStatus.QUEUED,
    L2TaskStatus.SPAWNING,
    L2TaskStatus.RUNNING,
    L2TaskStatus.WAITING_INPUT,
  ].includes(status);
}

function requiresL2Checkpoint(status: L2TaskStatus): boolean {
  return [L2TaskStatus.WAITING_INPUT, L2TaskStatus.COMPLETED, L2TaskStatus.FAILED].includes(status);
}

function isL2Unloadable(status: L2TaskStatus): boolean {
  return requiresL2Checkpoint(status) || status === L2TaskStatus.CHECKPOINTED;
}

function l1Identity(record: L1LifecycleIdentity): L1LifecycleIdentity {
  return {
    scope: record.scope,
    logicalAgentId: record.logicalAgentId,
    runtimeInstanceId: record.runtimeInstanceId,
  };
}

function l2Identity(record: L2LifecycleRecord): L2LifecycleIdentity {
  return {
    ...l1Identity(record),
    sessionId: record.sessionId,
    taskId: record.taskId,
  };
}

export class LifecycleReaper {
  readonly #ttl: LifecycleTtlOptions;
  readonly #scopes: readonly TenantBizScope[];

  public constructor(
    private readonly repository: LifecycleRepository,
    private readonly checkpointWriter: LifecycleCheckpointWriter,
    private readonly runtimeUnloader: LifecycleRuntimeUnloader,
    private readonly clock: LifecycleClock,
    options: LifecycleReaperOptions,
  ) {
    const scopesByKey = new Map<string, TenantBizScope>();
    for (const requestedScope of options.scopes) {
      const scope = normalizeTenantBizScope(requestedScope);
      scopesByKey.set(`${scope.tenantId}\u0000${scope.bizDomain}`, scope);
    }
    if (scopesByKey.size === 0) {
      throw new TypeError("Lifecycle Reaper requires at least one explicit tenant/biz scope");
    }
    this.#scopes = [...scopesByKey.values()];
    this.#ttl = {
      l1IdleTtlMs: options.l1IdleTtlMs ?? DEFAULT_L1_IDLE_TTL_MS,
      l2IdleTtlMs: options.l2IdleTtlMs ?? DEFAULT_L2_IDLE_TTL_MS,
    };
    isLifecycleIdleExpired(this.clock.now(), this.clock.now(), this.#ttl.l1IdleTtlMs);
    isLifecycleIdleExpired(this.clock.now(), this.clock.now(), this.#ttl.l2IdleTtlMs);
  }

  public async runOnce(): Promise<LifecycleReaperResult> {
    const now = this.clock.now();
    const [l2RecordsByScope, l1RecordsByScope] = await Promise.all([
      Promise.all(
        this.#scopes.map(async (scope) => {
          const records = await this.repository.listL2LifecycleRecords(scope);
          this.assertRecordsAreScoped(records, scope);
          return records;
        }),
      ),
      Promise.all(
        this.#scopes.map(async (scope) => {
          const records = await this.repository.listL1LifecycleRecords(scope);
          this.assertRecordsAreScoped(records, scope);
          return records;
        }),
      ),
    ]);
    const l2Records = l2RecordsByScope.flat();
    const l1Records = l1RecordsByScope.flat();
    const failures: LifecycleReaperFailure[] = [];
    let l2Unloaded = 0;
    let l1Unloaded = 0;
    let skippedActive = 0;

    for (const record of l2Records) {
      if (!isLifecycleIdleExpired(record.lastActiveAt, now, this.#ttl.l2IdleTtlMs)) {
        continue;
      }
      if (!isL2Unloadable(record.status)) {
        if (isActiveL2Status(record.status)) {
          skippedActive += 1;
        }
        continue;
      }

      if (requiresL2Checkpoint(record.status)) {
        try {
          await this.checkpointWriter.checkpointL2(record, now);
        } catch {
          failures.push(this.failure(record, LifecycleReaperFailurePhase.CHECKPOINT));
          continue;
        }
      }

      try {
        await this.runtimeUnloader.unloadL2(record);
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.RUNTIME_UNLOAD));
        continue;
      }

      try {
        await this.repository.markL2Unloaded({ ...l2Identity(record), unloadedAt: now });
        l2Unloaded += 1;
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.STATE_UPDATE));
      }
    }

    for (const record of l1Records) {
      if (
        record.status !== L1RuntimeStatus.IDLE ||
        !isLifecycleIdleExpired(record.lastActiveAt, now, this.#ttl.l1IdleTtlMs)
      ) {
        continue;
      }

      let hasActiveL2: boolean;
      try {
        hasActiveL2 = await this.repository.hasActiveL2(l1Identity(record));
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.ACTIVE_CHILD_LOOKUP));
        continue;
      }
      if (hasActiveL2) {
        skippedActive += 1;
        continue;
      }

      try {
        await this.checkpointWriter.checkpointL1(record, now);
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.CHECKPOINT));
        continue;
      }

      try {
        await this.runtimeUnloader.unloadL1(record);
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.RUNTIME_UNLOAD));
        continue;
      }

      try {
        await this.repository.markL1Unloaded({ ...l1Identity(record), unloadedAt: now });
        l1Unloaded += 1;
      } catch {
        failures.push(this.failure(record, LifecycleReaperFailurePhase.STATE_UPDATE));
      }
    }

    return {
      l1Scanned: l1Records.length,
      l1Unloaded,
      l2Scanned: l2Records.length,
      l2Unloaded,
      skippedActive,
      failed: failures.length,
      failures,
    };
  }

  private failure(
    record: L1LifecycleRecord | L2LifecycleRecord,
    phase: LifecycleReaperFailurePhase,
  ): LifecycleReaperFailure {
    return {
      level: "taskId" in record ? "L2" : "L1",
      logicalAgentId: record.logicalAgentId,
      runtimeInstanceId: record.runtimeInstanceId,
      taskId: "taskId" in record ? record.taskId : null,
      phase,
    };
  }

  private assertRecordsAreScoped(
    records: readonly (L1LifecycleRecord | L2LifecycleRecord)[],
    requestedScope: TenantBizScope,
  ): void {
    if (
      records.some(
        (record) =>
          record.scope.tenantId !== requestedScope.tenantId ||
          record.scope.bizDomain !== requestedScope.bizDomain,
      )
    ) {
      throw new Error("lifecycle repository returned data outside the requested tenant/biz scope");
    }
  }
}
