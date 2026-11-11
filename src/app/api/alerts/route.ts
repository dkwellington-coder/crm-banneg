import { currentUser } from "@/lib/auth";
import { teamAlerts } from "@/lib/alerts";
import { canSee, LEAD_AREAS } from "@/lib/areas";

/** Polled by every open CRM screen: red badges, the pop-up, the sound and the browser notification. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  // Someone who opens no lead screen (Acessos) gets no lead alerts
  if (!canSee(user, LEAD_AREAS)) return Response.json({ newLeads: 0, waiting: 0, meetings: 0, items: [] }, { headers: { "Cache-Control": "no-store" } });
  return Response.json(await teamAlerts(), { headers: { "Cache-Control": "no-store" } });
}
