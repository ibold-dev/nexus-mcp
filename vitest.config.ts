import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@nexus/core", replacement: source("core") },
      { find: "@nexus/parser-ts", replacement: source("parser-ts") },
      { find: "@nexus/indexer", replacement: source("indexer") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
