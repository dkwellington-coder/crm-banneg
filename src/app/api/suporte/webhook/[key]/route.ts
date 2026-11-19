import { receiveSupport, type SupportPayload } from "@/lib/support";

/** Uazapi posts here every message a support number sends or receives (the key in the address says which number). */
export async function POST(request: Request, ctx: RouteContext<"/api/suporte/webhook/[key]">) {
  const { key } = await ctx.params;
  const payload = (await request.json().catch(() => null)) as SupportPayload | SupportPayload[] | null;
  if (!payload) return Response.json({ error: "corpo inválido" }, { status: 400 });
  // Some setups post a list of events at once
  for (const p of Array.isArray(payload) ? payload : [payload]) {
    const result = await receiveSupport(key, p);
    if (!result.ok) return Response.json({ error: result.reason }, { status: result.status });
  }
  return Response.json({ ok: true });
}
