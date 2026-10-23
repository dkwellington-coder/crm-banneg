import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** A lead's attached document (the policy), only for people signed in to the CRM. */
export async function GET(_request: Request, ctx: RouteContext<"/api/leads/[id]/documentos/[docId]">) {
  if (!(await currentUser())) return new Response("Entre no CRM.", { status: 401 });
  const { id, docId } = await ctx.params;
  const doc = await db.leadDocument.findFirst({ where: { id: docId, leadId: id, sha256: { not: null } }, select: { name: true, mimeType: true, data: true } });
  if (!doc) return new Response("Documento não encontrado.", { status: 404 });
  return new Response(Buffer.from(doc.data), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Disposition": `attachment; filename="${doc.name.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
