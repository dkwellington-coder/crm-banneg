import type { Lead, Stage } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
import { logEvent } from "./events";
import { moveLead } from "./leads";
import { clearAlerts } from "./alerts";
import { SEND_ERROR_STAGE } from "./messaging";
import { STAGE_KEYS } from "./plan";
import { inReferralFunnel, leadPortalRefs } from "./portal";

// One line: the author is the actor on the lead's timeline
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
// Cut, not refused: the portal's own prefix ("Recado de <parceiro> no portal: ") goes on a text of up to 2000 characters,
// and a long note must not be lost for it
const cut = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);

/** What POST /api/portal/indicacao takes: what the Banneg (or the partner) did to a referral in the portal. */
export const PortalReferralInput = z
  .object({
    // The referral, as POST /api/leads got it ("portal:<id>")
    ref: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => v.startsWith("portal:"), { message: "A indicação vem como portal:<id>." }),
    // The portal's id for this notice (its outbox row): the same aviso sent again changes nothing
    aviso: z.string().trim().min(1).max(120),
    acao: z.enum(["CANCELAR", "REABRIR", "NOTA"]),
    texto: z
      .string()
      .max(8000)
      .optional()
      .transform((v) => cut(v?.trim() ?? "", 2000)),
    // The admin's name in the portal (or the partner's, for a partner's message)
    autor: z
      .string()
      .max(2000)
      .transform((v) => cut(oneLine(v), 80))
      .pipe(z.string().min(1)),
  })
  .refine((v) => v.acao === "REABRIR" || !!v.texto, { message: "Diga o motivo do cancelamento ou o texto da nota.", path: ["texto"] });
export type PortalReferral = z.infer<typeof PortalReferralInput>;

// What the team reads on the lead's timeline when the Banneg takes a cancellation back: the lead stays where it is
export const REOPENED_IN_PORTAL = "O Banneg desfez no portal o cancelamento desta indicação. Se a equipe for atender de novo, mova o lead.";

/**
 * The lead of a portal referral: the one it made (its externalId), or else the one it reached later (the newest lead.form
 * event with its ref), which is also where a referral that went on in another lead (joinReferral) is. null: no lead.
 */
export async function leadOfReferral(ref: string) {
  const own = await db.lead.findFirst({ where: { externalId: ref }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (own) return own.id;
  const filed = await db.leadEvent.findFirst({
    where: { type: "lead.form", data: { path: ["ref"], equals: ref } },
    orderBy: { createdAt: "desc" },
    select: { leadId: true },
  });
  return filed?.leadId ?? null;
}

/**
 * Why a cancelled referral leaves its lead where it is, or null when the lead goes to the lost stage: only an open lead,
 * in the funnel the store sent the client to, that answers for this referral alone. A deal won or lost stands, another
 * referral's client (a renewal, a second store) goes on, and a deal the team works in another funnel is not the store's.
 */
async function keptOpen(lead: Lead & { stage: Stage }, ref: string) {
  if (lead.stage.kind !== "OPEN") return "lead fechado";
  if (!inReferralFunnel(lead)) return "outro funil";
  const refs = await leadPortalRefs(lead);
  if (refs.length !== 1 || refs[0] !== ref) return "outras indicações";
  return null;
}

/**
 * The funnel's lost stage: the one with the "perdido" key, or else its first lost stage. Never "Erro no WhatsApp", which
 * the store never sees (the portal would hear nothing of the cancellation).
 */
async function lostStage(pipelineId: string) {
  const lost = await db.stage.findMany({ where: { pipelineId, kind: "LOST" }, orderBy: { position: "asc" } });
  return lost.find((s) => s.key === STAGE_KEYS.LOST) ?? lost.find((s) => s.key !== SEND_ERROR_STAGE.key) ?? null;
}

export type PortalReferralResult = { lead: string; repeated: boolean; moved: boolean; motivo?: string };

/**
 * Puts what the portal said of a referral on its lead's timeline, once per aviso. A cancellation also closes the lead as
 * lost, with the AI stopped and the store told (moveLead), when nobody else's deal goes with it (keptOpen). null: the
 * referral has no lead in the CRM.
 */
export async function applyPortalReferral(input: PortalReferral): Promise<PortalReferralResult | null> {
  const leadId = await leadOfReferral(input.ref);
  if (!leadId) return null;
  // Looked up across leads: the referral may have gone on in another lead since the first time (joinReferral moves only
  // its lead.form events)
  const seen = await db.leadEvent.findFirst({ where: { type: { startsWith: "portal." }, data: { path: ["aviso"], equals: input.aviso } }, select: { leadId: true } });
  if (seen) return { lead: seen.leadId, repeated: true, moved: false };
  const actor = `Portal (${input.autor})`;
  const data = { ref: input.ref, aviso: input.aviso };
  if (input.acao === "NOTA") {
    await logEvent(leadId, "portal.nota", actor, input.texto, data);
    return { lead: leadId, repeated: false, moved: false };
  }
  if (input.acao === "REABRIR") {
    await logEvent(leadId, "portal.reaberta", actor, REOPENED_IN_PORTAL, data);
    return { lead: leadId, repeated: false, moved: false };
  }
  const filed = await logEvent(leadId, "portal.cancelada", actor, `O Banneg cancelou esta indicação no portal: ${input.texto}`, data);
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const kept = await keptOpen(lead, input.ref);
  const stage = kept ? null : await lostStage(lead.pipelineId);
  if (!stage) return { lead: leadId, repeated: false, moved: false, motivo: kept ?? "funil sem etapa de perdido" };
  try {
    // As the team's own "Marcar como perdido": the reason goes to the store, the AI stops, and so does the alert
    await moveLead(lead.id, stage.id, actor, { lostReason: `Cancelada no portal: ${input.texto}`.slice(0, 500), aiPaused: true });
  } catch (e) {
    // The portal sends the notice again, which must find the move still to do: the cancellation leaves the timeline
    // unless the lead moved already
    const still = await db.lead.findUnique({ where: { id: lead.id }, select: { stageId: true } });
    if (still?.stageId === lead.stageId) await db.leadEvent.delete({ where: { id: filed.id } }).catch(() => console.error("Portal: falha ao desfazer o registro do cancelamento."));
    throw e;
  }
  await clearAlerts(lead.id);
  return { lead: leadId, repeated: false, moved: true };
}
