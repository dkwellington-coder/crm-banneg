import { currentUser } from "@/lib/auth";
import { canSee } from "@/lib/areas";
import { supportChatVersion } from "@/lib/support";

/** Polled by the open support chat: a new message shows up without F5. */
export async function GET(_request: Request, ctx: RouteContext<"/api/suporte/[id]/versao">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  if (!canSee(user, "suporte")) return Response.json({ error: "Sem acesso a esta tela." }, { status: 403 });
  const { id } = await ctx.params;
  return Response.json({ version: await supportChatVersion(id) }, { headers: { "Cache-Control": "no-store" } });
}
