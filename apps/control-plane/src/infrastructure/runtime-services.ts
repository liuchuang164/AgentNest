import { spawn } from "node:child_process";

import { L1RuntimeStatus, type TenantBizScope } from "@agentnest/contracts";
import type {
  OpenClawAdapter,
  OpenClawCommandRequest,
  OpenClawCommandResult,
  OpenClawCommandRunner,
} from "@agentnest/openclaw-adapter";
import type { TenantRuntimeLifecycleRepository } from "@agentnest/persistence";

import type {
  L1LifecycleRecord,
  LifecycleCheckpointWriter,
  LifecycleClock,
  LifecycleReaper,
  LifecycleRepository,
  LifecycleRuntimeUnloader,
} from "../application/lifecycle-reaper.js";
import { l1RuntimeSessionKey } from "../application/task-orchestrator.js";
import type {
  ControlPlaneAdminActions,
  ControlPlaneHealthProbe,
  ControlPlaneReadRepository,
  ControlPlaneReadyStatus,
} from "../server.js";
import type { CheckpointSessionSummarySource } from "./phase5-checkpoint-writer.js";
import type { L1CheckpointSessionKeyLocator } from "./openclaw-checkpoint-transcript-source.js";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;

export class NodeOpenClawCommandRunner implements OpenClawCommandRunner {
  public async run(request: OpenClawCommandRequest): Promise<OpenClawCommandResult> {
    return await new Promise<OpenClawCommandResult>((resolveResult, rejectResult) => {
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (operation: () => void): void => {
        if (!settled) {
          settled = true;
          operation();
        }
      };
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              child.kill("SIGTERM");
              finish(() => {
                rejectResult(new Error("OpenClaw command timed out"));
              });
            }, request.timeoutMs);
      timer?.unref();

      const capture = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
        const nextBytes = currentBytes + chunk.byteLength;
        if (nextBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGTERM");
          finish(() => {
            rejectResult(new Error("OpenClaw command output exceeded Demo limit"));
          });
          return nextBytes;
        }
        chunks.push(chunk);
        return nextBytes;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = capture(stdout, chunk, stdoutBytes);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = capture(stderr, chunk, stderrBytes);
      });
      child.once("error", (error) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        finish(() => {
          rejectResult(error);
        });
      });
      child.once("close", (exitCode) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        finish(() => {
          const stdoutText = Buffer.concat(stdout).toString("utf8");
          const stderrText = Buffer.concat(stderr).toString("utf8");
          const sanitizedExitCode =
            exitCode !== 0 &&
            /Arrearage|not in good standing|billing|quota|insufficient[ _-]?balance|payment required/iu.test(
              `${stdoutText}\n${stderrText}`,
            )
              ? 78
              : (exitCode ?? 1);
          resolveResult({
            exitCode: sanitizedExitCode,
            stdout: stdoutText,
            stderr: stderrText,
          });
        });
      });
    });
  }
}

export class AdjustableDemoClock implements LifecycleClock {
  #timestamp: number;

  public constructor(initial = new Date()) {
    if (!(initial instanceof Date) || Number.isNaN(initial.getTime())) {
      throw new TypeError("initial Demo clock value must be a valid Date");
    }
    this.#timestamp = initial.getTime();
  }

  public now(): Date {
    return new Date(this.#timestamp);
  }

  public advance(seconds: number): Date {
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604_800) {
      throw new TypeError("Demo clock advance must be between 1 and 604800 seconds");
    }
    this.#timestamp += seconds * 1_000;
    return this.now();
  }
}

type HealthOpenClawAdapter = Pick<OpenClawAdapter, "inspectProfile" | "verifyStableVersion">;

export class CompositeControlPlaneHealthProbe implements ControlPlaneHealthProbe {
  public constructor(
    private readonly reads: Pick<ControlPlaneReadRepository, "checkHealth">,
    private readonly openclaw: HealthOpenClawAdapter,
  ) {}

  public async ready(): Promise<ControlPlaneReadyStatus> {
    const database = await this.databaseStatus();
    const openclaw = await this.openClawStatus();
    return {
      ready: database.postgres && database.migrations && openclaw.openclaw && openclaw.mainProfile,
      postgres: database.postgres,
      migrations: database.migrations,
      openclaw: openclaw.openclaw,
      mainProfile: openclaw.mainProfile,
    };
  }

  private async databaseStatus(): Promise<{
    readonly postgres: boolean;
    readonly migrations: boolean;
  }> {
    try {
      return await this.reads.checkHealth();
    } catch {
      return { postgres: false, migrations: false };
    }
  }

