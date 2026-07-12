import type { OpenClawAdapter } from "@agentnest/openclaw-adapter";

import type {
  L1LifecycleRecord,
  L2LifecycleRecord,
  LifecycleRuntimeUnloader,
} from "../application/lifecycle-reaper.js";

type LifecycleOpenClawAdapter = Pick<OpenClawAdapter, "archiveSession" | "deactivateProfile">;

/**
 * Applies the runtime side of lifecycle unload after the checkpoint writer has
 * completed. PostgreSQL state is advanced to UNLOADED by the Reaper only after
 * these OpenClaw operations resolve.
 */
export class OpenClawLifecycleRuntimeUnloader implements LifecycleRuntimeUnloader {
  public constructor(private readonly openclaw: LifecycleOpenClawAdapter) {}

  public async unloadL2(record: L2LifecycleRecord): Promise<void> {
    await this.openclaw.archiveSession({ sessionKey: record.sessionId });
  }

  public async unloadL1(record: L1LifecycleRecord): Promise<void> {
    await this.openclaw.deactivateProfile(record.logicalAgentId);
  }
}
