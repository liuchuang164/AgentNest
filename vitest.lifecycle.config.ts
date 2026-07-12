import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/lifecycle/**/*.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
