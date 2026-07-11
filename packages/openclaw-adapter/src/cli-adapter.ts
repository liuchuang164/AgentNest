import path from "node:path";

import {
  OpenClawCommandError,
  OpenClawObservedStateError,
  OpenClawProfileValidationError,
} from "./errors.js";
import type {
  DispatchToAgentInput,
  ObservedOpenClawProfile,
  ObservedOpenClawSandboxPolicy,
  ObservedOpenClawSubagentPolicy,
  ObservedOpenClawToolPolicy,
  OpenClawAdapter,
  OpenClawAgentProfileSpec,
  OpenClawAgentRunResult,
  OpenClawCommandRequest,
  OpenClawCommandResult,
  OpenClawCommandRunner,
  OpenClawDelegationMode,
  OpenClawModelSelection,
  OpenClawModelSpec,
  OpenClawSandboxMode,
  OpenClawSandboxScope,
  OpenClawToolProfile,
  OpenClawWorkspaceAccess,
  ParsedOpenClawVersion,
  SpawnTaskAgentInput,
} from "./types.js";
import { OPENCLAW_2026_6_11 } from "./types.js";
import { assertExpectedOpenClawVersion, assertStableVersionString } from "./version.js";

type JsonRecord = Record<string, unknown>;

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const TASK_NAME = /^[a-z][a-z0-9_-]{0,63}$/u;
const MANAGED_PROFILE_FIELDS = [
  "id",
  "name",
  "default",
  "workspace",
  "agentDir",
  "model",
  "skills",
  "tools",
  "subagents",
  "sandbox",
] as const;
const SORTED_STRING_ARRAY_PATHS = new Set([
  "skills",
  "tools.allow",
  "tools.deny",
  "subagents.allowAgents",
]);
const TOOL_PROFILES = new Set<OpenClawToolProfile>(["minimal", "coding", "messaging", "full"]);
const DELEGATION_MODES = new Set<OpenClawDelegationMode>(["suggest", "prefer"]);
const SANDBOX_MODES = new Set<OpenClawSandboxMode>(["off", "non-main", "all"]);
const SANDBOX_SCOPES = new Set<OpenClawSandboxScope>(["session", "agent", "shared"]);
const WORKSPACE_ACCESS = new Set<OpenClawWorkspaceAccess>(["none", "ro", "rw"]);

export interface OpenClawCliAdapterOptions {
  readonly executable?: string;
  readonly expectedVersion?: string;
  readonly now?: () => Date;
  readonly gatewayCallTimeoutMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new OpenClawProfileValidationError(`${field} must not be empty`);
  }
}

function assertAgentId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) {
    throw new OpenClawProfileValidationError("agentId must match [a-z0-9][a-z0-9_-]{0,63}");
  }
}

function assertUniqueNonEmptyStrings(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, field);
    if (seen.has(value)) {
      throw new OpenClawProfileValidationError(`${field} contains duplicate value ${value}`);
    }
    seen.add(value);
  }
}

function assertModel(model: OpenClawModelSpec, field: string): void {
  if (typeof model === "string") {
    assertNonEmpty(model, field);
    return;
  }
  assertNonEmpty(model.primary, `${field}.primary`);
  if (model.fallbacks !== undefined) {
    assertUniqueNonEmptyStrings(model.fallbacks, `${field}.fallbacks`);
  }
}

