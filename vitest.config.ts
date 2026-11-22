import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mcp-relay/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    pool: "forks",
    testTimeout: 20000
  }
});

