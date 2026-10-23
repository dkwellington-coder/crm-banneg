import type { Lead, Prisma, StageKind } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { enqueue } from "./queue";
import { hasApolice } from "./lead-documents";
import { REFERRAL_FUNNEL } from "./plan";
import {
  closedAsDuplicate,
  closesReferral,
  portalRefs,
  portalStatusOf,
  REF_EVENTS,
  REOPENED,
  storeReason,
  type PortalStatus,
  type ReferralClosure,
} from "./portal-status";

// Same secret the portal sends leads with, now also the way back (CRM_TOKEN on the portal's side)
const portalUrl = () => process.env.PORTAL_URL?.trim().replace(/\/+$/, "");
const portalToken = () => process.env.PORTAL_LEADS_TOKEN;
// A portal that hangs must not hold the cron (and the AI's replies) back for long
export const PORTAL_TIMEOUT_MS = 10_000;

/** Stage changes go to the portal only when both its address and the shared secret are set. */
export const portalSyncOn = () => !!(portalUrl() && portalToken());

/** What POST /api/crm/etapa takes. */
export type PortalBody = { refs: string[]; lead: string; status: PortalStatus; etapa: string; motivo: string | null; apolice: boolean; em: string };

/** The portal referrals this lead answers for now; none for a lead closed as another one's duplicate. */
export async function leadPortalRefs(lead: Pick<Lead, "id" | "externalId" | "stageEnteredAt">) {
  if (closedAsDuplicate(lead.externalId)) return [];
  const events = await db.leadEvent.findMany({ where: { leadId: lead.id, type: { in: REF_EVENTS } }, orderBy: { createdAt: "asc" }, select: { data: true } });
  return portalRefs(lead.externalId, events, lead.stageEnteredAt.toISOString());
}

/**
 * The store follows its referral only in the funnel it sent the client to (as the AI speaks for it only there): a deal
 * the team works in another funnel (life insurance, a franchise) is not the store's sale, nor its loss.
 */
export function inReferralFunnel(lead: Pick<Lead, "pipelineId" | "qualification">) {
  const funnel = (lead.qualification as Record<string, unknown> | null)?.[REFERRAL_FUNNEL];
  return typeof funnel !== "string" || funnel === lead.pipelineId;
}

/** The referrals whose store sees the lead's stage now: none while the lead is in another funnel. */
export async function storeRefs(lead: Pick<Lead, "id" | "externalId" | "stageEnteredAt" | "pipelineId" | "qualification">) {
  return inReferralFunnel(lead) ? leadPortalRefs(lead) : [];
}

/**
 * The notice for the lead as it is now, to its referrals (or to refs); null when the store hears nothing: no referral,
 * a stage the portal never shows (Erro no WhatsApp), or the lead in another funnel.
 */
async function portalBody(lead: Lead, refs?: string[]): Promise<PortalBody | null> {
  if (!inReferralFunnel(lead)) return null;
  const to = refs ?? (await leadPortalRefs(lead));
  if (!to.length) return null;
  const stage = await db.stage.findUniqueOrThrow({ where: { id: lead.stageId } });
  const first = await db.stage.aggregate({ where: { pipelineId: stage.pipelineId }, _min: { position: true } });
  const status = portalStatusOf(stage, first._min.position ?? stage.position);
  if (!status) return null;
  return {
    refs: to,
    lead: lead.id,
    status,
    etapa: stage.name,
    motivo: status === "PERDIDO" ? storeReason(lead.lostReason) : null,
    apolice: await hasApolice(lead),
    em: lead.stageEnteredAt.toISOString(),
  };
}

/**
 * Taken when another referral (arriving) reaches the lead, before it may start over for it, or when a won lead reopens
 * (arriving null): null while the lead is open; when it is closed (won or lost), the referrals it had closed and that
 * close, for the arriving referral's lead.form event or the lead.reopened one (portalRefs). Their close is also queued as
 * it is now: a notice still waiting in the queue (the portal down, the sync turned on later) would otherwise go with the
 * lead's new stage, and only to the new referral. The portal takes the same close twice harmlessly (by "em"). A close in
 * another funnel was never the store's: it closes no referral.
 */
export async function referralClosure(leadId: string, arriving: string | null): Promise<ReferralClosure | null> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { stage: { select: { kind: true, key: true } } } });
  if (!lead || !closesReferral(lead.stage)) return null;
  // A lead without a ref of its own just took the arriving one as its externalId: that one is not closed
  const closedRefs = (await storeRefs(lead)).filter((ref) => ref !== arriving);
  const body = closedRefs.length && portalSyncOn() ? await portalBody(lead, closedRefs) : null;
  if (body) await enqueue("portal.status", { leadId, payload: { stageEnteredAt: body.em, body }, maxAttempts: 6 });
  return { closedRefs, closedAt: lead.stageEnteredAt.toISOString(), reachedAt: new Date().toISOString() };
}

