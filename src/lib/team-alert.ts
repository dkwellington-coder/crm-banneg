import { db } from "./db";
import { logEvent } from "./events";
import { CRM_URL, phoneLabel } from "./calendar";
import { getSettings, isTestContact, type CrmSettings } from "./settings";
import { normalizePhone, phoneVariants, sendTemplate, sendText } from "./whatsapp";

/**
 * Every meeting the CRM books goes to the team's WhatsApp (Wellington, 2026-11-12): client, day and time, Meet link
 * and the lead's page. Meta only lets accounts with the green badge and 100K messages a day post in groups, so each
 * phone listed in Ajustes gets its own message from the main number. Outside the 24 h window only an approved
 * template reaches them, so this one is UTILITY with its own purpose (no lead message ever borrows it).
 */
export const TEAM_ALERT_TEMPLATE = {
  name: "banneg_aviso_reuniao_equipe",
  category: "UTILITY",
  purpose: "team_alert",
  body:
    "Nova reunião marcada pelo CRM do Banneg.\n\n" +
    "Cliente: {{1}}\nWhatsApp: {{2}}\nQuando: {{3}}, horário de Brasília\nLink da reunião: {{4}}\nFicha no CRM: {{5}}\n\n" +
    "Marcada por {{6}}. Bom atendimento!",
} as const;

/** The phones in Ajustes › "WhatsApp da equipe que recebe toda reunião", one per person, as WhatsApp numbers. */
export function teamAlertPhones(settings: Pick<CrmSettings, "meetingAlertPhones">) {
  return [...new Set((settings.meetingAlertPhones ?? []).map(normalizePhone).filter((p) => p.length >= 12))];
}

/** Whether this phone is one of the team's (with or without the 9): it gets the notices, it never becomes a lead. */
export function isTeamPhone(settings: Pick<CrmSettings, "meetingAlertPhones">, phone: string) {
  const mine = phoneVariants(phone);
  return teamAlertPhones(settings).some((p) => phoneVariants(p).some((v) => mine.includes(v)));
}

const when = (d: Date) =>
  `${d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" })}, às ${d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  })}`;

// Meta refuses a variable with line breaks, tabs or 4 spaces in a row, and an empty one
const param = (s: string | null | undefined, empty: string) => (s ?? "").replace(/\s+/g, " ").trim() || empty;

/** The six values of the template, in order; the free-text message says the same. */
export function teamAlertParams(
  lead: { id: string; name: string | null; phone: string | null },
  meeting: { startsAt: Date; meetLink: string | null },
  // previous: the time before a reschedule, said after who did it ("Wellington, remarcada de quinta-feira...")
  opts: { pipeline?: string | null; actor: string; previous?: Date },
) {
  const name = param(lead.name, "sem nome");
  return [
    opts.pipeline ? `${name} (${param(opts.pipeline, "")})` : name,
    lead.phone ? phoneLabel(lead.phone) : "sem WhatsApp",
    when(meeting.startsAt),
    param(meeting.meetLink, "sem link (veja o Google Agenda)"),
    `${CRM_URL}/leads/${lead.id}`,
    `${param(opts.actor, "CRM")}${opts.previous ? `, remarcada de ${when(opts.previous)}` : ""}`,
  ];
}

export function teamAlertText(params: string[]) {
  return params.reduce((text, value, i) => text.replace(`{{${i + 1}}}`, value), TEAM_ALERT_TEMPLATE.body as string);
}

/**
 * Sends the notice of one booked meeting to every phone on the list. Throws only when nobody got it, so the job tries
 * again later without repeating it to anyone.
 */
export async function sendTeamMeetingAlert(meetingId: string, actor: string, previous?: Date) {
  const settings = await getSettings();
  const phones = teamAlertPhones(settings);
  if (!phones.length) return { text: "Nenhum WhatsApp da equipe em Ajustes.", sent: [] as string[] };
  const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { lead: { include: { pipeline: { select: { name: true } } } } } });
  if (!meeting || meeting.status !== "scheduled") return { text: "Ignorado: a reunião não está mais marcada.", sent: [] as string[] };
  const params = teamAlertParams(meeting.lead, meeting, { pipeline: meeting.lead.pipeline.name, actor, previous });
  const template = await db.whatsAppTemplate.findFirst({ where: { name: TEAM_ALERT_TEMPLATE.name, active: true } });
  const sent: string[] = [];
  const failed: string[] = [];
  for (const phone of phones) {
    if (settings.testMode && !isTestContact(settings, phone)) {
      failed.push(`${phoneLabel(phone)} (modo teste: não enviado)`);
      continue;
    }
    // Until Meta approves the template, the plain text still reaches whoever wrote to the number in the last 24 h
    const res = template ? await sendTemplate(phone, template.name, template.language, params) : await sendText(phone, teamAlertText(params));
    if (res.ok) sent.push(phone);
    else failed.push(`${phoneLabel(phone)} (${res.error})`);
  }
  const text = [
    sent.length && `Aviso da reunião no WhatsApp da equipe: ${sent.map(phoneLabel).join(", ")}.`,
    failed.length && `Não chegou para ${failed.join(", ")}.`,
  ]
    .filter(Boolean)
    .join(" ");
  await logEvent(meeting.leadId, "meeting.team_alert", "CRM", text);
  if (!sent.length && failed.some((f) => !f.includes("modo teste"))) throw new Error(text);
  return { text, sent };
}
