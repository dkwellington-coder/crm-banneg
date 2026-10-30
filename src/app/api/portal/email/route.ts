import { bearerMatches } from "@/lib/auth";
import { PortalEmailInput, queuePortalEmail } from "@/lib/portal-email";

/**
 * The portal's notices to the team by e-mail (a store asking for an online training session), sent through the CRM's
 * mail box: the portal has none. Only the portal's token (PORTAL_LEADS_TOKEN, CRM_TOKEN on its side), and only to
 * addresses of the company's domain.
 */
export async function POST(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.PORTAL_LEADS_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = PortalEmailInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const job = await queuePortalEmail(parsed.data);
  return Response.json({ ok: true, id: job.id, repeated: job.repeated, status: job.status }, { status: job.repeated ? 200 : 202 });
}