function validateProfileSpec(spec: OpenClawAgentProfileSpec): void {
  assertAgentId(spec.agentId);
  if (!path.isAbsolute(spec.workspace) || !path.isAbsolute(spec.agentDir)) {
    throw new OpenClawProfileValidationError("workspace and agentDir must be absolute paths");
  }
  if (path.normalize(spec.workspace) === path.normalize(spec.agentDir)) {
    throw new OpenClawProfileValidationError("workspace and agentDir must be different paths");
  }
  if (spec.name !== undefined) {
    assertNonEmpty(spec.name, "name");
  }
  if (spec.model !== undefined) {
    assertModel(spec.model, "model");
  }
  assertUniqueNonEmptyStrings(spec.skills, "skills");
  assertUniqueNonEmptyStrings(spec.tools.allow, "tools.allow");
  assertUniqueNonEmptyStrings(spec.tools.deny, "tools.deny");
  const deniedTools = new Set(spec.tools.deny);
  for (const tool of spec.tools.allow) {
    if (deniedTools.has(tool)) {
      throw new OpenClawProfileValidationError(
        `tool ${tool} cannot appear in both tools.allow and tools.deny`,
      );
    }
  }
  assertUniqueNonEmptyStrings(spec.subagents.allowAgents, "subagents.allowAgents");
  if (spec.subagents.model !== undefined) {
    assertModel(spec.subagents.model, "subagents.model");
  }
  if (spec.subagents.thinking !== undefined) {
    assertNonEmpty(spec.subagents.thinking, "subagents.thinking");
  }
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function modelToConfig(model: OpenClawModelSpec): string | JsonRecord {
  if (typeof model === "string") {
    return model;
  }
  return {
    primary: model.primary,
    ...(model.fallbacks === undefined ? {} : { fallbacks: [...model.fallbacks] }),
  };
}

function profileToConfig(spec: OpenClawAgentProfileSpec): JsonRecord {
  validateProfileSpec(spec);
  return {
    id: spec.agentId,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.default === undefined ? {} : { default: spec.default }),
    workspace: path.normalize(spec.workspace),
    agentDir: path.normalize(spec.agentDir),
    ...(spec.model === undefined ? {} : { model: modelToConfig(spec.model) }),
    skills: sortedStrings(spec.skills),
    tools: {
      ...(spec.tools.profile === undefined ? {} : { profile: spec.tools.profile }),
      allow: sortedStrings(spec.tools.allow),
      deny: sortedStrings(spec.tools.deny),
    },
    subagents: {
      allowAgents: sortedStrings(spec.subagents.allowAgents),
      ...(spec.subagents.delegationMode === undefined
        ? {}
        : { delegationMode: spec.subagents.delegationMode }),
      ...(spec.subagents.model === undefined ? {} : { model: modelToConfig(spec.subagents.model) }),
      ...(spec.subagents.thinking === undefined ? {} : { thinking: spec.subagents.thinking }),
      ...(spec.subagents.requireAgentId === undefined
        ? {}
        : { requireAgentId: spec.subagents.requireAgentId }),
    },
    ...(spec.sandbox === undefined
      ? {}
      : {
          sandbox: {
            mode: spec.sandbox.mode,
            scope: spec.sandbox.scope,
            workspaceAccess: spec.sandbox.workspaceAccess,
          },
        }),
  };
}

function canonicalize(value: unknown, currentPath = ""): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => canonicalize(entry, currentPath));
    if (
      SORTED_STRING_ARRAY_PATHS.has(currentPath) &&
      normalized.every((entry) => typeof entry === "string")
    ) {
      return [...normalized].sort((left, right) => left.localeCompare(right));
    }
    return normalized;
  }
  if (!isRecord(value)) {
    return value;
  }
  const normalized: JsonRecord = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    const nextPath = currentPath.length === 0 ? key : `${currentPath}.${key}`;
    normalized[key] = canonicalize(value[key], nextPath);
  }
  return normalized;
}

function valuesEqual(left: unknown, right: unknown, field: string): boolean {
  return JSON.stringify(canonicalize(left, field)) === JSON.stringify(canonicalize(right, field));
}

/** Returns all AgentNest-owned OpenClaw config fields that differ exactly. */
export function diffManagedProfile(
  spec: OpenClawAgentProfileSpec,
  observedConfig: Readonly<Record<string, unknown>>,
): readonly string[] {
  const desired = profileToConfig(spec);
  const observed: JsonRecord = { ...observedConfig };
  const differences: string[] = [];
  for (const field of MANAGED_PROFILE_FIELDS) {
    const desiredHasField = hasOwn(desired, field);
    const observedHasField = hasOwn(observed, field);
    if (desiredHasField !== observedHasField) {
      differences.push(field);
      continue;
    }
    if (desiredHasField && !valuesEqual(desired[field], observed[field], field)) {
      differences.push(field);
    }
  }
  return differences;
}

