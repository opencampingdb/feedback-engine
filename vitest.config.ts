import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@opencampingdb/feedback": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
      "@opencampingdb/apply/decide": fileURLToPath(new URL("./packages/apply/src/decide.ts", import.meta.url)),
      "@opencampingdb/apply/review": fileURLToPath(new URL("./packages/apply/src/review.ts", import.meta.url)),
      "@opencampingdb/apply/preview": fileURLToPath(new URL("./packages/apply/src/preview.ts", import.meta.url)),
      "@opencampingdb/apply/progress-update": fileURLToPath(new URL("./packages/apply/src/progress-update.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
