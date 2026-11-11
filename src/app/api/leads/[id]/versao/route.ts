import { currentUser } from "@/lib/auth";
import { canSee, LEAD_AREAS } from "@/lib/areas";
import { conversationVersion } from "@/lib/inbox";

/** Polled by the open lead page: a new message or AI step shows up without F5. */
export async function GET(_request: Request, ctx: RouteContext<"/api/leads/[id]/versao">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  if (!canSee(user, LEAD_AREAS)) return Response.json({ error: "Sem acesso a esta tela." }, { status: 403 });
  const { id } = await ctx.params;
  return Response.json({ version: await conversationVersion(id) }, { headers: { "Cache-Control": "no-store" } });
}
