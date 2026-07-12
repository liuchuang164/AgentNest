import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NodePostgresPool,
  PostgresDemoGatewayRepository,
  PostgresDemoReadRepository,
  PostgresExecutionContextRepository,
  PostgresGatewayTraceRepository,
  PostgresPhase5PersistenceRepository,
} from "@agentnest/persistence";

import {
  PostgresDataGatewayExecutionContextLookup,
  buildDataGatewayMockServer,
  type DataGatewayToolExecutionIdentity,
  type DataGatewayToolOnceGuard,
  type DataGatewayToolOnceResult,
} from "./index.js";

export const DEFAULT_DATA_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_DATA_GATEWAY_PORT = 18_081;

export interface DataGatewayListenAddress {
  readonly host: string;
  readonly port: number;
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
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

function privateHost(
  environment: Readonly<Record<string, string | undefined>>,
  fallback: string,
): string {
  const host =
    firstEnvironment(environment, ["DATA_GATEWAY_HOST", "AGENTNEST_BIND_HOST"]) ?? fallback;
  if (host !== "127.0.0.1") {
    throw new TypeError("Data Gateway host must be 127.0.0.1 for the Demo");
  }
  return host;
}

function port(environment: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = firstEnvironment(environment, [
    "DATA_GATEWAY_MOCK_PORT",
    "DATA_GATEWAY_PORT",
    "PORT",
  ]);
  const value = raw === undefined || raw.length === 0 ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("Data Gateway port must be a TCP port");
  }
  return value;
}

export function resolveDataGatewayListenAddress(
  environment: Readonly<Record<string, string | undefined>>,
): DataGatewayListenAddress {
  return {
    host: privateHost(environment, DEFAULT_DATA_GATEWAY_HOST),
    port: port(environment, DEFAULT_DATA_GATEWAY_PORT),
  };
}

class PostgresDataToolOnceGuard implements DataGatewayToolOnceGuard {
  readonly #pending = new Map<string, Promise<void>>();

  public constructor(private readonly persistence: PostgresPhase5PersistenceRepository) {}

  public async execute(
    identity: DataGatewayToolExecutionIdentity,
    operation: () => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<DataGatewayToolOnceResult> {
    const key = [
      identity.scope.tenantId,
      identity.scope.bizDomain,
      identity.logicalAgentId,
      identity.taskId,
      identity.toolName,
      identity.action,
      identity.resourceType,
      identity.resourceId,
    ].join("\u0000");
    return await this.withLock(key, async () => {
      const lookup = {
        scope: identity.scope,
        logicalAgentId: identity.logicalAgentId,
        taskId: identity.taskId,
        toolName: identity.toolName,
        action: identity.action,
        resourceType: identity.resourceType,
        resourceId: identity.resourceId,
      } as const;
      const existing = await this.persistence.findToolCompletion(lookup);
      if (existing !== null) {
        return { result: existing.result, executed: false };
      }
      const result = await operation();
      const persisted = await this.persistence.recordToolCompletion({
        ...lookup,
        runtimeInstanceId: identity.runtimeInstanceId,
        sessionId: identity.sessionId,
        result,
        completedAt: new Date(),
      });
      return { result: persisted.record.result, executed: persisted.created };
    });
  }

  private async withLock<TResult>(
    key: string,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const current = previous.then(() => gate);
    this.#pending.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#pending.get(key) === current) {
        this.#pending.delete(key);
      }
    }
  }
}

export async function startDataGateway(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const address = resolveDataGatewayListenAddress(environment);
  const pool = new NodePostgresPool({
    connectionString: requiredEnvironment(environment, "DATABASE_URL"),
    applicationName: "agentnest-data-gateway",
    max: 5,
    connectionTimeoutMillis: 5_000,
  });
  const contexts = new PostgresExecutionContextRepository(pool);
  const phase5 = new PostgresPhase5PersistenceRepository(pool);
  const reads = new PostgresDemoReadRepository(pool);
  const server = buildDataGatewayMockServer({
    contextLookup: new PostgresDataGatewayExecutionContextLookup(contexts),
    traceSink: new PostgresGatewayTraceRepository(pool, { gatewayName: "DATA" }),
    fixtures: new PostgresDemoGatewayRepository(pool),
    clock: { now: () => new Date() },
    toolOnceGuard: new PostgresDataToolOnceGuard(phase5),
  });
  server.get("/health", async (request, reply) => {
    const status = await reads.checkHealth();
    const requestHeader = request.headers["x-request-id"];
    const requestId =
      typeof requestHeader === "string" && requestHeader.length > 0
        ? requestHeader
        : `req_${randomUUID()}`;
    return await reply.code(status.postgres && status.migrations ? 200 : 503).send({
      success: status.postgres && status.migrations,
      code: status.postgres && status.migrations ? "OK" : "NOT_READY",
      message: status.postgres && status.migrations ? "service is healthy" : "service is not ready",
      request_id: requestId,
      trace_id: `trace_${randomUUID()}`,
      data: status,
      error: status.postgres && status.migrations ? null : { reason: "DATABASE_NOT_READY" },
    });
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
  void startDataGateway().catch(() => {
    process.stderr.write("AgentNest Data Gateway failed to start.\n");
    process.exitCode = 1;
  });
}
