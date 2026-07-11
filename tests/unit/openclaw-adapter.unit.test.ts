import { describe, expect, it } from "vitest";

import {
  OpenClawCliAdapter,
  OpenClawProfileValidationError,
  OpenClawVersionError,
  assertExpectedOpenClawVersion,
  parseOpenClawVersion,
  type OpenClawAgentProfileSpec,
  type OpenClawCommandRequest,
  type OpenClawCommandResult,
  type OpenClawCommandRunner,
  type OpenClawObservedStateError,
} from "../../packages/openclaw-adapter/src/index.js";

function success(stdout = ""): OpenClawCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function agentsConfig(...entries: readonly Readonly<Record<string, unknown>>[]): string {
  return JSON.stringify({ list: entries });
}

class ScriptedRunner implements OpenClawCommandRunner {
  public readonly calls: OpenClawCommandRequest[] = [];
  readonly #results: OpenClawCommandResult[];

  public constructor(...results: readonly OpenClawCommandResult[]) {
    this.#results = [...results];
  }

  public run(request: OpenClawCommandRequest): Promise<OpenClawCommandResult> {
    this.calls.push(request);
    const result = this.#results.shift();
    if (result === undefined) {
      return Promise.reject(new Error(`unexpected command: ${request.args.join(" ")}`));
    }
    return Promise.resolve(result);
  }

  public expectComplete(): void {
    expect(this.#results).toHaveLength(0);
  }
}

const LEGAL_AGENT_ID = "tb_0123456789abcdef0123";
const LEGAL_L2_AGENT_ID = "l2_legal_evidence";

function legalProfile(): OpenClawAgentProfileSpec {
  return {
    agentId: LEGAL_AGENT_ID,
    workspace: `/runtime/tenants/${LEGAL_AGENT_ID}/workspace`,
    agentDir: `/runtime/tenants/${LEGAL_AGENT_ID}/agent`,
    model: "qwen/qwen3.5-plus",
    skills: ["legal-evidence-check"],
    tools: {
      allow: ["sessions_spawn", "legal_case_read", "legal_analysis_write"],
      deny: ["robot_device_read"],
    },
    subagents: {
      allowAgents: [LEGAL_L2_AGENT_ID],
      delegationMode: "prefer",
      requireAgentId: true,
    },
  };
}

function legalConfigEntry(): Readonly<Record<string, unknown>> {
  return {
    id: LEGAL_AGENT_ID,
    workspace: `/runtime/tenants/${LEGAL_AGENT_ID}/workspace`,
    agentDir: `/runtime/tenants/${LEGAL_AGENT_ID}/agent`,
    model: "qwen/qwen3.5-plus",
    skills: ["legal-evidence-check"],
    tools: {
      allow: ["legal_analysis_write", "legal_case_read", "sessions_spawn"],
      deny: ["robot_device_read"],
    },
    subagents: {
      allowAgents: [LEGAL_L2_AGENT_ID],
      delegationMode: "prefer",
      requireAgentId: true,
    },
  };
}

describe("OpenClaw stable version parsing", () => {
  it("parses the exact 2026.6.11 release output and commit", () => {
    expect(parseOpenClawVersion("OpenClaw 2026.6.11 (e085fa1)\n")).toEqual({
      version: "2026.6.11",
      commit: "e085fa1",
      raw: "OpenClaw 2026.6.11 (e085fa1)",
    });
  });

  it.each([
    "OpenClaw 2026.7.1-beta.5",
    "2026.6.11-rc.1",
    "OpenClaw 2026.6.11-dev",
    "OpenClaw v2026.6.11",
    "OpenClaw 2026.6.11 extra",
  ])("rejects a prerelease or non-exact output: %s", (output) => {
    expect(() => parseOpenClawVersion(output)).toThrow(OpenClawVersionError);
  });

  it("requires the installed stable version to match the resolved version exactly", () => {
    expect(() => assertExpectedOpenClawVersion("OpenClaw 2026.6.10", "2026.6.11")).toThrow(
      "expected OpenClaw 2026.6.11, observed 2026.6.10",
    );
  });
});

describe("OpenClawCliAdapter profile reconciliation", () => {
  it("inspects the official agents.list shape without inventing tenant metadata", async () => {
    const entry = legalConfigEntry();
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(entry)),
    );
    const adapter = new OpenClawCliAdapter(runner, {
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    const observed = await adapter.inspectProfile(LEGAL_AGENT_ID);

    expect(observed).toMatchObject({
      agentId: LEGAL_AGENT_ID,
      workspace: `/runtime/tenants/${LEGAL_AGENT_ID}/workspace`,
      agentDir: `/runtime/tenants/${LEGAL_AGENT_ID}/agent`,
      skills: ["legal-evidence-check"],
      tools: {
        allow: ["legal_analysis_write", "legal_case_read", "sessions_spawn"],
        deny: ["robot_device_read"],
      },
      subagents: { allowAgents: [LEGAL_L2_AGENT_ID] },
      observedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    runner.expectComplete();
  });

  it("is idempotent when every managed observed field already matches", async () => {
    const entry = legalConfigEntry();
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(entry)),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await expect(adapter.ensureProfile(legalProfile())).resolves.toMatchObject({
      agentId: LEGAL_AGENT_ID,
    });

    expect(runner.calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["--version"],
      ["config", "get"],
    ]);
    expect(runner.calls.some((call) => call.args.includes("set"))).toBe(false);
    runner.expectComplete();
  });

  it("creates a missing profile through agents add, then writes and validates the exact shape", async () => {
    const entry = legalConfigEntry();
    const addOutputEntry = {
      id: LEGAL_AGENT_ID,
      name: LEGAL_AGENT_ID,
      workspace: `/runtime/tenants/${LEGAL_AGENT_ID}/workspace`,
      agentDir: `/runtime/tenants/${LEGAL_AGENT_ID}/agent`,
      model: "qwen/qwen3.5-plus",
    };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig()),
      success(JSON.stringify({ agentId: LEGAL_AGENT_ID })),
      success(agentsConfig(addOutputEntry)),
      success(),
      success(JSON.stringify({ valid: true })),
      success(agentsConfig(entry)),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await adapter.ensureProfile(legalProfile());

    expect(runner.calls[2]?.args).toEqual([
      "agents",
      "add",
      LEGAL_AGENT_ID,
      "--workspace",
      `/runtime/tenants/${LEGAL_AGENT_ID}/workspace`,
      "--agent-dir",
      `/runtime/tenants/${LEGAL_AGENT_ID}/agent`,
      "--model",
      "qwen/qwen3.5-plus",
      "--non-interactive",
      "--json",
    ]);
    const setCall = runner.calls[4];
    expect(setCall?.args.slice(0, 3)).toEqual(["config", "set", "agents.list[0]"]);
    expect(setCall?.args.at(-1)).toBe("--strict-json");
    const serializedProfile = setCall?.args[3];
    if (serializedProfile === undefined) {
      throw new Error("profile config argument was not recorded");
    }
    expect(JSON.parse(serializedProfile)).toEqual(entry);
    expect(runner.calls[5]?.args).toEqual(["config", "validate", "--json"]);
    runner.expectComplete();
  });

  it("removes drift such as foreign skills and additive tools, then re-observes strictly", async () => {
    const drifted = {
      ...legalConfigEntry(),
      skills: ["legal-evidence-check", "robot-dog-health-check"],
      tools: {
        allow: ["legal_case_read", "sessions_spawn"],
        alsoAllow: ["robot_device_read"],
        deny: [],
      },
    };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(drifted)),
      success(),
      success(JSON.stringify({ valid: true })),
      success(agentsConfig(legalConfigEntry())),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await expect(adapter.ensureProfile(legalProfile())).resolves.toMatchObject({
      skills: ["legal-evidence-check"],
    });

    expect(runner.calls[2]?.args.slice(0, 3)).toEqual(["config", "set", "agents.list[0]"]);
    runner.expectComplete();
  });

