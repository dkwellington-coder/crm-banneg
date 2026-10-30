import { bearerMatches } from "@/lib/auth";
import { portalUrl } from "@/lib/portal";
import { partnerNoticeInput, queuePartnerNotice } from "@/lib/portal-email";

/**
 * The portal's notice to a partner (a store, an affiliate or a referrer) by e-mail: the Banneg left a pendência or a
 * message for it, or cancelled one of its referrals. The CRM writes the e-mail itself and the portal sends only the
 * names and a link to one of its pages, so this is the one notice that leaves the company's domain. Only the portal's
 * token (PORTAL_LEADS_TOKEN, CRM_TOKEN on its side).
 */
export async function POST(request: Request) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.PORTAL_LEADS_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Without the portal's address no link can be checked: refused, never sent with a link nobody vouched for
  const portal = portalUrl();
  if (!portal) return Response.json({ error: "PORTAL_URL não configurado" }, { status: 422 });
  const parsed = partnerNoticeInput(portal).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const job = await queuePartnerNotice(parsed.data);
  return Response.json({ ok: true, id: job.id, repeated: job.repeated, status: job.status }, { status: job.repeated ? 200 : 202 });
}
