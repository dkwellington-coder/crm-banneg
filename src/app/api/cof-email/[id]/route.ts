import { currentUser } from "@/lib/auth";
import { canSee, LEAD_AREAS } from "@/lib/areas";
import { db } from "@/lib/db";

/** The COF e-mail exactly as it went (.eml, opens in Outlook or Gmail), only for people signed in to the CRM. */
export async function GET(_request: Request, ctx: RouteContext<"/api/cof-email/[id]">) {
  const user = await currentUser();
  if (!user) return new Response("Entre no CRM.", { status: 401 });
  // Acessos: only someone who works leads (funil, conversas or agenda)
  if (!canSee(user, LEAD_AREAS)) return new Response("Sem acesso a esta tela.", { status: 403 });
  const { id } = await ctx.params;
  const d = await db.cofDelivery.findUnique({ where: { id }, select: { raw: true, sentAt: true, to: true } });
  if (!d?.raw) return new Response("Cópia não encontrada.", { status: 404 });
  const day = d.sentAt.toISOString().slice(0, 10);
  return new Response(Buffer.from(d.raw), {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="COF-${day}-${d.to.replace(/[^\w.@-]/g, "_")}.eml"`,
      "Cache-Control": "private, no-store",
    },
  });
}
