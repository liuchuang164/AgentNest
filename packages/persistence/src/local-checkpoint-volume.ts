import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LOGICAL_AGENT_ID_PATTERN = /^tb_[a-f0-9]{20}$/u;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:@-]{0,127}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/iu;
const SNAPSHOT_FILE_PATTERN = /^artifacts\/snapshot-[a-f0-9]{64}\.json$/u;
const TRANSCRIPT_FILE_PATTERN = /^artifacts\/transcript-[a-f0-9]{64}\.jsonl$/u;

export type CheckpointJsonPrimitive = boolean | number | string | null;
export type CheckpointJsonValue =
  CheckpointJsonPrimitive | CheckpointJsonObject | readonly CheckpointJsonValue[];
export interface CheckpointJsonObject {
  readonly [key: string]: CheckpointJsonValue;
}

export interface LocalCheckpointIdentity {
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
}

export interface LocalL1CheckpointIdentity {
  readonly logicalAgentId: string;
  readonly runtimeInstanceId: string;
}

/**
 * Only the compact state needed for a later runtime is stored in the Snapshot.
 * The full Transcript is deliberately a separate artifact and is never part of
 * this object.
 */
export interface LocalCheckpointSnapshot {
  readonly sessionSummary: string;
  readonly memories: readonly CheckpointJsonObject[];
  readonly traceIndex: readonly CheckpointJsonObject[];
  readonly taskState: CheckpointJsonObject | null;
  readonly result: CheckpointJsonValue;
  readonly capabilitySummary: CheckpointJsonObject | null;
}

export interface SaveLocalCheckpointInput extends LocalCheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly transcript: string;
  readonly snapshot: LocalCheckpointSnapshot;
}

export interface SaveLocalL1CheckpointInput extends LocalL1CheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly transcript: string;
  readonly snapshot: LocalCheckpointSnapshot;
}

export interface LocalArtifactReference {
  readonly path: string;
  readonly uri: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface LocalCheckpointReceipt extends LocalCheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly snapshot: LocalArtifactReference;
  readonly transcript: LocalArtifactReference;
}

export interface LocalL1CheckpointReceipt extends LocalL1CheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly snapshot: LocalArtifactReference;
  readonly transcript: LocalArtifactReference;
}

export interface RestoredLocalCheckpoint extends LocalCheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly state: LocalCheckpointSnapshot;
  readonly snapshot: LocalArtifactReference;
  /** Reference only. Restore never reads or returns the Transcript body. */
  readonly transcript: LocalArtifactReference;
}

export interface RestoredLocalL1Checkpoint extends LocalL1CheckpointIdentity {
  readonly checkpointedAt: Date;
  readonly state: LocalCheckpointSnapshot;
  readonly snapshot: LocalArtifactReference;
  /** Reference only. Restore never reads or returns the Transcript body. */
  readonly transcript: LocalArtifactReference;
}

export interface LocalCheckpointVolumeOptions {
  /** Injectable only so atomic rename failures can be verified deterministically. */
  readonly renameFile?: (source: string, destination: string) => Promise<void>;
}

interface StoredArtifactReference {
  readonly relative_path: string;
  readonly sha256: string;
  readonly byte_length: number;
}

interface StoredIdentity {
  readonly logical_agent_id: string;
  readonly runtime_instance_id: string;
  readonly session_id: string;
  readonly task_id: string;
}

interface StoredL1Identity {
  readonly logical_agent_id: string;
  readonly runtime_instance_id: string;
}

interface StoredCheckpointManifest extends StoredIdentity {
  readonly schema_version: 1;
  readonly checkpointed_at: string;
  readonly snapshot_ref: StoredArtifactReference;
  readonly transcript_ref: StoredArtifactReference;
}

interface StoredL1CheckpointManifest extends StoredL1Identity {
  readonly schema_version: 1;
  readonly checkpoint_level: "L1";
  readonly checkpointed_at: string;
  readonly snapshot_ref: StoredArtifactReference;
  readonly transcript_ref: StoredArtifactReference;
}

interface StoredSnapshotEnvelope extends StoredIdentity {
  readonly schema_version: 1;
  readonly checkpointed_at: string;
  readonly transcript_ref: StoredArtifactReference;
  readonly state: LocalCheckpointSnapshot;
}

