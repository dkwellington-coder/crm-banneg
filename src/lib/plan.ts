import type { LeadStatus } from "@prisma/client";
import type { SdrDecision } from "./sdr";
import type { Slot } from "./calendar";

export const STAGE_KEYS = {
  NEW: "novo",
  AI_QUALIFYING: "qualificando",
  QUALIFIED: "qualificado",
  MEETING_BOOKED: "reuniao",
  HANDED_OFF: "com_gerente",
  NURTURING: "nutricao",
  DISQUALIFIED: "descartado",
  WON: "ganho",
  LOST: "perdido",
} as const satisfies Partial<Record<LeadStatus, string>>;

// Not one the AI moves leads to: the team marks a lead who missed the meeting, it gets a message to book again
// and goes back to "Qualificado" for the AI to offer new times
export const NO_SHOW_STAGE = { key: "nao_compareceu", name: "Não compareceu" } as const;

// Stages where a person takes over one subject ("com_consorcio", "com_telemedicina"...), besides the default
// "com_gerente": the AI names one in handoffTo and the lead goes there
export const isSubjectHandoffKey = (key: string | null) => !!key && key.startsWith("com_") && key !== STAGE_KEYS.HANDED_OFF;

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

/** The subject stage the AI named for a handoff (case and accents aside), or null for the funnel's default one. */
export function subjectHandoffStage<T extends { name: string }>(d: Pick<SdrDecision, "decision" | "handoffTo">, stages: T[]) {
  if (d.decision !== "handoff" || !d.handoffTo) return null;
  return stages.find((s) => plain(s.name) === plain(d.handoffTo!)) ?? null;
}

// In the lead's qualification next to "parceiro": the id of the funnel the store referred the lead to
export const REFERRAL_FUNNEL = "parceiroFunil";

export type Plan = {
  status: LeadStatus;
  stageKey: string;
  reply: string;
  fields: Partial<{ name: string; email: string; city: string; state: string }>;
  qualification: Record<string, string>;
  slot: Slot | null;
  handoffTask: string | null;
  startNurture: boolean;
  stopAi: boolean;
};

/**
 * Turns the SDR's decision into concrete changes. Pure, so every branch is unit-tested;
 * the model only proposes, this function decides what the CRM actually does.
 */
export function planFromDecision(d: SdrDecision, slots: Slot[]): Plan {
  const { name, email, city, state, ...rest } = d.extracted;
  const fields: Plan["fields"] = {};
  if (name) fields.name = name;
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = email.toLowerCase();
  if (city) fields.city = city;
  if (state) fields.state = state;
  const qualification = Object.fromEntries(Object.entries(rest).filter(([, v]) => !!v)) as Record<string, string>;

  const base: Plan = {
    status: "AI_QUALIFYING",
    stageKey: STAGE_KEYS.AI_QUALIFYING,
    reply: d.reply.trim(),
    fields,
    qualification,
    slot: null,
    handoffTask: null,
    startNurture: false,
    stopAi: false,
  };

  switch (d.decision) {
    case "offer_meeting":
      // The times already went in the reply, so the lead is where the AI says: a lead who asks to talk goes straight to
      // the meeting, whatever the score (the stage's "sem resposta" messages would otherwise talk over the booking)
      if (slots.length === 0) return base;
      return { ...base, status: "QUALIFIED", stageKey: STAGE_KEYS.QUALIFIED };
    case "book_meeting": {
      const slot = d.slotIndex !== null ? slots[d.slotIndex] : undefined;
      if (!slot) {
        return {
          ...base,
          status: "QUALIFIED",
          stageKey: STAGE_KEYS.QUALIFIED,
          handoffTask: "Lead quis marcar reunião, mas o horário escolhido não está mais livre. Confirme um novo horário.",
        };
      }
      return { ...base, status: "MEETING_BOOKED", stageKey: STAGE_KEYS.MEETING_BOOKED, slot, stopAi: true };
    }
    case "handoff":
      return {
        ...base,
        status: "HANDED_OFF",
        stageKey: STAGE_KEYS.HANDED_OFF,
        handoffTask: `Assumir conversa: ${d.reason}`,
        stopAi: true,
      };
    case "nurture":
      return { ...base, status: "NURTURING", stageKey: STAGE_KEYS.NURTURING, startNurture: true, stopAi: true };
    case "disqualify":
      return { ...base, status: "DISQUALIFIED", stageKey: STAGE_KEYS.DISQUALIFIED, stopAi: true };
    default:
      return base;
  }
}
