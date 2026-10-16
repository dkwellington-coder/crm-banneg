import { currentUser } from "@/lib/auth";
import { teamAlerts } from "@/lib/alerts";

/** Polled by every open CRM screen: red badges, the pop-up, the sound and the browser notification. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Entre no CRM de novo." }, { status: 401 });
  return Response.json(await teamAlerts(), { headers: { "Cache-Control": "no-store" } });
}