interface StoredL1SnapshotEnvelope extends StoredL1Identity {
  readonly schema_version: 1;
  readonly checkpoint_level: "L1";
  readonly checkpointed_at: string;
  readonly transcript_ref: StoredArtifactReference;
  readonly state: LocalCheckpointSnapshot;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function assertWithinRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot !== "" && (fromRoot.startsWith("..") || isAbsolute(fromRoot))) {
    throw new TypeError("checkpoint path escapes the configured persistence root");
  }
}

function assertSafeIdentifier(value: string, label: string): string {
  if (
    value === "." ||
    value === ".." ||
    isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(value) ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${label} is not a safe persistence identifier`);
  }
  return value;
}

function assertIdentity(input: LocalCheckpointIdentity): LocalCheckpointIdentity {
  if (!LOGICAL_AGENT_ID_PATTERN.test(input.logicalAgentId)) {
    throw new TypeError("logicalAgentId is not a stable tenant-business logical ID");
  }
  return {
    logicalAgentId: input.logicalAgentId,
    runtimeInstanceId: assertSafeIdentifier(input.runtimeInstanceId, "runtimeInstanceId"),
    sessionId: assertSafeIdentifier(input.sessionId, "sessionId"),
    taskId: assertSafeIdentifier(input.taskId, "taskId"),
  };
}

function assertL1Identity(input: LocalL1CheckpointIdentity): LocalL1CheckpointIdentity {
  if (!LOGICAL_AGENT_ID_PATTERN.test(input.logicalAgentId)) {
    throw new TypeError("logicalAgentId is not a stable tenant-business logical ID");
  }
  return {
    logicalAgentId: input.logicalAgentId,
    runtimeInstanceId: assertSafeIdentifier(input.runtimeInstanceId, "runtimeInstanceId"),
  };
}

function identitySegments(identity: LocalCheckpointIdentity): readonly string[] {
  return [
    "checkpoints",
    identity.logicalAgentId,
    "runtimes",
    identity.runtimeInstanceId,
    "sessions",
    identity.sessionId,
    "tasks",
    identity.taskId,
  ];
}

function l1IdentitySegments(identity: LocalL1CheckpointIdentity): readonly string[] {
  return ["checkpoints", identity.logicalAgentId, "runtimes", identity.runtimeInstanceId, "l1"];
}

function storedIdentity(identity: LocalCheckpointIdentity): StoredIdentity {
  return {
    logical_agent_id: identity.logicalAgentId,
    runtime_instance_id: identity.runtimeInstanceId,
    session_id: identity.sessionId,
    task_id: identity.taskId,
  };
}

function storedL1Identity(identity: LocalL1CheckpointIdentity): StoredL1Identity {
  return {
    logical_agent_id: identity.logicalAgentId,
    runtime_instance_id: identity.runtimeInstanceId,
  };
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function assertJsonValue(value: unknown, location: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${location} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${location} contains a non-JSON value`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${location} contains a cycle`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonValue(item, `${location}[${String(index)}]`, seen);
    }
  } else {
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${location} must contain only plain JSON objects`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function assertSnapshot(snapshot: LocalCheckpointSnapshot): void {
  if (typeof snapshot.sessionSummary !== "string") {
    throw new TypeError("snapshot.sessionSummary must be a string");
  }
  if (!Array.isArray(snapshot.memories) || !Array.isArray(snapshot.traceIndex)) {
    throw new TypeError("snapshot memories and traceIndex must be arrays");
  }
  assertJsonValue(snapshot, "snapshot", new WeakSet<object>());
}

function assertCheckpointedAt(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("checkpointedAt must be a valid Date");
  }
  return value.toISOString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} is not a string`);
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}.${key} is not a non-negative integer`);
  }
  return value;
}

function parseStoredReference(
  value: unknown,
  label: string,
  expectedPathPattern: RegExp,
): StoredArtifactReference {
  const record = asRecord(value, label);
  const relativePath = readString(record, "relative_path", label);
  const sha256 = readString(record, "sha256", label);
  if (
    isAbsolute(relativePath) ||
    WINDOWS_ABSOLUTE_PATH_PATTERN.test(relativePath) ||
    !expectedPathPattern.test(relativePath)
  ) {
    throw new Error(`${label}.relative_path is unsafe or malformed`);
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`${label}.sha256 is malformed`);
  }
  return {
    relative_path: relativePath,
    sha256,
    byte_length: readInteger(record, "byte_length", label),
  };
}