// What a referral that found the lead closed carries on its lead.form event (ReferralClosure)
const CLOSURE_KEYS = new Set(["closedRefs", "closedAt", "reachedAt", "openedAt"]);

/**
 * Just before a lead enters an open stage from a closed one, or a won stage from a lost one (moveLead), at enteredAt.
 * A won deal ends for the referrals that followed it: they keep the sale, and its close is queued as it is now (as in
 * referralClosure). The referrals that reached the lead while it was closed start following it: out of a loss, the next
 * Ganho is their sale. Both count once the lead's stageEnteredAt is enteredAt (portalRefs), so a notice running
 * meanwhile still sees the lead as it was. undone: a person said the won sale the lead leaves did not happen, so nothing
 * closes; its referrals keep following, and the ones that found it won follow as if it had stayed open (their close
 * dropped, so it neither ends the sale's referrals nor starts a new sale for the policy).
 */
export async function reopenReferrals(lead: { id: string; stage: { kind: StageKind } }, enteredAt: Date, actor: string, undone = false) {
  const openedAt = enteredAt.toISOString();
  const closure = lead.stage.kind === "WON" && !undone ? await referralClosure(lead.id, null) : null;
  if (closure?.closedRefs.length) {
    const codes = closure.closedRefs.map((r) => r.slice(-6).toUpperCase()).join(", ");
    const which = closure.closedRefs.length === 1 ? `a indicação (pedido ${codes}) continua` : `as indicações (pedidos ${codes}) continuam`;
    await logEvent(lead.id, REOPENED, actor, `Reaberto depois do Ganho: no portal, ${which} como venda fechada.`, { ...closure, openedAt });
  }
  const forms = await db.leadEvent.findMany({ where: { leadId: lead.id, type: "lead.form" }, select: { id: true, data: true } });
  for (const f of forms) {
    const data = f.data as Prisma.JsonObject | null;
    if (typeof data?.closedAt !== "string" || typeof data.openedAt === "string") continue;
    // Undone: one still waiting found this very sale, since out of a loss the next Ganho already released it
    const next = undone ? Object.fromEntries(Object.entries(data).filter(([k]) => !CLOSURE_KEYS.has(k))) : { ...data, openedAt };
    await db.leadEvent.update({ where: { id: f.id }, data: { data: next } });
  }
}

/**
 * Queues the notice to the portal after a stage change. One job per change (no dedupe key): each one sends the
 * lead as it is when it runs, and the portal drops whatever is older than what it has (by "em").
 */
export async function queuePortalStatus(lead: Lead) {
  if (!portalSyncOn() || !inReferralFunnel(lead) || !(await leadPortalRefs(lead)).length) return null;
  return enqueue("portal.status", { leadId: lead.id, payload: { stageEnteredAt: lead.stageEnteredAt.toISOString() }, maxAttempts: 6 });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A fetch that never got an answer, in words the team reads on the lead's timeline and task. */
function unreachable(e: unknown) {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err.name === "TimeoutError" || err.name === "AbortError") return `Portal sem resposta em ${PORTAL_TIMEOUT_MS / 1000} s.`;
  return `Portal fora do ar ou inacessível (${err.cause?.code ?? err.message ?? "erro de rede"}).`;
}

/**
 * Tells the portal the lead's current stage, or sends a close queued as it was (frozen). Throws unless the portal itself
 * confirms it, so the queue tries again later.
 */
export async function sendPortalStatus(lead: Lead, frozen?: PortalBody) {
  const url = portalUrl();
  const token = portalToken();
  if (!url || !token) return "Nada a enviar ao portal: PORTAL_URL ou PORTAL_LEADS_TOKEN não configurado.";
  const body = frozen ?? (await portalBody(lead));
  if (!body) return "Nada a enviar ao portal";
  let res: Response;
  try {
    res = await fetch(`${url}/api/crm/etapa`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // A redirect would turn the POST into a GET somewhere else: a wrong PORTAL_URL shows as an error instead
      redirect: "manual",
      signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(unreachable(e));
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const to = res.headers.get("location");
    throw new Error(`Portal respondeu ${res.status}${to ? ` (redireciona para ${to.slice(0, 120)})` : ""}: ${text.slice(0, 200)}`);
  }
  const out = parseJson(text) as { ok?: unknown; atualizados?: unknown; ignorados?: unknown } | null;
  // Any other page answering 2xx (PORTAL_URL pointing elsewhere) is not the portal: the notice is not lost as delivered
  if (out?.ok !== true) throw new Error(`Portal respondeu ${res.status} sem confirmar o aviso: ${text.slice(0, 200)}`);
  const updated = typeof out.atualizados === "number" ? out.atualizados : 0;
  const ignored = Array.isArray(out.ignorados) && out.ignorados.length ? ` (ignoradas: ${out.ignorados.join(", ")})` : "";
  return `Portal atualizado: ${updated} indicação(ões)${ignored}`;
}