  it("fails instead of reporting ACTIVE when the post-write observed state still drifts", async () => {
    const drifted = { ...legalConfigEntry(), skills: ["robot-dog-health-check"] };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(drifted)),
      success(),
      success(JSON.stringify({ valid: true })),
      success(agentsConfig(drifted)),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await expect(adapter.ensureProfile(legalProfile())).rejects.toMatchObject({
      name: "OpenClawObservedStateError",
      differences: ["skills"],
    } satisfies Partial<OpenClawObservedStateError>);
    runner.expectComplete();
  });

  it("deactivates by removing only the config entry and preserves other profiles", async () => {
    const other = {
      id: "tb_other",
      workspace: "/runtime/other/workspace",
      agentDir: "/runtime/other/agent",
    };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(legalConfigEntry(), other)),
      success(),
      success(JSON.stringify({ valid: true })),
      success(agentsConfig(other)),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await adapter.deactivateProfile(LEGAL_AGENT_ID);

    const setCall = runner.calls[2];
    expect(setCall?.args.slice(0, 3)).toEqual(["config", "set", "agents.list"]);
    expect(setCall?.args.slice(-2)).toEqual(["--strict-json", "--replace"]);
    const serializedList = setCall?.args[3];
    if (serializedList === undefined) {
      throw new Error("agents.list argument was not recorded");
    }
    expect(JSON.parse(serializedList)).toEqual([other]);
    runner.expectComplete();
  });
});

