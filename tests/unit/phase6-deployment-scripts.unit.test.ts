import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("Phase 6 remote shell transport", () => {
  it("redirects every compose exec/run stdin away from the streamed SSH script", async () => {
    for (const relativePath of [
      "scripts/deploy/deploy.ts",
      "scripts/deploy/status.ts",
      "scripts/verify/verify.ts",
    ]) {
      const lines = (await readFile(resolve(workspaceRoot, relativePath), "utf8")).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!/compose (?:exec|run)\b/u.test(line)) {
          continue;
        }
        const command = lines.slice(index, index + 6).join("\n");
        expect(command, `${relativePath}:${(index + 1).toString()}`).toMatch(
          /(?:<(?:\/dev\/null|\s*"\$sql")|printf [^\n]+\| compose)/u,
        );
      }
    }
  });

  it("keeps Docker Official Image paths with a project-local mirror fallback", async () => {
    const deployment = await readFile(resolve(workspaceRoot, "scripts/deploy/deploy.ts"), "utf8");
    expect(deployment).toContain("node:24-bookworm-slim");
    expect(deployment).toContain("postgres:16-alpine");
    expect(deployment).toContain("docker.m.daocloud.io/library/node:24-bookworm-slim");
    expect(deployment).toContain("docker.m.daocloud.io/library/postgres:16-alpine");
    const dockerfile = await readFile(resolve(workspaceRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("RUN chown node:node /app");
    expect(dockerfile).toMatch(/USER node\s*$/u);
  });

  it("approves the stable gateway admin scope through OpenClaw's public device API", async () => {
    const configuration = await readFile(
      resolve(workspaceRoot, "scripts/deploy/configure-openclaw.ts"),
      "utf8",
    );
    expect(configuration).toContain('manifest.exports?.["./plugin-sdk/device-bootstrap"]');
    expect(configuration).toContain('callerScopes: ["operator.admin"]');
    expect(configuration).toContain("openclaw gateway call sessions.delete");
  });

  it("allows both the L0 requester and every L1 target for agent-to-agent routing", async () => {
    const configuration = await readFile(
      resolve(workspaceRoot, "scripts/deploy/configure-openclaw.ts"),
      "utf8",
    );
    expect(configuration).toContain(
      `agent_to_agent_ids=$(jq -c '["main"] + .l1AgentIds' "$payload")`,
    );
    expect(configuration).toContain(
      'openclaw config set tools.agentToAgent.allow "$agent_to_agent_ids" --strict-json',
    );
    expect(configuration).not.toContain(
      'openclaw config set tools.agentToAgent.allow "$l1_agent_ids"',
    );
  });

  it("allows workspace-scoped Skill reads only for L1 and L2 profiles", async () => {
    const configuration = await readFile(
      resolve(workspaceRoot, "scripts/deploy/configure-openclaw.ts"),
      "utf8",
    );
    expect(configuration).toContain(
      "openclaw config set tools.fs.workspaceOnly true --strict-json",
    );
    expect(configuration).toContain('allow: ["read", ...Object.keys(taskTemplate.tools)].sort()');
  });

  it("runs fresh Phase 3 evidence before lifecycle mutates the deployed profiles", async () => {
    const verification = await readFile(resolve(workspaceRoot, "scripts/verify/verify.ts"), "utf8");
    const removeStaleReport = verification.indexOf("await rm(phase3ReportPath, { force: true })");
    const phase3Call = verification.indexOf(
      "const real = runRealOpenClawVerifier()",
      removeStaleReport,
    );
    const remoteCall = verification.indexOf("const remoteResult = runRemoteScript(", phase3Call);
    expect(removeStaleReport).toBeGreaterThan(-1);
    expect(phase3Call).toBeGreaterThan(removeStaleReport);
    expect(remoteCall).toBeGreaterThan(phase3Call);
  });
});
