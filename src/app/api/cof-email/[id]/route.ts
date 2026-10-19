import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";

/** The COF e-mail exactly as it went (.eml, opens in Outlook or Gmail), only for people signed in to the CRM. */
export async function GET(_request: Request, ctx: RouteContext<"/api/cof-email/[id]">) {
  if (!(await currentUser())) return new Response("Entre no CRM.", { status: 401 });
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
