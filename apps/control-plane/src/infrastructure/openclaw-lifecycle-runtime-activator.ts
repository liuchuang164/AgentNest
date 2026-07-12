import type { OpenClawAdapter, OpenClawAgentProfileSpec } from "@agentnest/openclaw-adapter";

import type { ActivateRestoredRuntimeInput } from "../application/lifecycle-restore.js";
import type {
  RestoredRuntimeActivationResult,
  RestoredRuntimeActivator,
} from "./phase5-adapters.js";

type LifecycleActivationOpenClawAdapter = Pick<OpenClawAdapter, "createSession" | "ensureProfile">;

/** Resolves an L1 Profile from the policy that is current at restore time. */
export interface CurrentPolicyOpenClawProfileSource {
  resolveProfile(input: ActivateRestoredRuntimeInput): Promise<OpenClawAgentProfileSpec>;
}

export class OpenClawLifecycleRuntimeActivationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenClawLifecycleRuntimeActivationError";
  }
}

/**
 * Recreates the OpenClaw side of an unloaded L1 runtime. The PostgreSQL adapter
 * marks the runtime ready only after this activator has ensured the current
 * Profile and bound the newly allocated parent Session.
 */
export class OpenClawLifecycleRuntimeActivator implements RestoredRuntimeActivator {
  public constructor(
    private readonly profiles: CurrentPolicyOpenClawProfileSource,
    private readonly openclaw: LifecycleActivationOpenClawAdapter,
  ) {}

  public async activate(
    input: ActivateRestoredRuntimeInput,
  ): Promise<RestoredRuntimeActivationResult> {
    const profile = await this.profiles.resolveProfile(input);
    if (profile.agentId !== input.logicalAgentId) {
      throw new OpenClawLifecycleRuntimeActivationError(
        "current-policy Profile does not match the restored logical agent",
      );
    }

    const observed = await this.openclaw.ensureProfile(profile);
    if (observed.agentId !== input.logicalAgentId) {
      throw new OpenClawLifecycleRuntimeActivationError(
        "OpenClaw activated a Profile outside the restored logical agent",
      );
    }

    const parentSession = await this.openclaw.createSession({
      agentId: input.logicalAgentId,
      sessionKey: input.parentSessionId,
      label: `restore-${input.runtimeInstanceId}`,
    });
    if (parentSession.key !== input.parentSessionId) {
      throw new OpenClawLifecycleRuntimeActivationError(
        "OpenClaw created a different parent Session than requested",
      );
    }

    return {
      openclawAgentId: observed.agentId,
      parentSessionId: parentSession.key,
    };
  }
}
