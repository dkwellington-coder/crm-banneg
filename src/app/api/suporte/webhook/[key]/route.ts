import { receiveSupport, type SupportPayload } from "@/lib/support";

/** The support WhatsApp server posts here every message a number sends or receives (the key in the address says which number). */
export async function POST(request: Request, ctx: RouteContext<"/api/suporte/webhook/[key]">) {
  const { key } = await ctx.params;
  const payload = (await request.json().catch(() => null)) as SupportPayload | SupportPayload[] | null;
  if (!payload) return Response.json({ error: "corpo inválido" }, { status: 400 });
  // The history comes as a list of messages at once
  let failed = 0;
  for (const p of Array.isArray(payload) ? payload : [payload]) {
    try {
      const result = await receiveSupport(key, p);
      if (!result.ok) return Response.json({ error: result.reason }, { status: result.status });
    } catch (e) {
      // One bad message does not hold back the others; the server sends the piece again and the good ones are not repeated
      failed++;
      console.error("Suporte: mensagem não gravada", (e as Error).message);
    }
  }
  if (failed) return Response.json({ error: `${failed} mensagem(ns) não gravada(s)` }, { status: 500 });
  return Response.json({ ok: true });
}
