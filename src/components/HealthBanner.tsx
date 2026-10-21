import { getHealth, numberDisplay } from "@/lib/whatsapp";
import { connection } from "next/server";
import { db } from "@/lib/db";
import { daysAgo } from "@/lib/time";
import { getSettings } from "@/lib/settings";

// Account-level problems show on every screen, so nobody finds out by reading failed messages one by one.
export async function HealthBanner() {
  await connection();
  const [health, failedJobs, settings] = await Promise.all([
    getHealth(),
    db.job.count({ where: { status: "FAILED", finishedAt: { gte: daysAgo(1) } } }),
    getSettings(),
  ]);
  // A problem of one of the funnels' own numbers says which number stopped
  const where = health?.numberId ? ` no número ${await numberDisplay(health.numberId)}` : "";
  return (
    <>
      {settings.testMode && (
        <a href="/integracoes" className="block bg-amber-400 px-4 py-1.5 text-center text-xs font-semibold text-amber-950">
          Modo teste: WhatsApp e e-mail só saem de verdade para os contatos de teste. Desligar em Integrações.
        </a>
      )}
      {health && (
        <div className="bg-red-600 px-4 py-2 text-sm font-medium text-white">
          WhatsApp parado{where}: {health.message}
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
