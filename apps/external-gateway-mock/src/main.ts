import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NodePostgresPool,
  PostgresDemoGatewayRepository,
  PostgresDemoReadRepository,
  PostgresExecutionContextRepository,
  PostgresGatewayTraceRepository,
} from "@agentnest/persistence";

import {
  PostgresExternalGatewayExecutionContextLookup,
  buildExternalGatewayMockServer,
} from "./index.js";

export const DEFAULT_EXTERNAL_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_EXTERNAL_GATEWAY_PORT = 18_082;

export interface ExternalGatewayListenAddress {
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
    firstEnvironment(environment, ["EXTERNAL_GATEWAY_HOST", "AGENTNEST_BIND_HOST"]) ?? fallback;
  if (host !== "127.0.0.1") {
    throw new TypeError("External Gateway host must be 127.0.0.1 for the Demo");
  }
  return host;
}

function port(environment: Readonly<Record<string, string | undefined>>, fallback: number): number {
  const raw = firstEnvironment(environment, [
    "EXTERNAL_GATEWAY_MOCK_PORT",
    "EXTERNAL_GATEWAY_PORT",
    "PORT",
  ]);
  const value = raw === undefined || raw.length === 0 ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new TypeError("External Gateway port must be a TCP port");
  }
  return value;
}

export function resolveExternalGatewayListenAddress(
  environment: Readonly<Record<string, string | undefined>>,
): ExternalGatewayListenAddress {
  return {
    host: privateHost(environment, DEFAULT_EXTERNAL_GATEWAY_HOST),
    port: port(environment, DEFAULT_EXTERNAL_GATEWAY_PORT),
  };
}

export async function startExternalGateway(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const address = resolveExternalGatewayListenAddress(environment);
  const pool = new NodePostgresPool({
    connectionString: requiredEnvironment(environment, "DATABASE_URL"),
    applicationName: "agentnest-external-gateway",
    max: 5,
    connectionTimeoutMillis: 5_000,
  });
  const contexts = new PostgresExecutionContextRepository(pool);
  const reads = new PostgresDemoReadRepository(pool);
  const server = buildExternalGatewayMockServer({
    contextLookup: new PostgresExternalGatewayExecutionContextLookup(contexts),
    traceSink: new PostgresGatewayTraceRepository(pool, { gatewayName: "EXTERNAL" }),
    fixtures: new PostgresDemoGatewayRepository(pool),
    clock: { now: () => new Date() },
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
  void startExternalGateway().catch(() => {
    process.stderr.write("AgentNest External Gateway failed to start.\n");
    process.exitCode = 1;
  });
}
