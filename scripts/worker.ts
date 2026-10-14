// Runs the automations every 30 seconds. Use on a VPS (TurboCloud) with pm2 or systemd:
//   pm2 start "npm run worker" --name crm-worker
import { runDueJobs } from "../src/lib/jobs";

const INTERVAL_MS = 30_000;

async function tick() {
  try {
    const results = await runDueJobs();
    for (const r of results) console.log(new Date().toISOString(), r.ok ? "ok " : "ERR", r.type, r.result);
  } catch (e) {
    console.error(new Date().toISOString(), "worker error", e);
  }
  setTimeout(tick, INTERVAL_MS);
}

console.log("CRM worker iniciado");
void tick();
