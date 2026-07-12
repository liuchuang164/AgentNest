import type { TenantBizScope } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import type { ActivateRestoredRuntimeInput } from "../../apps/control-plane/src/application/lifecycle-restore.js";
import {
  OpenClawLifecycleRuntimeActivationError,
  OpenClawLifecycleRuntimeActivator,
  type CurrentPolicyOpenClawProfileSource,
} from "../../apps/control-plane/src/infrastructure/openclaw-lifecycle-runtime-activator.js";
import type {
  CreateSessionInput,
  OpenClawAgentProfileSpec,
  OpenClawSessionCreateResult,
  ObservedOpenClawProfile,
} from "../../packages/openclaw-adapter/src/index.js";

const SCOPE = {
  tenantId: "tenant_A",
  bizDomain: "LEGAL",
} as const satisfies TenantBizScope;
const LOGICAL_AGENT_ID = "tb_0123456789abcdef0123";
const PARENT_SESSION_KEY = `agent:${LOGICAL_AGENT_ID}:restore_parent_01`;

function activationInput(): ActivateRestoredRuntimeInput {
  return {
    scope: SCOPE,
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "ari_restored_01",
    restoredFromRuntimeInstanceId: "ari_previous_01",
    capabilityProfileId: "cap_tenant_a_legal_v2",
    parentSessionId: PARENT_SESSION_KEY,
    activatedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function profile(agentId = LOGICAL_AGENT_ID): OpenClawAgentProfileSpec {
  return {
    agentId,
    workspace: `/runtime/tenants/${agentId}/workspace`,
    agentDir: `/runtime/tenants/${agentId}/agent`,
    model: "qwen/qwen3.5-plus",
    skills: ["legal-evidence-check"],
    tools: {
      allow: ["sessions_spawn", "legal_case_read"],
      deny: ["robot_device_read"],
    },
    subagents: {
      allowAgents: ["l2_legal_evidence"],
      requireAgentId: true,
    },
  };
}

function observedProfile(spec: OpenClawAgentProfileSpec): ObservedOpenClawProfile {
  return {
    agentId: spec.agentId,
    name: null,
    default: null,
    workspace: spec.workspace,
    agentDir: spec.agentDir,
    model: spec.model ?? null,
    skills: spec.skills,
    tools: {
      profile: spec.tools.profile ?? null,
      allow: spec.tools.allow,
      deny: spec.tools.deny,
    },
    subagents: {
      allowAgents: spec.subagents.allowAgents,
      delegationMode: spec.subagents.delegationMode ?? null,
      model: spec.subagents.model ?? null,
      thinking: spec.subagents.thinking ?? null,
      requireAgentId: spec.subagents.requireAgentId ?? null,
    },
    sandbox: null,
    observedAt: new Date("2030-01-01T00:00:00.000Z"),
    rawConfig: {},
  };
}

class RecordingCurrentPolicyProfileSource implements CurrentPolicyOpenClawProfileSource {
  public readonly inputs: ActivateRestoredRuntimeInput[] = [];

  public constructor(private readonly resolved: OpenClawAgentProfileSpec) {}

  public resolveProfile(input: ActivateRestoredRuntimeInput): Promise<OpenClawAgentProfileSpec> {
    this.inputs.push(input);
    return Promise.resolve(this.resolved);
  }
}

class RecordingActivationOpenClawAdapter {
  public readonly events: string[] = [];
  public readonly ensured: OpenClawAgentProfileSpec[] = [];
  public readonly sessions: CreateSessionInput[] = [];

  public constructor(private readonly createdKey = PARENT_SESSION_KEY) {}

  public ensureProfile(spec: OpenClawAgentProfileSpec): Promise<ObservedOpenClawProfile> {
    this.events.push("ensureProfile");
    this.ensured.push(spec);
    return Promise.resolve(observedProfile(spec));
  }

  public createSession(input: CreateSessionInput): Promise<OpenClawSessionCreateResult> {
    this.events.push("createSession");
    this.sessions.push(input);
    return Promise.resolve({
      key: this.createdKey,
      sessionId: "openclaw_session_01",
      raw: {},
    });
  }
}

describe("OpenClawLifecycleRuntimeActivator", () => {
  it("ensures the current-policy L1 Profile before binding the requested parent Session", async () => {
    const input = activationInput();
    const profiles = new RecordingCurrentPolicyProfileSource(profile());
    const openclaw = new RecordingActivationOpenClawAdapter();
    const activator = new OpenClawLifecycleRuntimeActivator(profiles, openclaw);

    const activated = await activator.activate(input);

    expect(profiles.inputs).toEqual([input]);
    expect(openclaw.events).toEqual(["ensureProfile", "createSession"]);
    expect(openclaw.ensured).toEqual([profile()]);
    expect(openclaw.sessions).toEqual([
      {
        agentId: LOGICAL_AGENT_ID,
        sessionKey: PARENT_SESSION_KEY,
        label: "restore-ari_restored_01",
      },
    ]);
    expect(activated).toEqual({
      openclawAgentId: LOGICAL_AGENT_ID,
      parentSessionId: PARENT_SESSION_KEY,
    });
  });

  it("rejects a current-policy Profile for another logical agent before activation", async () => {
    const profiles = new RecordingCurrentPolicyProfileSource(profile("tb_other"));
    const openclaw = new RecordingActivationOpenClawAdapter();
    const activator = new OpenClawLifecycleRuntimeActivator(profiles, openclaw);

    await expect(activator.activate(activationInput())).rejects.toBeInstanceOf(
      OpenClawLifecycleRuntimeActivationError,
    );
    expect(openclaw.events).toEqual([]);
  });

  it("rejects a parent Session acknowledgement outside the requested identity", async () => {
    const profiles = new RecordingCurrentPolicyProfileSource(profile());
    const openclaw = new RecordingActivationOpenClawAdapter(
      `agent:${LOGICAL_AGENT_ID}:different_parent`,
    );
    const activator = new OpenClawLifecycleRuntimeActivator(profiles, openclaw);

    await expect(activator.activate(activationInput())).rejects.toThrow(
      "different parent Session than requested",
    );
    expect(openclaw.events).toEqual(["ensureProfile", "createSession"]);
  });
});
