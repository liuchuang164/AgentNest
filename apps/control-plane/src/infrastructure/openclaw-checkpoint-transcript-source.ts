import type { OpenClawAdapter } from "@agentnest/openclaw-adapter";

import type { L1LifecycleRecord, L2LifecycleRecord } from "../application/lifecycle-reaper.js";
import type { CheckpointTranscriptSource } from "./phase5-checkpoint-writer.js";

type TranscriptOpenClawAdapter = Pick<OpenClawAdapter, "exportSessionHistory">;

export interface L1CheckpointSessionKeyLocator {
  locateSessionKey(record: L1LifecycleRecord): Promise<string>;
}

export class OpenClawCheckpointTranscriptSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OpenClawCheckpointTranscriptSourceError";
  }
}

function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([a-z0-9][a-z0-9_-]{0,63}):(.+)$/u.exec(sessionKey);
  if (match?.[1] === undefined || match[2]?.trim().length === 0) {
    throw new OpenClawCheckpointTranscriptSourceError(
      "checkpoint Session key must be a canonical OpenClaw agent Session key",
    );
  }
  return match[1];
}

/** Captures bounded Demo transcripts through the read-only stable Gateway RPC. */
export class OpenClawCheckpointTranscriptSource implements CheckpointTranscriptSource {
  public constructor(
    private readonly l1Sessions: L1CheckpointSessionKeyLocator,
    private readonly openclaw: TranscriptOpenClawAdapter,
  ) {}

  public async readL1Transcript(record: L1LifecycleRecord): Promise<string> {
    const sessionKey = await this.l1Sessions.locateSessionKey(record);
    const sessionAgentId = agentIdFromSessionKey(sessionKey);
    if (sessionAgentId !== record.logicalAgentId) {
      throw new OpenClawCheckpointTranscriptSourceError(
        "L1 checkpoint Session belongs to a different logical agent",
      );
    }
    const exported = await this.openclaw.exportSessionHistory({
      agentId: record.logicalAgentId,
      sessionKey,
    });
    return exported.transcript;
  }

  public async readL2Transcript(record: L2LifecycleRecord): Promise<string> {
    const agentId = agentIdFromSessionKey(record.sessionId);
    const exported = await this.openclaw.exportSessionHistory({
      agentId,
      sessionKey: record.sessionId,
    });
    return exported.transcript;
  }
}
