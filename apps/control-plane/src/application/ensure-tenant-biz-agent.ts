import {
  createRuntimeInstanceId,
  deriveLogicalAgentId,
  deriveTenantRuntimePaths,
  type TenantCapabilityCatalog,
  type TenantRuntimePaths,
} from "@agentnest/capability";
import type { CapabilityProfile, TenantBizScope } from "@agentnest/contracts";
import type { EnsureActiveRuntimeResult, TenantRuntimeRepository } from "@agentnest/persistence";

import { RuntimeCache } from "../infrastructure/runtime-cache.js";

export interface ActiveTenantBizAgent extends EnsureActiveRuntimeResult {
  readonly capabilityProfile: CapabilityProfile;
  readonly paths: TenantRuntimePaths;
}

export interface EnsureTenantBizAgentOptions {
  readonly runtimeRoot: string;
  readonly now?: () => Date;
  readonly createRuntimeId?: () => string;
}

export class EnsureTenantBizAgent {
  readonly #pendingByLogicalAgent = new Map<string, Promise<void>>();
  readonly #cache: RuntimeCache;
  readonly #now: () => Date;
  readonly #createRuntimeId: () => string;

  public constructor(
    private readonly catalog: TenantCapabilityCatalog,
    private readonly repository: TenantRuntimeRepository,
    private readonly options: EnsureTenantBizAgentOptions,
    cache = new RuntimeCache(),
  ) {
    this.#cache = cache;
    this.#now = options.now ?? (() => new Date());
    this.#createRuntimeId = options.createRuntimeId ?? createRuntimeInstanceId;
  }

  public async execute(scope: TenantBizScope): Promise<ActiveTenantBizAgent> {
    const profile = await this.catalog.resolveProfile(scope);
    const canonicalScope = {
      tenantId: profile.tenant_id,
      bizDomain: profile.biz_domain,
    };
    const logicalAgentId = deriveLogicalAgentId(canonicalScope);
    return this.withLogicalAgentLock(logicalAgentId, async () => {
      const persisted = await this.repository.ensureActiveRuntime({
        scope: canonicalScope,
        logicalAgentId,
        capabilityProfileId: profile.profile_id,
        candidateRuntimeInstanceId: this.#createRuntimeId(),
        openclawAgentId: logicalAgentId,
        now: this.#now(),
      });
      this.assertRepositoryScope(persisted, canonicalScope, logicalAgentId);
      this.#cache.set(persisted.runtime);
      return {
        ...persisted,
        capabilityProfile: profile,
        paths: deriveTenantRuntimePaths(this.options.runtimeRoot, logicalAgentId),
      };
    });
  }

  public cachedRuntime(logicalAgentId: string) {
    return this.#cache.get(logicalAgentId);
  }

  private assertRepositoryScope(
    result: EnsureActiveRuntimeResult,
    scope: TenantBizScope,
    logicalAgentId: string,
  ): void {
    if (
      result.logicalAgent.tenantId !== scope.tenantId ||
      result.logicalAgent.bizDomain !== scope.bizDomain ||
      result.logicalAgent.logicalAgentId !== logicalAgentId ||
      result.runtime.logicalAgentId !== logicalAgentId
    ) {
      throw new Error(
        "runtime repository returned a record outside the requested tenant/biz scope",
      );
    }
  }

  private async withLogicalAgentLock<TResult>(
    logicalAgentId: string,
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.#pendingByLogicalAgent.get(logicalAgentId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.then(() => gate);
    this.#pendingByLogicalAgent.set(logicalAgentId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#pendingByLogicalAgent.get(logicalAgentId) === current) {
        this.#pendingByLogicalAgent.delete(logicalAgentId);
      }
    }
  }
}
