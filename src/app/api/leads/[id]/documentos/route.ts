import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { appendLeadDocumentChunk, finishLeadDocument, MAX_LEAD_DOCUMENT_BYTES, startLeadDocument } from "@/lib/lead-documents";
import { queuePortalStatus } from "@/lib/portal";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Upload of a lead's policy (apólice), in three steps like the COF documents: start (name, type and size), the pieces
 * of the file, and finish (real size and fingerprint). Anyone on the team who can open the lead may send it.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/leads/[id]/documentos">) {
  const user = await currentUser();
  if (!user) return json({ error: "Entre no CRM de novo." }, 401);
  const { id: leadId } = await ctx.params;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return json({ error: "Lead não encontrado." }, 404);
  const url = new URL(request.url);
  const step = url.searchParams.get("step");
  const id = url.searchParams.get("id") ?? "";

  if (step === "start") {
    const file = (await request.json().catch(() => ({}))) as { name?: string; mimeType?: string; size?: number };
    const started = await startLeadDocument(leadId, file, user.name);
    return "error" in started ? json(started, 400) : json(started);
  }

  const doc = await db.leadDocument.findFirst({ where: { id, leadId, sha256: null }, select: { id: true } });
  if (!doc) return json({ error: "Envio não encontrado ou já concluído." }, 404);

  if (step === "chunk") {
    const chunk = new Uint8Array(await request.arrayBuffer());
    if (!chunk.length) return json({ error: "Parte vazia." }, 400);
    if (!(await appendLeadDocumentChunk(id, leadId, chunk))) return json({ error: `Arquivo maior que ${MAX_LEAD_DOCUMENT_BYTES / 1024 / 1024} MB.` }, 400);
    return json({ ok: true });
  }

  if (step === "finish") {
    const done = await finishLeadDocument(id, leadId);
    if ("error" in done) return json(done, 400);
    await logEvent(leadId, "lead.document", user.name, `Documento da venda anexado: ${done.name}`);
    // Already won (an automation moved it): the store hears the policy was issued without waiting for another move
    const now = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: { select: { kind: true } } } });
    if (now.stage.kind === "WON") await queuePortalStatus(now).catch(() => console.error("Portal: falha ao registrar o aviso na fila."));
    return json(done);
  }

  return json({ error: "Passo inválido." }, 400);
}
