import { downloadCofDocument } from "@/lib/cof";

/** A document of the COF, for the lead's link. Each download goes on the lead's history. */
export async function GET(_request: Request, ctx: RouteContext<"/api/cof/[token]/doc/[docId]">) {
  const { token, docId } = await ctx.params;
  const doc = await downloadCofDocument(token, docId);
  if (!doc) return new Response("Documento não encontrado.", { status: 404 });
  return new Response(Buffer.from(doc.data), {
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Disposition": `attachment; filename="${doc.name.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
