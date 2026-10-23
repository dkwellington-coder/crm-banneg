import type { StageKind } from "@prisma/client";
import { STAGE_KEYS } from "./plan";

/** The status of a store's referral in the Portal de indicações, as its POST /api/crm/etapa takes it. */
export type PortalStatus = "NOVO" | "EM_ATENDIMENTO" | "PROPOSTA" | "FECHADO" | "PERDIDO";

// The key of "Erro no WhatsApp" (SEND_ERROR_STAGE in messaging.ts), repeated so this file never loads the database
const SEND_ERROR_KEY = "erro_envio";
// Marks the ref of a referral's lead closed as a duplicate: never waiting for a code, still a referral's phone, and
// never telling the portal anything (the referral goes on in the lead it joined)
export const DUPLICATE_MARK = "#duplicado";
// The portal takes at most this many referrals per call
export const MAX_PORTAL_REFS = 20;
const PORTAL_REF = /^portal:[^\s#]+$/;

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * What the store sees for a lead in this stage; null when the store should hear nothing. Decided by kind and
 * key, then by name, because funnels made in the CRM ("Novo, Em contato, Proposta...") have stages without a key.
 * firstPosition is the lowest position of the stage's funnel.
 */
export function portalStatusOf(stage: { kind: StageKind; key: string | null; name: string; position: number }, firstPosition: number): PortalStatus | null {
  if (stage.kind === "WON") return "FECHADO";
  // WhatsApp never reached the contact: a technical failure, not a lost sale
  if (stage.kind === "LOST") return stage.key === SEND_ERROR_KEY ? null : "PERDIDO";
  if (stage.key === STAGE_KEYS.NEW || stage.position <= firstPosition) return "NOVO";
  if (plain(stage.name).includes("proposta")) return "PROPOSTA";
  return "EM_ATENDIMENTO";
}

/** A lead closed as a duplicate: its referral is told by the lead it joined, never by this one. */
export const closedAsDuplicate = (externalId: string | null) => !!externalId?.endsWith(DUPLICATE_MARK);

/** A stage the store reads as the end of its referral: won or lost (Erro no WhatsApp is neither). */
export const closesReferral = (stage: { kind: StageKind; key: string | null }) =>
  stage.kind === "WON" || (stage.kind === "LOST" && stage.key !== SEND_ERROR_KEY);

/**
 * What a referral that reached a closed lead (won or lost) carries on its lead.form event, written before the lead starts
 * over (referralClosure in portal.ts): the refs the lead had closed, the stageEnteredAt of that close and when it arrived.
 * Without a ref, the same record (a lead.reopened event) ends a won deal the lead left for an open stage. openedAt: the
 * stageEnteredAt of the first open stage the lead entered after it (or won stage, out of a loss), written just before
 * the move (reopenReferrals).
 */
export type ReferralClosure = { closedRefs: string[]; closedAt: string; reachedAt: string; openedAt?: string };

// The event that closes a won deal's referrals when the lead leaves it for an open stage
export const REOPENED = "lead.reopened";
// The events whose data say which referrals a lead answers for
export const REF_EVENTS = ["lead.form", REOPENED];

const closureOf = (data: unknown) => {
  const d = data as Partial<Record<keyof ReferralClosure | "ref", unknown>> | null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    ref: text(d?.ref),
    closedRefs: Array.isArray(d?.closedRefs) ? d.closedRefs.filter((r): r is string => typeof r === "string") : [],
    closedAt: text(d?.closedAt),
    reachedAt: text(d?.reachedAt),
    openedAt: text(d?.openedAt),
  };
};

/**
 * The portal referrals a lead answers for: the one that made it (externalId) and the ones that reached it later
 * (lead.form events with a ref), each once, at most MAX_PORTAL_REFS. A referral that reached the lead after it closed
 * carries the refs it found closed: those keep what the store last saw (a sale won keeps its commission, a loss its
 * reason), and only the new referral follows the lead from then on. That happens once the lead is open again, or won out
 * of a loss (enteredAt, its stageEnteredAt, reached the closure's openedAt): until then a move between closed stages (a
 * sale cancelled) still goes to the refs it closed and never to the referral that arrived after it. A won deal the lead
 * left for an open stage closes its refs the same way, with no new referral.
 */
export function portalRefs(externalId: string | null, events: { data: unknown }[], enteredAt?: string): string[] {
  const closed = new Set<string>();
  const held = new Set<string>();
  for (const e of events) {
    const c = closureOf(e.data);
    const opened = c.openedAt !== null && enteredAt !== undefined && c.openedAt <= enteredAt;
    if (c.closedAt !== null && !opened) {
      if (c.ref) held.add(c.ref);
    } else c.closedRefs.forEach((r) => closed.add(r));
  }
  const refs = new Set<string>();
  const add = (ref: unknown) => {
    if (typeof ref === "string" && PORTAL_REF.test(ref) && !closed.has(ref) && !held.has(ref) && refs.size < MAX_PORTAL_REFS) refs.add(ref);
  };
  add(externalId);
  for (const e of events) add(closureOf(e.data).ref);
  return [...refs];
}

/**
 * When the lead's current sale started: the newest close it left behind, a referral finding it closed or a won deal it
 * left for an open stage. A policy attached before it was for an earlier sale (a renewal needs its own). leaving: the
 * lead is about to leave the stage it is in, so a close it is still in counts too. null: the lead never started over.
 */
export function cycleStart(events: { data: unknown; createdAt: Date }[], enteredAt: string, leaving = false): Date | null {
  let start: Date | null = null;
  for (const e of events) {
    const c = closureOf(e.data);
    if (c.closedAt === null || (c.closedAt === enteredAt && !leaving)) continue;
    const at = c.reachedAt ? new Date(c.reachedAt) : e.createdAt;
    if (!start || at > start) start = at;
  }
  return start;
}

// The reason moveLead writes on a loss nobody explained (then the actor), and the one of a contact WhatsApp never reached
// (then Meta's error): neither a person's name nor a technical error is for the store
export const NO_REASON = "Encerrado sem motivo informado";
export const SEND_ERROR_REASON = "WhatsApp não chega neste contato";

/** The loss reason the store reads in the portal: the team's own words, a neutral one for the CRM's safety nets. */
export function storeReason(lostReason: string | null) {
  const reason = lostReason?.trim() ?? "";
  if (!reason || reason.startsWith(NO_REASON)) return NO_REASON;
  if (reason.startsWith(SEND_ERROR_REASON)) return "Não conseguimos falar com o cliente pelo WhatsApp";
  return reason;
}
