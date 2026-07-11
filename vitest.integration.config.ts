import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
