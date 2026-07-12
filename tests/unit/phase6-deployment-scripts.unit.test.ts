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
          /<(?:\/dev\/null|\s*"\$sql")/u,
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
});
