import { currentUser } from "@/lib/auth";
import { canSee } from "@/lib/areas";
import { inboxVersion, supportScope } from "@/lib/support-access";

/** Polled by the support inbox: a new message or a change in the queue refreshes the list. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  if (!canSee(user, "suporte")) return Response.json({ error: "Sem acesso a esta tela." }, { status: 403 });
  const { version } = await inboxVersion((await supportScope(user)).chatWhere);
  return Response.json({ version }, { headers: { "Cache-Control": "no-store" } });
}
