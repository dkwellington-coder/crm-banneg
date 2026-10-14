import { getHealth } from "@/lib/whatsapp";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { daysAgo } from "@/lib/time";

// Account-level problems show on every screen, so nobody finds out by reading failed messages one by one.
export async function HealthBanner() {
  await connection();
  const [health, failedJobs] = await Promise.all([
    getHealth(),
    db.job.count({ where: { status: "FAILED", finishedAt: { gte: daysAgo(1) } } }),
  ]);
  return (
    <>
      {health && (
        <div className="bg-red-600 px-4 py-2 text-sm font-medium text-white">
          WhatsApp parado: {health.message}
          {health.code ? ` (erro Meta ${health.code})` : ""}
        </div>
      )}
      {failedJobs > 0 && (
        <a href="/configuracoes#automacoes" className="block bg-amber-100 px-4 py-2 text-sm text-amber-900">
          {failedJobs} automação(ões) falharam nas últimas 24 h. Ver registro.
        </a>
      )}
    </>
  );
}