function parseStoredIdentity(record: Record<string, unknown>, label: string): StoredIdentity {
  const identity = assertIdentity({
    logicalAgentId: readString(record, "logical_agent_id", label),
    runtimeInstanceId: readString(record, "runtime_instance_id", label),
    sessionId: readString(record, "session_id", label),
    taskId: readString(record, "task_id", label),
  });
  return storedIdentity(identity);
}

function parseStoredL1Identity(record: Record<string, unknown>, label: string): StoredL1Identity {
  return storedL1Identity(
    assertL1Identity({
      logicalAgentId: readString(record, "logical_agent_id", label),
      runtimeInstanceId: readString(record, "runtime_instance_id", label),
    }),
  );
}

function parseTimestamp(record: Record<string, unknown>, label: string): string {
  const value = readString(record, "checkpointed_at", label);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label}.checkpointed_at is invalid`);
  }
  return value;
}

function parseManifest(content: Uint8Array): StoredCheckpointManifest {
  const parsed: unknown = JSON.parse(Buffer.from(content).toString("utf8"));
  const record = asRecord(parsed, "checkpoint manifest");
  if (record["schema_version"] !== 1) {
    throw new Error("checkpoint manifest schema_version is unsupported");
  }
  return {
    schema_version: 1,
    ...parseStoredIdentity(record, "checkpoint manifest"),
    checkpointed_at: parseTimestamp(record, "checkpoint manifest"),
    snapshot_ref: parseStoredReference(
      record["snapshot_ref"],
      "checkpoint manifest.snapshot_ref",
      SNAPSHOT_FILE_PATTERN,
    ),
    transcript_ref: parseStoredReference(
      record["transcript_ref"],
      "checkpoint manifest.transcript_ref",
      TRANSCRIPT_FILE_PATTERN,
    ),
  };
}

function parseL1Manifest(content: Uint8Array): StoredL1CheckpointManifest {
  const parsed: unknown = JSON.parse(Buffer.from(content).toString("utf8"));
  const record = asRecord(parsed, "L1 checkpoint manifest");
  if (record["schema_version"] !== 1 || record["checkpoint_level"] !== "L1") {
    throw new Error("L1 checkpoint manifest schema is unsupported");
  }
  return {
    schema_version: 1,
    checkpoint_level: "L1",
    ...parseStoredL1Identity(record, "L1 checkpoint manifest"),
    checkpointed_at: parseTimestamp(record, "L1 checkpoint manifest"),
    snapshot_ref: parseStoredReference(
      record["snapshot_ref"],
      "L1 checkpoint manifest.snapshot_ref",
      SNAPSHOT_FILE_PATTERN,
    ),
    transcript_ref: parseStoredReference(
      record["transcript_ref"],
      "L1 checkpoint manifest.transcript_ref",
      TRANSCRIPT_FILE_PATTERN,
    ),
  };
}

function parseSnapshot(content: Uint8Array): StoredSnapshotEnvelope {
  const parsed: unknown = JSON.parse(Buffer.from(content).toString("utf8"));
  const record = asRecord(parsed, "checkpoint snapshot");
  if (record["schema_version"] !== 1) {
    throw new Error("checkpoint snapshot schema_version is unsupported");
  }
  const state = record["state"];
  const stateRecord = asRecord(state, "checkpoint snapshot.state");
  const snapshot: LocalCheckpointSnapshot = {
    sessionSummary: readString(stateRecord, "sessionSummary", "checkpoint snapshot.state"),
    memories: parseObjectArray(stateRecord["memories"], "checkpoint snapshot.state.memories"),
    traceIndex: parseObjectArray(stateRecord["traceIndex"], "checkpoint snapshot.state.traceIndex"),
    taskState: parseNullableObject(stateRecord["taskState"], "checkpoint snapshot.state.taskState"),
    result: parseJsonValue(stateRecord["result"], "checkpoint snapshot.state.result"),
    capabilitySummary: parseNullableObject(
      stateRecord["capabilitySummary"],
      "checkpoint snapshot.state.capabilitySummary",
    ),
  };
  assertSnapshot(snapshot);
  return {
    schema_version: 1,
    ...parseStoredIdentity(record, "checkpoint snapshot"),
    checkpointed_at: parseTimestamp(record, "checkpoint snapshot"),
    transcript_ref: parseStoredReference(
      record["transcript_ref"],
      "checkpoint snapshot.transcript_ref",
      TRANSCRIPT_FILE_PATTERN,
    ),
    state: snapshot,
  };
}

function parseL1Snapshot(content: Uint8Array): StoredL1SnapshotEnvelope {
  const parsed: unknown = JSON.parse(Buffer.from(content).toString("utf8"));
  const record = asRecord(parsed, "L1 checkpoint snapshot");
  if (record["schema_version"] !== 1 || record["checkpoint_level"] !== "L1") {
    throw new Error("L1 checkpoint snapshot schema is unsupported");
  }
  const stateRecord = asRecord(record["state"], "L1 checkpoint snapshot.state");
  const snapshot: LocalCheckpointSnapshot = {
    sessionSummary: readString(stateRecord, "sessionSummary", "L1 checkpoint snapshot.state"),
    memories: parseObjectArray(stateRecord["memories"], "L1 checkpoint snapshot.state.memories"),
    traceIndex: parseObjectArray(
      stateRecord["traceIndex"],
      "L1 checkpoint snapshot.state.traceIndex",
    ),
    taskState: parseNullableObject(
      stateRecord["taskState"],
      "L1 checkpoint snapshot.state.taskState",
    ),
    result: parseJsonValue(stateRecord["result"], "L1 checkpoint snapshot.state.result"),
    capabilitySummary: parseNullableObject(
      stateRecord["capabilitySummary"],
      "L1 checkpoint snapshot.state.capabilitySummary",
    ),
  };
  assertSnapshot(snapshot);
  return {
    schema_version: 1,
    checkpoint_level: "L1",
    ...parseStoredL1Identity(record, "L1 checkpoint snapshot"),
    checkpointed_at: parseTimestamp(record, "L1 checkpoint snapshot"),
    transcript_ref: parseStoredReference(
      record["transcript_ref"],
      "L1 checkpoint snapshot.transcript_ref",
      TRANSCRIPT_FILE_PATTERN,
    ),
    state: snapshot,
  };
}

function parseObjectArray(value: unknown, label: string): readonly CheckpointJsonObject[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} is not an array`);
  }
  return value.map((item, index) => parseJsonObject(item, `${label}[${String(index)}]`));
}

