import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalCheckpointVolume,
  type LocalCheckpointIdentity,
  type SaveLocalL1CheckpointInput,
  type SaveLocalCheckpointInput,
} from "../../packages/persistence/src/local-checkpoint-volume.js";

const temporaryRoots: string[] = [];
const identity: LocalCheckpointIdentity = {
  logicalAgentId: "tb_9fa3d61c2d63ee4285ee",
  runtimeInstanceId: "ari_legal_001",
  sessionId: "agent:l2_legal:subagent:session_001",
  taskId: "task_legal_001",
};

function checkpointInput(
  overrides: Partial<SaveLocalCheckpointInput> = {},
): SaveLocalCheckpointInput {
  return {
    ...identity,
    checkpointedAt: new Date("2026-07-12T01:02:03.000Z"),
    transcript: '{"role":"user","content":"summarize case_001"}\n',
    snapshot: {
      sessionSummary: "case_001 summary is ready",
      memories: [{ memory_type: "case_note", content: "tenant A canary" }],
      traceIndex: [{ trace_id: "trace_001", decision: "ALLOW" }],
      taskState: { status: "COMPLETED", current_step: "done" },
      result: { answer: "summary" },
      capabilitySummary: { tools: ["legal_case_read"] },
    },
    ...overrides,
  };
}

