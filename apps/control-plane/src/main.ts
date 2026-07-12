import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { demoCapabilityProfiles } from "@agentnest/capability";
import { L2TaskStatus, type TenantBizScope } from "@agentnest/contracts";
import {
  OPENCLAW_2026_6_11,
  OpenClawCliAdapter,
  type OpenClawAdapter,
} from "@agentnest/openclaw-adapter";
import {
  LocalCheckpointVolume,
  NodePostgresPool,
  PostgresDemoReadRepository,
  PostgresExecutionContextRepository,
  PostgresLifecycleRepository,
  PostgresPhase5PersistenceRepository,
  PostgresTenantCapabilityCatalog,
  PostgresTenantRuntimeRepository,
} from "@agentnest/persistence";

import { CreateTaskExecutionContext } from "./application/create-task-execution-context.js";
import { EnsureTenantBizAgent } from "./application/ensure-tenant-biz-agent.js";
import {
  LifecycleReaper,
  lifecycleTtlFromEnvironment,
  type L1LifecycleRecord,
  type L2LifecycleRecord,
  type LifecycleRuntimeUnloader,
} from "./application/lifecycle-reaper.js";
import {
  OpenClawTaskProfileFactory,
  TaskOrchestrator,
  l1RuntimeSessionKey,
  type TaskDispatchMode,
} from "./application/task-orchestrator.js";
import { OpenClawCheckpointTranscriptSource } from "./infrastructure/openclaw-checkpoint-transcript-source.js";
import {
  CatalogCheckpointCapabilitySummarySource,
  Phase5LifecycleCheckpointWriter,
  PostgresCheckpointCaptureSource,
  type CheckpointTranscriptSource,
} from "./infrastructure/phase5-checkpoint-writer.js";
import {
  AdjustableDemoClock,
  CompositeControlPlaneHealthProbe,
  NodeOpenClawCommandRunner,
  OpenClawL1CheckpointSessionSource,
  ScopedLifecycleAdminService,
} from "./infrastructure/runtime-services.js";
import { buildControlPlaneServer } from "./server.js";

export const DEFAULT_CONTROL_PLANE_HOST = "127.0.0.1";
export const DEFAULT_CONTROL_PLANE_PORT = 18_080;

export interface ControlPlaneListenAddress {
  readonly host: string;
  readonly port: number;
}

function firstEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): string {
  const value = firstEnvironment(environment, names);
  if (value === undefined) {
    throw new TypeError(`${names.join(" or ")} is required`);
  }
  return value;
}

function privateHost(environment: Readonly<Record<string, string | undefined>>): string {
  const host =
    firstEnvironment(environment, ["CONTROL_PLANE_HOST", "AGENTNEST_BIND_HOST"]) ??
    DEFAULT_CONTROL_PLANE_HOST;
  if (host !== "127.0.0.1") {
    throw new TypeError("Control Plane must bind 127.0.0.1 for the Demo");
  }
  return host;
}

function port(environment: Readonly<Record<string, string | undefined>>): number {
  const raw = firstEnvironment(environment, ["CONTROL_PLANE_PORT", "PORT"]);
  const value = raw === undefined ? DEFAULT_CONTROL_PLANE_PORT : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("CONTROL_PLANE_PORT must be a TCP port");
  }
  return value;
}

export function resolveControlPlaneListenAddress(
  environment: Readonly<Record<string, string | undefined>>,
): ControlPlaneListenAddress {
  return { host: privateHost(environment), port: port(environment) };
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function dispatchMode(value: string | undefined): TaskDispatchMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0 || normalized === "l0") {
    return "l0";
  }
  if (normalized === "l1") {
    return "l1";
  }
  throw new TypeError("OPENCLAW_TASK_DISPATCH_MODE must be l0 or l1");
}

function childSessionFromResult(result: Readonly<Record<string, unknown>> | null): string | null {
  const value = result?.["openclaw_child_session_key"];
  return typeof value === "string" && /^agent:l2_[a-f0-9]{20}:subagent:.+$/u.test(value)
    ? value
    : null;
}