function parseNullableObject(value: unknown, label: string): CheckpointJsonObject | null {
  return value === null ? null : parseJsonObject(value, label);
}

function parseJsonObject(value: unknown, label: string): CheckpointJsonObject {
  const record = asRecord(value, label);
  assertJsonValue(record, label, new WeakSet<object>());
  return record as CheckpointJsonObject;
}

function parseJsonValue(value: unknown, label: string): CheckpointJsonValue {
  assertJsonValue(value, label, new WeakSet<object>());
  return value as CheckpointJsonValue;
}

function storedReferencesEqual(
  first: StoredArtifactReference,
  second: StoredArtifactReference,
): boolean {
  return (
    first.relative_path === second.relative_path &&
    first.sha256 === second.sha256 &&
    first.byte_length === second.byte_length
  );
}

function storedIdentitiesEqual(first: StoredIdentity, second: StoredIdentity): boolean {
  return (
    first.logical_agent_id === second.logical_agent_id &&
    first.runtime_instance_id === second.runtime_instance_id &&
    first.session_id === second.session_id &&
    first.task_id === second.task_id
  );
}

function storedL1IdentitiesEqual(first: StoredL1Identity, second: StoredL1Identity): boolean {
  return (
    first.logical_agent_id === second.logical_agent_id &&
    first.runtime_instance_id === second.runtime_instance_id
  );
}

export class LocalCheckpointVolume {
  readonly #configuredRoot: string;
  readonly #renameFile: (source: string, destination: string) => Promise<void>;

