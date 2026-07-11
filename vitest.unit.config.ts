import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.unit.test.ts"],
    passWithNoTests: false,
    testTimeout: 10_000,
  },
});
