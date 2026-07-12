import type { L1RuntimeStatus, TenantBizScope } from "@agentnest/contracts";

export interface LogicalAgentRecord {
  readonly logicalAgentId: string;
  readonly tenantId: string;
  readonly bizDomain: string;
  readonly capabilityProfileId: string;
  readonly status: L1RuntimeStatus;
  readonly currentRuntimeInstanceId: string | null;
  readonly lastActiveAt: Date;
}

export interface RuntimeInstanceRecord {
  readonly runtimeInstanceId: string;
  readonly logicalAgentId: string;
  readonly openclawAgentId: string;
  readonly status: L1RuntimeStatus;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly restoredFromRuntimeInstanceId: string | null;
}

export interface EnsureActiveRuntimeInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly capabilityProfileId: string;
  readonly candidateRuntimeInstanceId: string;
  readonly openclawAgentId: string;
  readonly now: Date;
}

export interface EnsureActiveRuntimeResult {
  readonly logicalAgent: LogicalAgentRecord;
  readonly runtime: RuntimeInstanceRecord;
  readonly reused: boolean;
}

export interface TenantRuntimeRepository {
  ensureActiveRuntime(input: EnsureActiveRuntimeInput): Promise<EnsureActiveRuntimeResult>;
}

export interface MarkRuntimeReadyInput {
  readonly scope: TenantBizScope;
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly status: L1RuntimeStatus.ACTIVE | L1RuntimeStatus.IDLE;
  readonly now: Date;
}

export interface TenantRuntimeLifecycleRepository extends TenantRuntimeRepository {
  markRuntimeReady(input: MarkRuntimeReadyInput): Promise<void>;
}