  private async openClawStatus(): Promise<{
    readonly openclaw: boolean;
    readonly mainProfile: boolean;
  }> {
    try {
      await this.openclaw.verifyStableVersion();
      const main = await this.openclaw.inspectProfile("main");
      return { openclaw: true, mainProfile: main?.agentId === "main" };
    } catch {
      return { openclaw: false, mainProfile: false };
    }
  }
}

export class LifecycleAdminConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LifecycleAdminConflictError";
  }
}

export class ScopedLifecycleAdminService implements ControlPlaneAdminActions {
  readonly #pending = new Map<string, Promise<void>>();

  public constructor(
    private readonly lifecycle: LifecycleRepository,
    private readonly checkpoints: LifecycleCheckpointWriter,
    private readonly unloader: LifecycleRuntimeUnloader,
    private readonly runtimes: TenantRuntimeLifecycleRepository,
    private readonly reaper: LifecycleReaper,
    private readonly clock: AdjustableDemoClock,
  ) {}

  public async checkpoint(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<void> {
    await this.withAgentLock(input.logicalAgentId, async () => {
      const record = await this.findRecord(input.scope, input.logicalAgentId);
      if (await this.lifecycle.hasActiveL2(record)) {
        throw new LifecycleAdminConflictError("active L2 prevents L1 checkpoint");
      }
      await this.checkpoints.checkpointL1(record, this.clock.now());
    });
  }

  public async unload(input: {
    readonly scope: TenantBizScope;
    readonly logicalAgentId: string;
  }): Promise<void> {
    await this.withAgentLock(input.logicalAgentId, async () => {
      const record = await this.findRecord(input.scope, input.logicalAgentId);
      if (await this.lifecycle.hasActiveL2(record)) {
        throw new LifecycleAdminConflictError("active L2 prevents L1 unload");
      }
      if (![L1RuntimeStatus.ACTIVE, L1RuntimeStatus.IDLE].includes(record.status)) {
        throw new LifecycleAdminConflictError("L1 runtime is not unloadable");
      }
      const unloadedAt = this.clock.now();
      if (record.status !== L1RuntimeStatus.IDLE) {
        await this.runtimes.markRuntimeReady({
          scope: record.scope,
          logicalAgentId: record.logicalAgentId,
          runtimeInstanceId: record.runtimeInstanceId,
          status: L1RuntimeStatus.IDLE,
          now: unloadedAt,
        });
      }
      const idleRecord: L1LifecycleRecord = {
        ...record,
        status: L1RuntimeStatus.IDLE,
        lastActiveAt: unloadedAt,
      };
      await this.checkpoints.checkpointL1(idleRecord, unloadedAt);
      await this.unloader.unloadL1(idleRecord);
      await this.lifecycle.markL1Unloaded({ ...idleRecord, unloadedAt });
    });
  }

  public async runReaper() {
    return await this.reaper.runOnce();
  }

  public advanceClock(seconds: number): Promise<Date> {
    return Promise.resolve(this.clock.advance(seconds));
  }

  private async findRecord(
    scope: TenantBizScope,
    logicalAgentId: string,
  ): Promise<L1LifecycleRecord> {
    const records = await this.lifecycle.listL1LifecycleRecords(scope);
    const record = records.find((candidate) => candidate.logicalAgentId === logicalAgentId);
    if (record === undefined) {
      throw new LifecycleAdminConflictError("L1 runtime was not found in the requested scope");
    }
    return record;
  }

  private async withAgentLock(
    logicalAgentId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.#pending.get(logicalAgentId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.then(() => gate);
    this.#pending.set(logicalAgentId, current);
    await previous;
    try {
      await operation();
    } finally {
      release();
      if (this.#pending.get(logicalAgentId) === current) {
        this.#pending.delete(logicalAgentId);
      }
    }
  }
}

type SessionReadOpenClawAdapter = Pick<OpenClawAdapter, "exportSessionHistory">;

/** Stable L1 Session locator and compact fallback summary for checkpoint assembly. */
export class OpenClawL1CheckpointSessionSource
  implements L1CheckpointSessionKeyLocator, CheckpointSessionSummarySource
{
  public constructor(private readonly openclaw: SessionReadOpenClawAdapter) {}

  public locateSessionKey(record: L1LifecycleRecord): Promise<string> {
    return Promise.resolve(l1RuntimeSessionKey(record.logicalAgentId, record.runtimeInstanceId));
  }

  public async loadL1SessionSummary(record: L1LifecycleRecord): Promise<string> {
    const sessionKey = await this.locateSessionKey(record);
    const history = await this.openclaw.exportSessionHistory({
      agentId: record.logicalAgentId,
      sessionKey,
      limit: 20,
      maxChars: 8_000,
    });
    const compact = history.transcript.trim().slice(-2_000);
    return compact.length === 0
      ? `No stored L1 model messages for runtime ${record.runtimeInstanceId}.`
      : compact;
  }
}
