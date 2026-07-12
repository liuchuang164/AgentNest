import pg from "pg";

import type { PostgresClient, PostgresPool, SqlQueryResult } from "./postgres.js";

const { Pool } = pg;

export interface NodePostgresPoolOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
  readonly idleTimeoutMillis?: number;
}

class NodePostgresClient implements PostgresClient {
  public constructor(private readonly client: pg.PoolClient) {}

  public async query<TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlQueryResult<TRow>> {
    const result = await this.client.query(text, values === undefined ? undefined : [...values]);
    return {
      rows: result.rows as readonly TRow[],
      rowCount: result.rowCount,
    };
  }

  public release(): void {
    this.client.release();
  }
}

function assertPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Thin node-postgres adapter for the repository-level PostgresPool port.
 * It never logs or exposes the configured connection string.
 */
export class NodePostgresPool implements PostgresPool {
  readonly #pool: pg.Pool;

  public constructor(options: NodePostgresPoolOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString must not be empty");
    }
    const config: pg.PoolConfig = {
      connectionString: options.connectionString,
    };
    if (options.applicationName !== undefined) {
      config.application_name = options.applicationName;
    }
    const max = assertPositiveInteger(options.max, "max");
    if (max !== undefined) {
      config.max = max;
    }
    const connectionTimeoutMillis = assertPositiveInteger(
      options.connectionTimeoutMillis,
      "connectionTimeoutMillis",
    );
    if (connectionTimeoutMillis !== undefined) {
      config.connectionTimeoutMillis = connectionTimeoutMillis;
    }
    const idleTimeoutMillis = assertPositiveInteger(options.idleTimeoutMillis, "idleTimeoutMillis");
    if (idleTimeoutMillis !== undefined) {
      config.idleTimeoutMillis = idleTimeoutMillis;
    }
    this.#pool = new Pool(config);
  }

  public async connect(): Promise<PostgresClient> {
    return new NodePostgresClient(await this.#pool.connect());
  }

  public async checkHealth(): Promise<boolean> {
    const result = await this.#pool.query<{ readonly healthy: number }>("SELECT 1 AS healthy");
    return result.rows[0]?.healthy === 1;
  }

  public async end(): Promise<void> {
    await this.#pool.end();
  }
}