  public constructor(root: string, options: LocalCheckpointVolumeOptions = {}) {
    if (root.trim() === "") {
      throw new TypeError("checkpoint volume root must not be empty");
    }
    this.#configuredRoot = resolve(root);
    this.#renameFile = options.renameFile ?? rename;
  }

  public async checkpointL1(input: SaveLocalL1CheckpointInput): Promise<LocalL1CheckpointReceipt> {
    const identity = assertL1Identity(input);
    const checkpointedAt = assertCheckpointedAt(input.checkpointedAt);
    if (typeof input.transcript !== "string") {
      throw new TypeError("transcript must be a string");
    }
    assertSnapshot(input.snapshot);

    const root = await this.#ensureRoot();
    const checkpointDirectory = await this.#ensureDirectory(root, l1IdentitySegments(identity));
    const artifactDirectory = await this.#ensureDirectory(checkpointDirectory, ["artifacts"]);

    const transcriptBytes = Buffer.from(input.transcript, "utf8");
    const transcriptHash = hashBytes(transcriptBytes);
    const transcriptFileName = `transcript-${transcriptHash}.jsonl`;
    const transcriptPath = resolve(artifactDirectory, transcriptFileName);
    assertWithinRoot(root, transcriptPath);
    await this.#writeImmutable(transcriptPath, transcriptBytes);
    const transcriptReference: StoredArtifactReference = {
      relative_path: `artifacts/${transcriptFileName}`,
      sha256: transcriptHash,
      byte_length: transcriptBytes.byteLength,
    };

    const snapshotEnvelope: StoredL1SnapshotEnvelope = {
      schema_version: 1,
      checkpoint_level: "L1",
      ...storedL1Identity(identity),
      checkpointed_at: checkpointedAt,
      transcript_ref: transcriptReference,
      state: input.snapshot,
    };
    const snapshotBytes = encodeJson(snapshotEnvelope);
    const snapshotHash = hashBytes(snapshotBytes);
    const snapshotFileName = `snapshot-${snapshotHash}.json`;
    const snapshotPath = resolve(artifactDirectory, snapshotFileName);
    assertWithinRoot(root, snapshotPath);
    await this.#writeImmutable(snapshotPath, snapshotBytes);
    const snapshotReference: StoredArtifactReference = {
      relative_path: `artifacts/${snapshotFileName}`,
      sha256: snapshotHash,
      byte_length: snapshotBytes.byteLength,
    };

    const manifest: StoredL1CheckpointManifest = {
      schema_version: 1,
      checkpoint_level: "L1",
      ...storedL1Identity(identity),
      checkpointed_at: checkpointedAt,
      snapshot_ref: snapshotReference,
      transcript_ref: transcriptReference,
    };
    await this.#writeAtomically(
      resolve(checkpointDirectory, "checkpoint.json"),
      encodeJson(manifest),
    );

