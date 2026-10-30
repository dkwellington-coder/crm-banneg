import { currentUser } from "@/lib/auth";
import { conversationVersion } from "@/lib/inbox";

/** Polled by the open lead page: a new message or AI step shows up without F5. */
export async function GET(_request: Request, ctx: RouteContext<"/api/leads/[id]/versao">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  const { id } = await ctx.params;
  return Response.json({ version: await conversationVersion(id) }, { headers: { "Cache-Control": "no-store" } });
}
