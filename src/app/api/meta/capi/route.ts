import { db } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { backfillCapi, CAPI_JOB, capiStatus, runCapi, saveCapi } from "@/lib/meta-capi";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return Response.json({ error: "Origem inválida." }, { status: 403 });
  const user = await currentUser();
  if (user?.role !== "OWNER") return Response.json({ error: "Apenas o proprietário pode configurar." }, { status: 403 });
  try {
    const b = await request.json();
    if (b.action === "save") {
      await saveCapi(String(b.datasetId ?? "").trim(), String(b.token ?? "").trim());
      return Response.json({ message: "Configuração salva. O próximo processamento prepara o histórico dos últimos 30 dias e envia os eventos." });
    }
    if (b.action === "test") {
      if (!(await capiStatus()).configured) throw new Error("Salve as credenciais antes de testar.");
      await backfillCapi();
      // Sends only an existing CRM conversion, never fabricates a lead or runs messaging jobs.
      const pending = await db.job.findFirst({ where: { type: CAPI_JOB, status: "PENDING" }, orderBy: { createdAt: "desc" } });
      if (!pending) throw new Error("Nenhum evento pendente de lead Meta elegível no funil Franquias.");
      await runCapi(1, pending.id);
      const result = await db.job.findUniqueOrThrow({ where: { id: pending.id } });
      return Response.json({ message: result.status === "DONE" ? "Evento recebido pela Meta." : result.lastError ?? "Evento aguardando nova tentativa." });
    }
    if (b.action === "backfill") {
      await backfillCapi();
      return Response.json({ message: "Histórico preparado sem duplicar os leads já processados." });
    }
    return Response.json({ error: "Ação inválida." }, { status: 400 });
  } catch {
    // Never serialize exceptions that may contain a credential or a request body.
    return Response.json({ error: "Não foi possível concluir. Confira as credenciais, a configuração de criptografia e os registros de envio." }, { status: 400 });
  }
}
