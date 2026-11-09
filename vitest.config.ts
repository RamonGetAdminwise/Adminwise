import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    globalSetup: "./test/global-setup.ts",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // All test files share one Postgres; each test creates its own customer.
    fileParallelism: false,
  },
});
