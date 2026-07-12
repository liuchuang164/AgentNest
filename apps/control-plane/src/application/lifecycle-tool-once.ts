import { normalizeTenantBizScope } from "@agentnest/capability";
import type { TenantBizScope } from "@agentnest/contracts";

import type { LifecycleClock } from "./lifecycle-reaper.js";

export type DemoToolJsonObject = Readonly<Record<string, unknown>>;

export interface DemoToolCompletionKey {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface DemoToolExecutionIdentity extends DemoToolCompletionKey {
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
}

export interface DemoToolCompletionRecord extends DemoToolExecutionIdentity {
  readonly result: DemoToolJsonObject;
  readonly completedAt: Date;
}

export interface RecordDemoToolCompletionInput extends DemoToolExecutionIdentity {
  readonly result: DemoToolJsonObject;
  readonly completedAt: Date;
}

export interface DemoToolCompletionRepository {
  findToolCompletion(input: DemoToolCompletionKey): Promise<DemoToolCompletionRecord | null>;
  recordToolCompletion(input: RecordDemoToolCompletionInput): Promise<{
    readonly record: DemoToolCompletionRecord;
    readonly created: boolean;
  }>;
}

export interface DemoToolOnceResult {
  readonly result: DemoToolJsonObject;
  readonly executed: boolean;
  readonly completedAt: Date;
}

export class DemoToolOnceGuard {
  readonly #pendingByKey = new Map<string, Promise<DemoToolOnceResult>>();

  public constructor(
    private readonly repository: DemoToolCompletionRepository,
    private readonly clock: LifecycleClock,
  ) {}

  /**
   * Prevents a completed Demo Tool write from running again after restore. The
   * process-local promise also collapses concurrent attempts in this single-node
   * Demo; the PostgreSQL unique marker remains the durable source on restart.
   */
  public execute(
    identity: DemoToolExecutionIdentity,
    operation: () => Promise<DemoToolJsonObject>,
  ): Promise<DemoToolOnceResult> {
    const normalizedIdentity = this.normalizeIdentity(identity);
    const key = JSON.stringify([
      normalizedIdentity.scope.tenantId,
      normalizedIdentity.scope.bizDomain,
      normalizedIdentity.logicalAgentId,
      normalizedIdentity.taskId,
      normalizedIdentity.toolName,
      normalizedIdentity.action,
      normalizedIdentity.resourceType,
      normalizedIdentity.resourceId,
    ]);
    const pending = this.#pendingByKey.get(key);
    if (pending !== undefined) {
      return pending;
    }

    const current = this.executeOnce(normalizedIdentity, operation).finally(() => {
      if (this.#pendingByKey.get(key) === current) {
        this.#pendingByKey.delete(key);
      }
    });
    this.#pendingByKey.set(key, current);
    return current;
  }

  private async executeOnce(
    identity: DemoToolExecutionIdentity,
    operation: () => Promise<DemoToolJsonObject>,
  ): Promise<DemoToolOnceResult> {
    const existing = await this.repository.findToolCompletion(identity);
    if (existing !== null) {
      this.assertMatchingRecord(existing, identity);
      return {
        result: existing.result,
        executed: false,
        completedAt: new Date(existing.completedAt.getTime()),
      };
    }

    const result = await operation();
    const completedAt = this.clock.now();
    const persisted = await this.repository.recordToolCompletion({
      ...identity,
      result,
      completedAt,
    });
    this.assertMatchingRecord(persisted.record, identity);
    return {
      result: persisted.record.result,
      executed: persisted.created,
      completedAt: new Date(persisted.record.completedAt.getTime()),
    };
  }

  private normalizeIdentity(identity: DemoToolExecutionIdentity): DemoToolExecutionIdentity {
    const scope = normalizeTenantBizScope(identity.scope);
    return {
      ...identity,
      scope,
    };
  }

  private assertMatchingRecord(
    record: DemoToolCompletionRecord,
    requested: DemoToolExecutionIdentity,
  ): void {
    if (
      record.scope.tenantId !== requested.scope.tenantId ||
      record.scope.bizDomain !== requested.scope.bizDomain ||
      record.logicalAgentId !== requested.logicalAgentId ||
      record.taskId !== requested.taskId ||
      record.toolName !== requested.toolName ||
      record.action !== requested.action ||
      record.resourceType !== requested.resourceType ||
      record.resourceId !== requested.resourceId
    ) {
      throw new Error("tool completion repository returned a record outside the requested scope");
    }
  }
}