    return {
      ...identity,
      checkpointedAt: new Date(checkpointedAt),
      snapshot: this.#publicReference(checkpointDirectory, snapshotReference),
      transcript: this.#publicReference(checkpointDirectory, transcriptReference),
    };
  }

  public async checkpoint(input: SaveLocalCheckpointInput): Promise<LocalCheckpointReceipt> {
    const identity = assertIdentity(input);
    const checkpointedAt = assertCheckpointedAt(input.checkpointedAt);
    if (typeof input.transcript !== "string") {
      throw new TypeError("transcript must be a string");
    }
    assertSnapshot(input.snapshot);

    const root = await this.#ensureRoot();
    const taskDirectory = await this.#ensureDirectory(root, identitySegments(identity));
    const artifactDirectory = await this.#ensureDirectory(taskDirectory, ["artifacts"]);

    const transcriptBytes = Buffer.from(input.transcript, "utf8");
    const transcriptHash = hashBytes(transcriptBytes);
    const transcriptFileName = `transcript-${transcriptHash}.jsonl`;
    const transcriptPath = resolve(artifactDirectory, transcriptFileName);
    assertWithinRoot(root, transcriptPath);
    await this.#writeImmutable(transcriptPath, transcriptBytes);
    const transcriptReference: StoredArtifactReference = {
      relative_path: `artifacts/${transcriptFileName}`,
      sha256: transcriptHash,
      byte_length: transcriptBytes.byteLength,
    };

    const snapshotEnvelope: StoredSnapshotEnvelope = {
      schema_version: 1,
      ...storedIdentity(identity),
      checkpointed_at: checkpointedAt,
      transcript_ref: transcriptReference,
      state: input.snapshot,
    };
    const snapshotBytes = encodeJson(snapshotEnvelope);
    const snapshotHash = hashBytes(snapshotBytes);
    const snapshotFileName = `snapshot-${snapshotHash}.json`;
    const snapshotPath = resolve(artifactDirectory, snapshotFileName);
    assertWithinRoot(root, snapshotPath);
    await this.#writeImmutable(snapshotPath, snapshotBytes);
    const snapshotReference: StoredArtifactReference = {
      relative_path: `artifacts/${snapshotFileName}`,
      sha256: snapshotHash,
      byte_length: snapshotBytes.byteLength,
    };

    const manifest: StoredCheckpointManifest = {
      schema_version: 1,
      ...storedIdentity(identity),
      checkpointed_at: checkpointedAt,
      snapshot_ref: snapshotReference,
      transcript_ref: transcriptReference,
    };
    await this.#writeAtomically(resolve(taskDirectory, "checkpoint.json"), encodeJson(manifest));

    return {
      ...identity,
      checkpointedAt: new Date(checkpointedAt),
      snapshot: this.#publicReference(taskDirectory, snapshotReference),
      transcript: this.#publicReference(taskDirectory, transcriptReference),
    };
  }

  public async restore(
    requestedIdentity: LocalCheckpointIdentity,
  ): Promise<RestoredLocalCheckpoint | null> {
    const identity = assertIdentity(requestedIdentity);
    const root = await this.#ensureRoot();
    const taskDirectory = await this.#findDirectory(root, identitySegments(identity));
    if (taskDirectory === null) {
      return null;
    }
    const manifestBytes = await this.#readSafeFile(resolve(taskDirectory, "checkpoint.json"), true);
    if (manifestBytes === null) {
      return null;
    }
    const manifest = parseManifest(manifestBytes);
    const expectedIdentity = storedIdentity(identity);
    if (!storedIdentitiesEqual(manifest, expectedIdentity)) {
      throw new Error("checkpoint manifest identity does not match the requested scope");
    }

    const snapshotPath = this.#resolveStoredReference(taskDirectory, manifest.snapshot_ref);
    const snapshotBytes = await this.#readSafeFile(snapshotPath, false);
    if (snapshotBytes === null) {
      throw new Error("checkpoint snapshot is missing");
    }
    if (
      snapshotBytes.byteLength !== manifest.snapshot_ref.byte_length ||
      hashBytes(snapshotBytes) !== manifest.snapshot_ref.sha256
    ) {
      throw new Error("checkpoint snapshot hash or length does not match its manifest");
    }
    const snapshot = parseSnapshot(snapshotBytes);
    if (
      !storedIdentitiesEqual(snapshot, expectedIdentity) ||
      snapshot.checkpointed_at !== manifest.checkpointed_at ||
      !storedReferencesEqual(snapshot.transcript_ref, manifest.transcript_ref)
    ) {
      throw new Error("checkpoint snapshot does not match its manifest");
    }

    return {
      ...identity,
      checkpointedAt: new Date(manifest.checkpointed_at),
      state: snapshot.state,
      snapshot: this.#publicReference(taskDirectory, manifest.snapshot_ref),
      transcript: this.#publicReference(taskDirectory, manifest.transcript_ref),
    };
  }

  public async restoreL1(
    requestedIdentity: LocalL1CheckpointIdentity,
  ): Promise<RestoredLocalL1Checkpoint | null> {
    const identity = assertL1Identity(requestedIdentity);
    const root = await this.#ensureRoot();
    const checkpointDirectory = await this.#findDirectory(root, l1IdentitySegments(identity));
    if (checkpointDirectory === null) {
      return null;
    }
    const manifestBytes = await this.#readSafeFile(
      resolve(checkpointDirectory, "checkpoint.json"),
      true,
    );
    if (manifestBytes === null) {
      return null;
    }
    const manifest = parseL1Manifest(manifestBytes);
    const expectedIdentity = storedL1Identity(identity);
    if (!storedL1IdentitiesEqual(manifest, expectedIdentity)) {
      throw new Error("L1 checkpoint manifest identity does not match the requested scope");
    }

    const snapshotPath = this.#resolveStoredReference(checkpointDirectory, manifest.snapshot_ref);
    const snapshotBytes = await this.#readSafeFile(snapshotPath, false);
    if (snapshotBytes === null) {
      throw new Error("L1 checkpoint snapshot is missing");
    }
    if (
      snapshotBytes.byteLength !== manifest.snapshot_ref.byte_length ||
      hashBytes(snapshotBytes) !== manifest.snapshot_ref.sha256
    ) {
      throw new Error("L1 checkpoint snapshot hash or length does not match its manifest");
    }
    const snapshot = parseL1Snapshot(snapshotBytes);
    if (
      !storedL1IdentitiesEqual(snapshot, expectedIdentity) ||
      snapshot.checkpointed_at !== manifest.checkpointed_at ||
      !storedReferencesEqual(snapshot.transcript_ref, manifest.transcript_ref)
    ) {
      throw new Error("L1 checkpoint snapshot does not match its manifest");
    }

    return {
      ...identity,
      checkpointedAt: new Date(manifest.checkpointed_at),
      state: snapshot.state,
      snapshot: this.#publicReference(checkpointDirectory, manifest.snapshot_ref),
      transcript: this.#publicReference(checkpointDirectory, manifest.transcript_ref),
    };
  }

  async #ensureRoot(): Promise<string> {
    await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
    const stats = await lstat(this.#configuredRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new TypeError("checkpoint volume root must be a real directory");
    }
    return realpath(this.#configuredRoot);
  }

  async #ensureDirectory(root: string, segments: readonly string[]): Promise<string> {
    let current = root;
    for (const segment of segments) {
      const candidate = resolve(current, segment);
      assertWithinRoot(root, candidate);
      try {
        await mkdir(candidate, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw error;
        }
      }
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new TypeError("checkpoint directory must not be a symlink or non-directory");
      }
      const canonical = await realpath(candidate);
      assertWithinRoot(root, canonical);
      current = canonical;
    }
    return current;
  }

  async #findDirectory(root: string, segments: readonly string[]): Promise<string | null> {
    let current = root;
    for (const segment of segments) {
      const candidate = resolve(current, segment);
      assertWithinRoot(root, candidate);
      let stats;
      try {
        stats = await lstat(candidate);
      } catch (error) {
        if (isMissing(error)) {
          return null;
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new TypeError("checkpoint directory must not be a symlink or non-directory");
      }
      const canonical = await realpath(candidate);
      assertWithinRoot(root, canonical);
      current = canonical;
    }
    return current;
  }

  async #writeImmutable(target: string, content: Uint8Array): Promise<void> {
    const existing = await this.#readSafeFile(target, true);
    if (existing !== null) {
      if (
        existing.byteLength !== content.byteLength ||
        hashBytes(existing) !== hashBytes(content)
      ) {
        throw new Error("content-addressed checkpoint artifact has been modified");
      }
      return;
    }
    await this.#writeAtomically(target, content);
  }

  async #writeAtomically(target: string, content: Uint8Array): Promise<void> {
    await this.#assertSafeFileTarget(target);
    const temporaryPath = resolve(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.temporary`,
    );
    let handle: FileHandle | null = null;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#renameFile(temporaryPath, target);
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #assertSafeFileTarget(target: string): Promise<void> {
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new TypeError("checkpoint artifact target must be a regular file");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  async #readSafeFile(target: string, missingAllowed: boolean): Promise<Buffer | null> {
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missingAllowed && isMissing(error)) {
        return null;
      }
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw new TypeError("checkpoint artifact must be a regular file");
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  #resolveStoredReference(taskDirectory: string, reference: StoredArtifactReference): string {
    const target = resolve(taskDirectory, reference.relative_path);
    assertWithinRoot(taskDirectory, target);
    return target;
  }

  #publicReference(
    taskDirectory: string,
    reference: StoredArtifactReference,
  ): LocalArtifactReference {
    const path = this.#resolveStoredReference(taskDirectory, reference);
    return {
      path,
      uri: pathToFileURL(path).href,
      sha256: reference.sha256,
      byteLength: reference.byte_length,
    };
  }
}
