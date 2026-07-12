import { L1RuntimeStatus, L2TaskStatus } from "@agentnest/contracts";
import { describe, expect, it } from "vitest";

import type {
  L1LifecycleRecord,
  L2LifecycleRecord,
} from "../../apps/control-plane/src/application/lifecycle-reaper.js";
import {
  OpenClawCheckpointTranscriptSource,
  OpenClawCheckpointTranscriptSourceError,
  type L1CheckpointSessionKeyLocator,
} from "../../apps/control-plane/src/infrastructure/openclaw-checkpoint-transcript-source.js";
import type {
  ExportSessionHistoryInput,
  OpenClawSessionHistoryExport,
} from "../../packages/openclaw-adapter/src/index.js";

const LOGICAL_AGENT_ID = "tb_0123456789abcdef0123";
const L1_SESSION_KEY = `agent:${LOGICAL_AGENT_ID}:checkpoint_parent_01`;
const L2_SESSION_KEY = "agent:l2_legal_evidence:subagent_task_01";

function l1Record(): L1LifecycleRecord {
  return {
    scope: { tenantId: "tenant_A", bizDomain: "LEGAL" },
    logicalAgentId: LOGICAL_AGENT_ID,
    runtimeInstanceId: "ari_01",
    status: L1RuntimeStatus.IDLE,
    lastActiveAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function l2Record(): L2LifecycleRecord {
  return {
    ...l1Record(),
    sessionId: L2_SESSION_KEY,
    taskId: "task_01",
    status: L2TaskStatus.COMPLETED,
  };
}

class RecordingL1SessionKeyLocator implements L1CheckpointSessionKeyLocator {
  public readonly records: L1LifecycleRecord[] = [];

  public constructor(private readonly sessionKey = L1_SESSION_KEY) {}

  public locateSessionKey(record: L1LifecycleRecord): Promise<string> {
    this.records.push(record);
    return Promise.resolve(this.sessionKey);
  }
}

class RecordingHistoryAdapter {
  public readonly inputs: ExportSessionHistoryInput[] = [];

  public exportSessionHistory(
    input: ExportSessionHistoryInput,
  ): Promise<OpenClawSessionHistoryExport> {
    this.inputs.push(input);
    return Promise.resolve({
      key: input.sessionKey,
      sessionId: `stored_${this.inputs.length.toString()}`,
      messageCount: 1,
      transcript: `${JSON.stringify({ sessionKey: input.sessionKey })}\n`,
      raw: {},
    });
  }
}

describe("OpenClawCheckpointTranscriptSource", () => {
  it("uses the injected L1 Session locator and exports the exact logical-agent history", async () => {
    const record = l1Record();
    const locator = new RecordingL1SessionKeyLocator();
    const openclaw = new RecordingHistoryAdapter();
    const source = new OpenClawCheckpointTranscriptSource(locator, openclaw);

    const transcript = await source.readL1Transcript(record);

    expect(locator.records).toEqual([record]);
    expect(openclaw.inputs).toEqual([{ agentId: LOGICAL_AGENT_ID, sessionKey: L1_SESSION_KEY }]);
    expect(transcript).toContain(L1_SESSION_KEY);
  });

  it("derives the L2 agent from its persisted canonical Session key", async () => {
    const openclaw = new RecordingHistoryAdapter();
    const source = new OpenClawCheckpointTranscriptSource(
      new RecordingL1SessionKeyLocator(),
      openclaw,
    );

    const transcript = await source.readL2Transcript(l2Record());

    expect(openclaw.inputs).toEqual([{ agentId: "l2_legal_evidence", sessionKey: L2_SESSION_KEY }]);
    expect(transcript).toContain(L2_SESSION_KEY);
  });

  it("rejects a locator result for another L1 and a non-canonical L2 Session", async () => {
    const openclaw = new RecordingHistoryAdapter();
    const wrongL1 = new OpenClawCheckpointTranscriptSource(
      new RecordingL1SessionKeyLocator("agent:tb_other:checkpoint_parent_01"),
      openclaw,
    );
    await expect(wrongL1.readL1Transcript(l1Record())).rejects.toBeInstanceOf(
      OpenClawCheckpointTranscriptSourceError,
    );

    const invalidL2 = { ...l2Record(), sessionId: "session_without_agent_scope" };
    await expect(wrongL1.readL2Transcript(invalidL2)).rejects.toBeInstanceOf(
      OpenClawCheckpointTranscriptSourceError,
    );
    expect(openclaw.inputs).toEqual([]);
  });
});
