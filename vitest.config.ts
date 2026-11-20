import { defineConfig } from "vitest/config";

// At most 2 test processes by default (VITEST_MAX_FORKS overrides). With one fork per core
// (8 on the server) several suites load HarfBuzz, fonts and headless Chrome at once, and a 2 GB
// job was killed by the kernel out-of-memory killer (job 834).
const maxForks = Math.max(1, Number(process.env.VITEST_MAX_FORKS) || 2);

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    poolOptions: { forks: { maxForks, minForks: 1 } },
  },
});
