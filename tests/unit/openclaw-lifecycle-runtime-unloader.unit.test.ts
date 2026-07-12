import { L1RuntimeStatus, L2TaskStatus } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import type {
  L1LifecycleRecord,
  L2LifecycleRecord,
} from "../../apps/control-plane/src/application/lifecycle-reaper.js";
import { OpenClawLifecycleRuntimeUnloader } from "../../apps/control-plane/src/infrastructure/openclaw-lifecycle-runtime-unloader.js";
import type { ArchiveSessionInput } from "../../packages/openclaw-adapter/src/index.js";

const LOGICAL_AGENT_ID = "tb_0123456789abcdef0123";
const L2_AGENT_ID = "l2_legal_evidence";
const SESSION_KEY = `agent:${L2_AGENT_ID}:subagent_task_01`;
const LAST_ACTIVE_AT = new Date("2030-01-01T00:00:00.000Z");

function l1Record(): L1LifecycleRecord {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "ari_01",
    status: L1RuntimeStatus.IDLE,
    lastActiveAt: LAST_ACTIVE_AT,
  };
}

function l2Record(): L2LifecycleRecord {
  return {
    ...l1Record(),
    sessionId: SESSION_KEY,
    taskId: "task_01",
    status: L2TaskStatus.WAITING_INPUT,
  };
}

class RecordingOpenClawLifecycleAdapter {
  public readonly archived: ArchiveSessionInput[] = [];
  public readonly deactivated: string[] = [];

  public archiveSession(input: ArchiveSessionInput): Promise<void> {
    this.archived.push(input);
    return Promise.resolve();
  }

  public deactivateProfile(agentId: string): Promise<void> {
    this.deactivated.push(agentId);
    return Promise.resolve();
  }
}

describe("OpenClawLifecycleRuntimeUnloader", () => {
  it("maps an L2 runtime unload to the exact OpenClaw session archive", async () => {
    const openclaw = new RecordingOpenClawLifecycleAdapter();
    const unloader = new OpenClawLifecycleRuntimeUnloader(openclaw);

    await unloader.unloadL2(l2Record());

    expect(openclaw.archived).toEqual([{ sessionKey: SESSION_KEY }]);
    expect(openclaw.deactivated).toEqual([]);
  });

  it("maps an L1 runtime unload to stable logical profile deactivation", async () => {
    const openclaw = new RecordingOpenClawLifecycleAdapter();
    const unloader = new OpenClawLifecycleRuntimeUnloader(openclaw);

    await unloader.unloadL1(l1Record());

    expect(openclaw.deactivated).toEqual([LOGICAL_AGENT_ID]);
    expect(openclaw.archived).toEqual([]);
  });

  it("propagates OpenClaw failures so the Reaper cannot mark state unloaded", async () => {
    const failure = new Error("injected OpenClaw failure");
    const unloader = new OpenClawLifecycleRuntimeUnloader({
      archiveSession: () => Promise.reject(failure),
      deactivateProfile: () => Promise.reject(failure),
    });

    await expect(unloader.unloadL2(l2Record())).rejects.toBe(failure);
    await expect(unloader.unloadL1(l1Record())).rejects.toBe(failure);
  });
});
