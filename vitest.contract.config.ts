import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/contract/**/*.contract.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