function parseJson(stdout: string, operation: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new OpenClawProfileValidationError(`${operation} returned invalid JSON`);
  }
}

function parseOptionalString(record: JsonRecord, key: string, field: string): string | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (typeof value !== "string") {
    throw new OpenClawProfileValidationError(`${field} must be a string`);
  }
  return value;
}

function parseOptionalBoolean(record: JsonRecord, key: string, field: string): boolean | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new OpenClawProfileValidationError(`${field} must be a boolean`);
  }
  return value;
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new OpenClawProfileValidationError(`${field} must be a string array`);
  }
  return [...value];
}

function parseOptionalStringArray(
  record: JsonRecord,
  key: string,
  field: string,
): readonly string[] | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  return parseStringArray(record[key], field);
}

function parseModel(value: unknown, field: string): OpenClawModelSpec {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value) || typeof value["primary"] !== "string") {
    throw new OpenClawProfileValidationError(`${field} must be a model id or model object`);
  }
  const fallbacks = parseOptionalStringArray(value, "fallbacks", `${field}.fallbacks`);
  const parsed: OpenClawModelSelection = {
    primary: value["primary"],
    ...(fallbacks === null ? {} : { fallbacks }),
  };
  return parsed;
}

function parseOptionalModel(
  record: JsonRecord,
  key: string,
  field: string,
): OpenClawModelSpec | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  return parseModel(record[key], field);
}

function parseEnum<T extends string>(
  record: JsonRecord,
  key: string,
  field: string,
  allowed: ReadonlySet<T>,
): T | null {
  if (!hasOwn(record, key)) {
    return null;
  }
  const value = record[key];
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new OpenClawProfileValidationError(`${field} has an unsupported value`);
  }
  return value as T;
}

function parseObservedTools(value: unknown): ObservedOpenClawToolPolicy | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new OpenClawProfileValidationError("tools must be an object");
  }
  return {
    profile: parseEnum(value, "profile", "tools.profile", TOOL_PROFILES),
    allow: parseOptionalStringArray(value, "allow", "tools.allow"),
    deny: parseOptionalStringArray(value, "deny", "tools.deny"),
  };
}

function parseObservedSubagents(value: unknown): ObservedOpenClawSubagentPolicy | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new OpenClawProfileValidationError("subagents must be an object");
  }
  return {
    allowAgents: parseOptionalStringArray(value, "allowAgents", "subagents.allowAgents"),
    delegationMode: parseEnum(
      value,
      "delegationMode",
      "subagents.delegationMode",
      DELEGATION_MODES,
    ),
    model: parseOptionalModel(value, "model", "subagents.model"),
    thinking: parseOptionalString(value, "thinking", "subagents.thinking"),
    requireAgentId: parseOptionalBoolean(value, "requireAgentId", "subagents.requireAgentId"),
  };
}

function parseObservedSandbox(value: unknown): ObservedOpenClawSandboxPolicy | null {
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new OpenClawProfileValidationError("sandbox must be an object");
  }
  return {
    mode: parseEnum(value, "mode", "sandbox.mode", SANDBOX_MODES),
    scope: parseEnum(value, "scope", "sandbox.scope", SANDBOX_SCOPES),
    workspaceAccess: parseEnum(
      value,
      "workspaceAccess",
      "sandbox.workspaceAccess",
      WORKSPACE_ACCESS,
    ),
  };
}

function toObservedProfile(rawConfig: JsonRecord, observedAt: Date): ObservedOpenClawProfile {
  const agentId = parseOptionalString(rawConfig, "id", "id");
  if (agentId === null) {
    throw new OpenClawProfileValidationError("agents.list[] entry is missing id");
  }
  return {
    agentId,
    name: parseOptionalString(rawConfig, "name", "name"),
    default: parseOptionalBoolean(rawConfig, "default", "default"),
    workspace: parseOptionalString(rawConfig, "workspace", "workspace"),
    agentDir: parseOptionalString(rawConfig, "agentDir", "agentDir"),
    model: parseOptionalModel(rawConfig, "model", "model"),
    skills: parseOptionalStringArray(rawConfig, "skills", "skills"),
    tools: parseObservedTools(rawConfig["tools"]),
    subagents: parseObservedSubagents(rawConfig["subagents"]),
    sandbox: parseObservedSandbox(rawConfig["sandbox"]),
    observedAt,
    rawConfig,
  };
}

function extractNestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function extractResultString(record: JsonRecord, key: string): string | null {
  const direct = record[key];
  if (typeof direct === "string") {
    return direct;
  }
  const result = extractNestedRecord(record, "result");
  const nested = result?.[key];
  return typeof nested === "string" ? nested : null;
}

export class OpenClawCliAdapter implements OpenClawAdapter {
  readonly #runner: OpenClawCommandRunner;
  readonly #executable: string;
  readonly #expectedVersion: string;
  readonly #now: () => Date;
  readonly #gatewayCallTimeoutMs: number;

  public constructor(runner: OpenClawCommandRunner, options: OpenClawCliAdapterOptions = {}) {
    this.#runner = runner;
    this.#executable = options.executable ?? "openclaw";
    this.#expectedVersion = options.expectedVersion ?? OPENCLAW_2026_6_11;
    assertStableVersionString(this.#expectedVersion);
    this.#now = options.now ?? (() => new Date());
    this.#gatewayCallTimeoutMs = options.gatewayCallTimeoutMs ?? 600_000;
    if (!Number.isSafeInteger(this.#gatewayCallTimeoutMs) || this.#gatewayCallTimeoutMs <= 0) {
      throw new OpenClawProfileValidationError("gatewayCallTimeoutMs must be a positive integer");
    }
  }

  public async verifyStableVersion(): Promise<ParsedOpenClawVersion> {
    const result = await this.#run(["--version"], "openclaw --version");
    return assertExpectedOpenClawVersion(result.stdout, this.#expectedVersion);
  }

  public async inspectProfile(agentId: string): Promise<ObservedOpenClawProfile | null> {
    assertAgentId(agentId);
    await this.verifyStableVersion();
    const entries = await this.#readAgentEntries();
    const entry = entries.find((candidate) => candidate["id"] === agentId);
    return entry === undefined ? null : toObservedProfile(entry, this.#now());
  }

  public async ensureProfile(spec: OpenClawAgentProfileSpec): Promise<ObservedOpenClawProfile> {
    const desired = profileToConfig(spec);
    await this.verifyStableVersion();
    let entries = await this.#readAgentEntries();
    let index = entries.findIndex((candidate) => candidate["id"] === spec.agentId);
    let mutated = false;

    if (index === -1) {
      if (spec.agentId === "main") {
        await this.#replaceAgentEntries([...entries, desired]);
      } else {
        const model = spec.model;
        const modelId = typeof model === "string" ? model : model?.primary;
        await this.#run(
          [
            "agents",
            "add",
            spec.agentId,
            "--workspace",
            path.normalize(spec.workspace),
            "--agent-dir",
            path.normalize(spec.agentDir),
            ...(modelId === undefined ? [] : ["--model", modelId]),
            "--non-interactive",
            "--json",
          ],
          `openclaw agents add ${spec.agentId}`,
        );
      }
      mutated = true;
      entries = await this.#readAgentEntries();
      index = entries.findIndex((candidate) => candidate["id"] === spec.agentId);
      if (index === -1) {
        throw new OpenClawObservedStateError(spec.agentId, ["id"]);
      }
    }

    const existing = entries[index];
    if (existing === undefined) {
      throw new OpenClawObservedStateError(spec.agentId, ["id"]);
    }
    const existingDifferences = diffManagedProfile(spec, existing);
    if (!mutated && existingDifferences.length === 0) {
      return toObservedProfile(existing, this.#now());
    }
    if (existingDifferences.length > 0) {
      await this.#replaceAgentEntry(index, desired);
      mutated = true;
    }
    if (mutated) {
      await this.#validateConfig();
    }

    const convergedEntries = await this.#readAgentEntries();
    const converged = convergedEntries.find((candidate) => candidate["id"] === spec.agentId);
    if (converged === undefined) {
      throw new OpenClawObservedStateError(spec.agentId, ["id"]);
    }
    const differences = diffManagedProfile(spec, converged);
    if (differences.length > 0) {
      throw new OpenClawObservedStateError(spec.agentId, differences);
    }
    return toObservedProfile(converged, this.#now());
  }

  public async deactivateProfile(agentId: string): Promise<void> {
    assertAgentId(agentId);
    if (agentId === "main") {
      throw new OpenClawProfileValidationError("the fixed main profile cannot be deactivated");
    }
    await this.verifyStableVersion();
    const entries = await this.#readAgentEntries();
    if (!entries.some((candidate) => candidate["id"] === agentId)) {
      return;
    }
    await this.#replaceAgentEntries(entries.filter((candidate) => candidate["id"] !== agentId));
    await this.#validateConfig();
    const observed = await this.#readAgentEntries();
    if (observed.some((candidate) => candidate["id"] === agentId)) {
      throw new OpenClawObservedStateError(agentId, ["id"]);
    }
  }

  public async dispatchToAgent(input: DispatchToAgentInput): Promise<OpenClawAgentRunResult> {
    this.#validateDispatchInput(input);
    await this.verifyStableVersion();
    return this.#dispatchToAgent(input);
  }

  public async spawnTaskAgent(input: SpawnTaskAgentInput): Promise<OpenClawAgentRunResult> {
    assertAgentId(input.l1AgentId);
    assertAgentId(input.childAgentId);
    assertNonEmpty(input.taskId, "taskId");
    assertNonEmpty(input.task, "task");
    assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (!TASK_NAME.test(input.taskName)) {
      throw new OpenClawProfileValidationError("taskName must match [a-z][a-z0-9_-]{0,63}");
    }
    this.#assertSessionBelongsToAgent(input.l1AgentId, input.l1SessionKey);

    await this.verifyStableVersion();
    const entries = await this.#readAgentEntries();
    const parent = entries.find((candidate) => candidate["id"] === input.l1AgentId);
    const child = entries.find((candidate) => candidate["id"] === input.childAgentId);
    if (parent === undefined) {
      throw new OpenClawProfileValidationError(`L1 profile ${input.l1AgentId} is not configured`);
    }
    if (child === undefined) {
      throw new OpenClawProfileValidationError(
        `L2 target profile ${input.childAgentId} is not configured`,
      );
    }
    const parentSubagents = parseObservedSubagents(parent["subagents"]);
    const allowedAgents = parentSubagents?.allowAgents;
    if (
      allowedAgents === null ||
      allowedAgents === undefined ||
      (!allowedAgents.includes(input.childAgentId) && !allowedAgents.includes("*"))
    ) {
      throw new OpenClawProfileValidationError(
        `L1 profile ${input.l1AgentId} cannot spawn ${input.childAgentId}`,
      );
    }

    const spawnArguments = {
      task: `[AgentNest task_id=${input.taskId}]\n${input.task}`,
      taskName: input.taskName,
      agentId: input.childAgentId,
      mode: "run",
      cleanup: "keep",
      context: "isolated",
    } as const;
    const message = [
      "AgentNest controlled L2 request.",
      `Invoke sessions_spawn exactly once with this JSON object: ${JSON.stringify(spawnArguments)}`,
      "Do not change agentId, taskName, mode, cleanup, or context, and do not spawn any other agent.",
      "After the tool accepts the request, return its tool result.",
    ].join("\n");
    return this.#dispatchToAgent({
      agentId: input.l1AgentId,
      sessionKey: input.l1SessionKey,
      message,
      idempotencyKey: input.idempotencyKey,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }

  async #run(
    args: readonly string[],
    operation: string,
    timeoutMs?: number,
  ): Promise<OpenClawCommandResult> {
    const request: OpenClawCommandRequest = {
      executable: this.#executable,
      args,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
    const result = await this.#runner.run(request);
    if (result.exitCode !== 0) {
      throw new OpenClawCommandError(operation, result.exitCode);
    }
    return result;
  }

  async #readAgentEntries(): Promise<JsonRecord[]> {
    const result = await this.#run(
      ["config", "get", "agents", "--json"],
      "openclaw config get agents",
    );
    const parsed = parseJson(result.stdout, "openclaw config get agents");
    if (!isRecord(parsed)) {
      throw new OpenClawProfileValidationError("OpenClaw agents config must be an object");
    }
    const list = parsed["list"];
    if (list === undefined) {
      return [];
    }
    if (!Array.isArray(list)) {
      throw new OpenClawProfileValidationError("OpenClaw agents.list must be an array");
    }
    const entries: JsonRecord[] = [];
    const seen = new Set<string>();
    for (const value of list) {
      if (!isRecord(value) || typeof value["id"] !== "string" || value["id"].length === 0) {
        throw new OpenClawProfileValidationError(
          "every OpenClaw agents.list entry must have a string id",
        );
      }
      if (seen.has(value["id"])) {
        throw new OpenClawProfileValidationError(`duplicate OpenClaw agent id ${value["id"]}`);
      }
      seen.add(value["id"]);
      entries.push(value);
    }
    return entries;
  }

  async #replaceAgentEntry(index: number, desired: JsonRecord): Promise<void> {
    await this.#run(
      ["config", "set", `agents.list[${String(index)}]`, JSON.stringify(desired), "--strict-json"],
      "openclaw config set agents.list entry",
    );
  }

  async #replaceAgentEntries(entries: readonly JsonRecord[]): Promise<void> {
    await this.#run(
      ["config", "set", "agents.list", JSON.stringify(entries), "--strict-json", "--replace"],
      "openclaw config set agents.list",
    );
  }

  async #validateConfig(): Promise<void> {
    await this.#run(["config", "validate", "--json"], "openclaw config validate");
  }

  #validateDispatchInput(input: DispatchToAgentInput): void {
    assertAgentId(input.agentId);
    assertNonEmpty(input.message, "message");
    assertNonEmpty(input.idempotencyKey, "idempotencyKey");
    this.#assertSessionBelongsToAgent(input.agentId, input.sessionKey);
    if (
      input.timeoutMs !== undefined &&
      (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
    ) {
      throw new OpenClawProfileValidationError("timeoutMs must be a positive integer");
    }
    if (
      input.agentTimeoutSeconds !== undefined &&
      (!Number.isSafeInteger(input.agentTimeoutSeconds) || input.agentTimeoutSeconds < 0)
    ) {
      throw new OpenClawProfileValidationError(
        "agentTimeoutSeconds must be a non-negative integer",
      );
    }
  }

  #assertSessionBelongsToAgent(agentId: string, sessionKey: string): void {
    assertNonEmpty(sessionKey, "sessionKey");
    if (!sessionKey.startsWith(`agent:${agentId}:`)) {
      throw new OpenClawProfileValidationError(`sessionKey must be scoped to agent ${agentId}`);
    }
  }

  async #dispatchToAgent(input: DispatchToAgentInput): Promise<OpenClawAgentRunResult> {
    this.#validateDispatchInput(input);
    const commandTimeoutMs = input.timeoutMs ?? this.#gatewayCallTimeoutMs;
    const params: JsonRecord = {
      message: input.message,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      idempotencyKey: input.idempotencyKey,
      ...(input.agentTimeoutSeconds === undefined ? {} : { timeout: input.agentTimeoutSeconds }),
    };
    const result = await this.#run(
      [
        "gateway",
        "call",
        "agent",
        "--params",
        JSON.stringify(params),
        "--expect-final",
        "--json",
        "--timeout",
        String(commandTimeoutMs),
      ],
      `openclaw gateway call agent for ${input.agentId}`,
      commandTimeoutMs,
    );
    const parsed = parseJson(result.stdout, "openclaw gateway call agent");
    if (!isRecord(parsed)) {
      throw new OpenClawProfileValidationError(
        "openclaw gateway call agent must return a JSON object",
      );
    }
    return {
      runId: extractResultString(parsed, "runId"),
      status: extractResultString(parsed, "status"),
      sessionKey: extractResultString(parsed, "sessionKey"),
      raw: parsed,
    };
  }
}