class ResolvedCheckpointTranscriptSource implements CheckpointTranscriptSource {
  public constructor(
    private readonly l1: OpenClawCheckpointTranscriptSource,
    private readonly persistence: PostgresPhase5PersistenceRepository,
    private readonly openclaw: Pick<OpenClawAdapter, "exportSessionHistory">,
  ) {}

  public readL1Transcript(record: L1LifecycleRecord): Promise<string> {
    return this.l1.readL1Transcript(record);
  }

  public async readL2Transcript(record: L2LifecycleRecord): Promise<string> {
    const task = await this.persistence.findTaskState({
      scope: record.scope,
      taskId: record.taskId,
    });
    const childSessionKey = childSessionFromResult(task?.result ?? null);
    if (childSessionKey === null && task?.status === L2TaskStatus.FAILED) {
      return `${JSON.stringify({
        role: "system",
        event: "OPENCLAW_CHILD_NOT_CREATED",
        task_id: record.taskId,
        status: task.status,
      })}\n`;
    }
    const sessionKey = childSessionKey ?? record.sessionId;
    const match = /^agent:([a-z0-9][a-z0-9_-]{0,63}):.+$/u.exec(sessionKey);
    const agentId = match?.[1];
    if (agentId === undefined) {
      throw new TypeError("L2 checkpoint Session key is invalid");
    }
    const exported = await this.openclaw.exportSessionHistory({ agentId, sessionKey });
    return exported.transcript;
  }
}

class ResolvedLifecycleRuntimeUnloader implements LifecycleRuntimeUnloader {
  public constructor(
    private readonly persistence: PostgresPhase5PersistenceRepository,
    private readonly openclaw: Pick<OpenClawAdapter, "archiveSession" | "deactivateProfile">,
  ) {}

  public async unloadL2(record: L2LifecycleRecord): Promise<void> {
    const task = await this.persistence.findTaskState({
      scope: record.scope,
      taskId: record.taskId,
    });
    await this.openclaw.archiveSession({
      sessionKey: childSessionFromResult(task?.result ?? null) ?? record.sessionId,
    });
  }

  public async unloadL1(record: L1LifecycleRecord): Promise<void> {
    await this.openclaw.archiveSession({
      sessionKey: l1RuntimeSessionKey(record.logicalAgentId, record.runtimeInstanceId),
    });
    await this.openclaw.deactivateProfile(record.logicalAgentId);
  }
}

function demoScopes(): readonly TenantBizScope[] {
  return demoCapabilityProfiles.map((profile) => ({
    tenantId: profile.tenant_id,
    bizDomain: profile.biz_domain,
  }));
}