function l1CheckpointInput(
  overrides: Partial<SaveLocalL1CheckpointInput> = {},
): SaveLocalL1CheckpointInput {
  return {
    logicalAgentId: identity.logicalAgentId,
    runtimeInstanceId: identity.runtimeInstanceId,
    checkpointedAt: new Date("2026-07-12T01:02:03.000Z"),
    transcript: '{"role":"assistant","content":"L1 summary"}\n',
    snapshot: {
      sessionSummary: "L1 tenant-business runtime summary",
      memories: [{ content: "ALPHA_LEGAL_MEMORY" }],
      traceIndex: [{ trace_id: "trace_l1_checkpoint" }],
      taskState: null,
      result: null,
      capabilitySummary: { profile_id: "profile_tenant_a_legal_v1" },
    },
    ...overrides,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "agentnest-checkpoint-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LocalCheckpointVolume", () => {
  it("stores and restores an L1 checkpoint without synthetic task or session IDs", async () => {
    const root = await makeRoot();
    const volume = new LocalCheckpointVolume(root);

    const receipt = await volume.checkpointL1(l1CheckpointInput());
    const restored = await volume.restoreL1({
      logicalAgentId: identity.logicalAgentId,
      runtimeInstanceId: identity.runtimeInstanceId,
    });

    expect(receipt.snapshot.path).toContain("/l1/artifacts/");
    expect(receipt.snapshot.path).not.toContain("/sessions/");
    expect(receipt.snapshot.path).not.toContain("/tasks/");
    expect(restored?.state.sessionSummary).toBe("L1 tenant-business runtime summary");
    const manifestPath = resolve(dirname(dirname(receipt.snapshot.path)), "checkpoint.json");
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      checkpoint_level: "L1",
      logical_agent_id: identity.logicalAgentId,
      runtime_instance_id: identity.runtimeInstanceId,
    });
    expect(manifest).not.toHaveProperty("session_id");
    expect(manifest).not.toHaveProperty("task_id");
  });

  it("atomically stores Transcript and Snapshot artifacts below the scoped root", async () => {
    const root = await makeRoot();
    const volume = new LocalCheckpointVolume(root);

    const receipt = await volume.checkpoint(checkpointInput());

    expect(receipt.snapshot.path).toContain(identity.logicalAgentId);
    expect(receipt.snapshot.path).toContain(identity.runtimeInstanceId);
    expect(receipt.snapshot.path).toContain(identity.sessionId);
    expect(receipt.snapshot.path).toContain(identity.taskId);
    expect(receipt.snapshot.uri).toMatch(/^file:/u);
    expect(await readFile(receipt.transcript.path, "utf8")).toBe(checkpointInput().transcript);
    const storedSnapshot = JSON.parse(await readFile(receipt.snapshot.path, "utf8")) as unknown;
    expect(storedSnapshot).toMatchObject({
      logical_agent_id: identity.logicalAgentId,
      runtime_instance_id: identity.runtimeInstanceId,
      session_id: identity.sessionId,
      task_id: identity.taskId,
      state: { sessionSummary: "case_001 summary is ready" },
    });
  });

  it("returns SHA-256 hashes that match both stored artifacts", async () => {
    const root = await makeRoot();
    const receipt = await new LocalCheckpointVolume(root).checkpoint(checkpointInput());

    for (const artifact of [receipt.snapshot, receipt.transcript]) {
      const content = await readFile(artifact.path);
      expect(artifact.sha256).toBe(createHash("sha256").update(content).digest("hex"));
      expect(artifact.byteLength).toBe(content.byteLength);
    }
  });

  it("is idempotent for an identical repeated checkpoint", async () => {
    const root = await makeRoot();
    const volume = new LocalCheckpointVolume(root);
    const input = checkpointInput();

    const first = await volume.checkpoint(input);
    const second = await volume.checkpoint(input);

    expect(second).toEqual(first);
  });

  it("restores compact Snapshot state and exposes only a Transcript reference", async () => {
    const root = await makeRoot();
    const volume = new LocalCheckpointVolume(root);
    const receipt = await volume.checkpoint(checkpointInput());
    await rm(receipt.transcript.path);

    const restored = await volume.restore(identity);

    expect(restored).not.toBeNull();
    expect(restored?.state).toEqual(checkpointInput().snapshot);
    expect(restored?.transcript.path).toBe(receipt.transcript.path);
    expect(restored?.transcript.uri).toMatch(/^file:/u);
    expect(restored).not.toHaveProperty("transcript.content");
    expect(restored).not.toHaveProperty("transcript.body");
    expect(restored).not.toHaveProperty("state.transcript");
  });

  it("returns null when no checkpoint exists", async () => {
    const root = await makeRoot();
    await expect(new LocalCheckpointVolume(root).restore(identity)).resolves.toBeNull();
  });

  it("rejects traversal, absolute, and separator-bearing identity values", async () => {
    const root = await makeRoot();
    const volume = new LocalCheckpointVolume(root);
    for (const invalidIdentity of [
      { ...identity, logicalAgentId: "../tb_9fa3d61c2d63ee4285ee" },
      { ...identity, runtimeInstanceId: "/tmp/runtime" },
      { ...identity, sessionId: ".." },
      { ...identity, taskId: "tasks/escape" },
      { ...identity, taskId: "C:\\escape" },
    ]) {
      await expect(volume.restore(invalidIdentity)).rejects.toThrow(TypeError);
    }
  });

  it("rejects a symlink escape inside the scoped checkpoint directory", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const checkpoints = resolve(root, "checkpoints");
    await mkdir(checkpoints);
    await symlink(outside, resolve(checkpoints, identity.logicalAgentId));

    await expect(new LocalCheckpointVolume(root).checkpoint(checkpointInput())).rejects.toThrow(
      /symlink/u,
    );
    expect(await readFile(resolve(outside, "sentinel"), "utf8").catch(() => "missing")).toBe(
      "missing",
    );
  });

  it("keeps the prior checkpoint visible when the atomic manifest write fails", async () => {
    const root = await makeRoot();
    let failManifestRename = false;
    const volume = new LocalCheckpointVolume(root, {
      renameFile: async (source, destination) => {
        if (failManifestRename && destination.endsWith("checkpoint.json")) {
          throw new Error("injected manifest write failure");
        }
        await rename(source, destination);
      },
    });
    const firstInput = checkpointInput();
    await volume.checkpoint(firstInput);
    failManifestRename = true;

    await expect(
      volume.checkpoint(
        checkpointInput({
          checkpointedAt: new Date("2026-07-12T02:03:04.000Z"),
          transcript: '{"role":"assistant","content":"changed"}\n',
          snapshot: { ...firstInput.snapshot, sessionSummary: "changed but not committed" },
        }),
      ),
    ).rejects.toThrow("injected manifest write failure");

    const restored = await volume.restore(identity);
    expect(restored?.checkpointedAt).toEqual(firstInput.checkpointedAt);
    expect(restored?.state.sessionSummary).toBe(firstInput.snapshot.sessionSummary);
  });

  it("rejects a symlink substituted for the Snapshot artifact during restore", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const volume = new LocalCheckpointVolume(root);
    const receipt = await volume.checkpoint(checkpointInput());
    await rm(receipt.snapshot.path);
    const outsideSnapshot = resolve(outside, "snapshot.json");
    await writeFile(outsideSnapshot, "{}\n");
    await mkdir(dirname(receipt.snapshot.path), { recursive: true });
    await symlink(outsideSnapshot, receipt.snapshot.path);

    await expect(volume.restore(identity)).rejects.toThrow();
  });
});
