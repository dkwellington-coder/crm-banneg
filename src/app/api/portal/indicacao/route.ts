import { bearerMatches } from "@/lib/auth";
import { applyPortalReferral, PortalReferralInput } from "@/lib/portal-referral";

/**
 * What the Banneg did to a referral in the portal, on its lead's timeline: a note (data corrected, a message to or from
 * the partner), a cancellation (which closes the lead as lost when nobody else's deal goes with it) or the cancellation
 * taken back. Only the portal's token (PORTAL_LEADS_TOKEN, CRM_TOKEN on its side). 404 lead_nao_encontrado: the referral
 * never became a lead, and sending it again changes nothing.
 */
export async function POST(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.PORTAL_LEADS_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = PortalReferralInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const result = await applyPortalReferral(parsed.data);
  if (!result) return Response.json({ error: "lead_nao_encontrado" }, { status: 404 });
  return Response.json({ ok: true, ...result });
}
