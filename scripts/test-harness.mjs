import { spawnSync } from "node:child_process";
// Dedicated integration harness: all persistence and network calls are mocked; no lead is contacted.
const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/meta-capi.test.ts"], { stdio: "inherit", env: { ...process.env, TEST_DATABASE_URL: "" } });
process.exit(run.status ?? 1);
