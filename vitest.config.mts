import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // The test files share one database and each one starts by wiping it, so they run one at a time
  test: { include: ["tests/**/*.test.ts"], fileParallelism: false },
});