export async function startControlPlane(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const address = resolveControlPlaneListenAddress(environment);
  const runtimeRoot = requiredEnvironment(environment, ["AGENTNEST_RUNTIME_ROOT"]);
  const checkpointRoot = requiredEnvironment(environment, ["AGENTNEST_CHECKPOINT_ROOT"]);
  const pool = new NodePostgresPool({
    connectionString: requiredEnvironment(environment, ["DATABASE_URL"]),
    applicationName: "agentnest-control-plane",
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  const clock = new AdjustableDemoClock();
  const catalog = new PostgresTenantCapabilityCatalog(pool);
  const runtimes = new PostgresTenantRuntimeRepository(pool);
  const phase5 = new PostgresPhase5PersistenceRepository(pool);
  const contexts = new PostgresExecutionContextRepository(pool);
  const reads = new PostgresDemoReadRepository(pool);
  const openclaw = new OpenClawCliAdapter(new NodeOpenClawCommandRunner(), {
    executable: firstEnvironment(environment, ["OPENCLAW_EXECUTABLE"]) ?? "openclaw",
    expectedVersion: firstEnvironment(environment, ["OPENCLAW_VERSION"]) ?? OPENCLAW_2026_6_11,
    gatewayCallTimeoutMs: 600_000,
    now: () => clock.now(),
  });
  const ensureAgent = new EnsureTenantBizAgent(catalog, runtimes, {
    runtimeRoot,
    now: () => clock.now(),
  });
  const taskOrchestrator = new TaskOrchestrator(
    catalog,
    ensureAgent,
    runtimes,
    new CreateTaskExecutionContext(catalog, contexts, { now: () => clock.now() }),
    phase5,
    openclaw,
    new OpenClawTaskProfileFactory({ runtimeRoot }),
    clock,
    {
      dispatchMode: dispatchMode(environment["OPENCLAW_TASK_DISPATCH_MODE"]),
      restoreContextLoader: {
        async load(input) {
          const restored = await phase5.loadRestoreBundle({
            scope: input.scope,
            logicalAgentId: input.logicalAgentId,
            limit: 20,
          });
          if (restored.previousRuntimeInstanceId !== input.restoredFromRuntimeInstanceId) {
            throw new Error("restore bundle does not match the runtime lineage");
          }
          return {
            restored_from_runtime_instance_id: input.restoredFromRuntimeInstanceId,
            session_summary: restored.latestSessionSummary?.summary.slice(0, 2_000) ?? null,
            memories: restored.memories.map((memory) => ({
              memory_id: memory.memoryId,
              memory_type: memory.memoryType,
              resource_type: memory.resourceType,
              resource_id: memory.resourceId,
              content: memory.content.slice(0, 1_000),
            })),
            trace_index: restored.traceIndex.map((trace) => ({
              trace_id: trace.traceId,
              event_type: trace.eventType,
              decision: trace.decision,
              reason: trace.reason,
              created_at: trace.createdAt.toISOString(),
            })),
            unfinished_tasks: restored.unfinishedTasks.map((task) => ({
              task_id: task.taskId,
              task_type: task.taskType,
              status: task.status,
              current_step: task.currentStep,
            })),
          };
        },
      },
    },
  );

  const l1Sessions = new OpenClawL1CheckpointSessionSource(openclaw);
  const transcriptSource = new ResolvedCheckpointTranscriptSource(
    new OpenClawCheckpointTranscriptSource(l1Sessions, openclaw),
    phase5,
    openclaw,
  );
  const volume = new LocalCheckpointVolume(checkpointRoot);
  const checkpointWriter = new Phase5LifecycleCheckpointWriter(
    new PostgresCheckpointCaptureSource(
      phase5,
      transcriptSource,
      new CatalogCheckpointCapabilitySummarySource(catalog, phase5),
      l1Sessions,
    ),
    volume,
    phase5,
    { volumeRoot: checkpointRoot },
  );
  const lifecycle = new PostgresLifecycleRepository(pool);
  const unloader = new ResolvedLifecycleRuntimeUnloader(phase5, openclaw);
  const ttl = lifecycleTtlFromEnvironment(environment);
  const reaper = new LifecycleReaper(lifecycle, checkpointWriter, unloader, clock, {
    scopes: demoScopes(),
    ...ttl,
  });
  const demoAdminEnabled =
    environment["AGENTNEST_PROFILE"]?.trim().toLowerCase() === "demo" &&
    enabled(environment["ADMIN_API_ENABLED"]) &&
    enabled(environment["TEST_CLOCK_ENABLED"]);
  const admin = new ScopedLifecycleAdminService(
    lifecycle,
    checkpointWriter,
    unloader,
    runtimes,
    reaper,
    clock,
  );
  const server = buildControlPlaneServer({
    tasks: taskOrchestrator,
    reads,
    catalog,
    health: new CompositeControlPlaneHealthProbe(reads, openclaw),
    admin,
    demoAdminEnabled,
  });
  const shutdown = async (): Promise<void> => {
    await server.close();
    await pool.end();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  await server.listen(address);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void startControlPlane().catch(() => {
    process.stderr.write("AgentNest Control Plane failed to start.\n");
    process.exitCode = 1;
  });
}