describe("OpenClawCliAdapter gateway dispatch", () => {
  it("dispatches through gateway RPC with typed exact agent/session/idempotency fields", async () => {
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(
        JSON.stringify({
          result: { runId: "run_01", status: "ok", sessionKey: `agent:${LEGAL_AGENT_ID}:task_01` },
        }),
      ),
    );
    const adapter = new OpenClawCliAdapter(runner);

    const result = await adapter.dispatchToAgent({
      agentId: LEGAL_AGENT_ID,
      sessionKey: `agent:${LEGAL_AGENT_ID}:task_01`,
      message: "run the legal task",
      idempotencyKey: "dispatch-task-01",
      timeoutMs: 120_000,
      agentTimeoutSeconds: 90,
    });

    expect(result).toMatchObject({ runId: "run_01", status: "ok" });
    expect(runner.calls[1]?.args.slice(0, 4)).toEqual(["gateway", "call", "agent", "--params"]);
    const serializedParams = runner.calls[1]?.args[4];
    if (serializedParams === undefined) {
      throw new Error("gateway params argument was not recorded");
    }
    expect(JSON.parse(serializedParams)).toEqual({
      message: "run the legal task",
      agentId: LEGAL_AGENT_ID,
      sessionKey: `agent:${LEGAL_AGENT_ID}:task_01`,
      idempotencyKey: "dispatch-task-01",
      timeout: 90,
    });
    expect(runner.calls[1]?.args.slice(-4)).toEqual([
      "--expect-final",
      "--json",
      "--timeout",
      "120000",
    ]);
    expect(runner.calls[1]?.timeoutMs).toBe(120_000);
    runner.expectComplete();
  });

  it("rejects a session key belonging to another agent before executing a command", async () => {
    const runner = new ScriptedRunner();
    const adapter = new OpenClawCliAdapter(runner);

    await expect(
      adapter.dispatchToAgent({
        agentId: LEGAL_AGENT_ID,
        sessionKey: "agent:tb_other:task_01",
        message: "run",
        idempotencyKey: "dispatch-task-01",
      }),
    ).rejects.toBeInstanceOf(OpenClawProfileValidationError);
    expect(runner.calls).toHaveLength(0);
  });

  it("uses a fixed isolated native sessions_spawn request only for an allowed child profile", async () => {
    const parent = legalConfigEntry();
    const child = {
      id: LEGAL_L2_AGENT_ID,
      workspace: "/runtime/l2/legal/workspace",
      agentDir: "/runtime/l2/legal/agent",
      skills: ["legal-evidence-check"],
      tools: { allow: ["legal_case_read"], deny: [] },
      subagents: { allowAgents: [] },
    };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(parent, child)),
      success(JSON.stringify({ runId: "parent_run", status: "ok" })),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await adapter.spawnTaskAgent({
      l1AgentId: LEGAL_AGENT_ID,
      l1SessionKey: `agent:${LEGAL_AGENT_ID}:task_01`,
      childAgentId: LEGAL_L2_AGENT_ID,
      taskId: "task_01",
      taskName: "legal_task_01",
      task: "check case_001 evidence",
      idempotencyKey: "spawn-task-01",
    });

    const serializedParams = runner.calls[2]?.args[4];
    if (serializedParams === undefined) {
      throw new Error("spawn gateway params argument was not recorded");
    }
    const params = JSON.parse(serializedParams) as Record<string, unknown>;
    expect(params["agentId"]).toBe(LEGAL_AGENT_ID);
    expect(params["message"]).toContain("Invoke sessions_spawn exactly once");
    expect(params["message"]).toContain(`"agentId":"${LEGAL_L2_AGENT_ID}"`);
    expect(params["message"]).toContain('"context":"isolated"');
    expect(params["message"]).toContain('"mode":"run"');
    expect(params["message"]).toContain("[AgentNest task_id=task_01]");
    runner.expectComplete();
  });

  it("rejects a child that is not in the L1 OpenClaw allowAgents list", async () => {
    const parent = {
      ...legalConfigEntry(),
      subagents: { allowAgents: ["l2_other"], requireAgentId: true },
    };
    const child = { id: LEGAL_L2_AGENT_ID };
    const runner = new ScriptedRunner(
      success("OpenClaw 2026.6.11 (e085fa1)"),
      success(agentsConfig(parent, child)),
    );
    const adapter = new OpenClawCliAdapter(runner);

    await expect(
      adapter.spawnTaskAgent({
        l1AgentId: LEGAL_AGENT_ID,
        l1SessionKey: `agent:${LEGAL_AGENT_ID}:task_02`,
        childAgentId: LEGAL_L2_AGENT_ID,
        taskId: "task_02",
        taskName: "legal_task_02",
        task: "check evidence",
        idempotencyKey: "spawn-task-02",
      }),
    ).rejects.toThrow(`cannot spawn ${LEGAL_L2_AGENT_ID}`);
    expect(runner.calls).toHaveLength(2);
    runner.expectComplete();
  });
});
