import { db } from "./db";
import { logEvent } from "./events";
import { CRM_URL, phoneLabel } from "./calendar";
import { getSettings, saveSettings, type CrmSettings } from "./settings";

/**
 * Every meeting the CRM books is posted in the team's WhatsApp group (Wellington, 2026-11-12/13): client, day and time,
 * Meet link and the lead's page. Meta's official API only posts in groups for accounts with the green badge and 100K
 * messages a day, so the group is reached through Uazapi (unofficial), from a separate number that is in the group.
 * UAZAPI_URL is the instance's server (https://xxx.uazapi.com) and UAZAPI_TOKEN the instance's token.
 */
export type TeamGroup = { id: string; name: string };

export function uazapiMissing() {
  return ["UAZAPI_URL", "UAZAPI_TOKEN"].filter((k) => !process.env[k]);
}

async function uazapi<T>(path: string, body?: unknown): Promise<T> {
  const base = process.env.UAZAPI_URL?.trim().replace(/\/+$/, "");
  const token = process.env.UAZAPI_TOKEN?.trim();
  if (!base || !token) throw new Error("Falta UAZAPI_URL ou UAZAPI_TOKEN nas variáveis do servidor.");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { token, Accept: "application/json", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`Sem resposta da Uazapi (${(e as Error).name === "TimeoutError" ? "demorou mais de 20 s" : (e as Error).message}).`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`Uazapi respondeu ${res.status}: ${json.error ?? json.message ?? "erro"}`);
  return json;
}

type RawGroup = { JID?: string; jid?: string; id?: string; Name?: string; name?: string; subject?: string };

/** The groups the Uazapi number is in, by name. */
export async function listTeamGroups(): Promise<TeamGroup[]> {
  const res = await uazapi<RawGroup[] | { groups?: RawGroup[] }>("/group/list");
  const raw = Array.isArray(res) ? res : (res.groups ?? []);
  return raw
    .map((g) => ({ id: g.JID ?? g.jid ?? g.id ?? "", name: g.Name ?? g.name ?? g.subject ?? "" }))
    .filter((g) => g.id.endsWith("@g.us"))
    .map((g) => ({ ...g, name: g.name || g.id }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export async function sendToGroup(groupId: string, text: string) {
  await uazapi("/send/text", { number: groupId, text, linkPreview: false });
}

/** The group chosen on Integrações; null = no notice. */
export async function setTeamGroup(groupId: string | null) {
  if (!groupId) {
    await saveSettings({ meetingAlertGroup: null });
    return null;
  }
  const group = (await listTeamGroups()).find((g) => g.id === groupId);
  if (!group) throw new Error("Esse grupo não aparece mais no número da Uazapi.");
  await saveSettings({ meetingAlertGroup: group });
  return group;
}

export function teamGroupOn(settings: Pick<CrmSettings, "meetingAlertGroup">) {
  return !!settings.meetingAlertGroup?.id && !uazapiMissing().length;
}

const when = (d: Date) =>
  `${d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" })}, às ${d.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  })}`;

/** What the group reads (WhatsApp's *bold*): who, when, the Meet link, the lead's page and the AI's summary. */
export function teamAlertText(
  lead: { id: string; name: string | null; phone: string | null; email?: string | null; aiSummary?: string | null },
  meeting: { startsAt: Date; meetLink: string | null },
  opts: { pipeline?: string | null; actor: string; previous?: Date },
) {
  const lines = [
    opts.previous ? "*Reunião remarcada*" : "*Nova reunião marcada*",
    "",
    `*Cliente:* ${lead.name?.trim() || "sem nome"}${opts.pipeline ? ` (${opts.pipeline})` : ""}`,
    lead.phone && `*WhatsApp:* ${phoneLabel(lead.phone)} · https://wa.me/${lead.phone.replace(/\D/g, "")}`,
    lead.email && `*E-mail:* ${lead.email}`,
    `*Quando:* ${when(meeting.startsAt)} (horário de Brasília)`,
    opts.previous && `*Antes era:* ${when(opts.previous)}`,
    `*Link da reunião:* ${meeting.meetLink ?? "sem link (veja o Google Agenda)"}`,
    `*Ficha no CRM:* ${CRM_URL}/leads/${lead.id}`,
  ].filter((l): l is string => typeof l === "string");
  const summary = lead.aiSummary?.trim();
  return [lines.join("\n"), summary && `*Resumo:* ${summary}`, `${opts.previous ? "Remarcada" : "Marcada"} por ${opts.actor}.`].filter(Boolean).join("\n\n");
}

/** Posts the notice of one meeting in the group. Throws when it did not go, so the job tries again later. */
export async function sendTeamMeetingAlert(meetingId: string, actor: string, previous?: Date) {
  const settings = await getSettings();
  const group = settings.meetingAlertGroup;
  if (!group?.id) return "Nenhum grupo escolhido em Integrações.";
  const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { lead: { include: { pipeline: { select: { name: true } } } } } });
  if (!meeting || meeting.status !== "scheduled") return "Ignorado: a reunião não está mais marcada.";
  try {
    await sendToGroup(group.id, teamAlertText(meeting.lead, meeting, { pipeline: meeting.lead.pipeline.name, actor, previous }));
  } catch (e) {
    const text = `Aviso da reunião não chegou ao grupo ${group.name}: ${(e as Error).message}`;
    await logEvent(meeting.leadId, "meeting.team_alert", "CRM", text);
    throw new Error(text);
  }
  const text = `Aviso da reunião postado no grupo ${group.name} do WhatsApp.`;
  await logEvent(meeting.leadId, "meeting.team_alert", "CRM", text);
  return text;
}

/** Integrações' test button: a short message in the chosen group. */
export async function testTeamGroup() {
  const missing = uazapiMissing();
  if (missing.length) return { ok: false, message: `Falta configurar no Vercel: ${missing.join(", ")}.` };
  const group = (await getSettings()).meetingAlertGroup;
  if (!group?.id) return { ok: false, message: "Escolha o grupo e salve antes de testar." };
  try {
    await sendToGroup(group.id, "Teste do CRM do Banneg: daqui para a frente, cada reunião marcada aparece aqui com o cliente, o link do Meet e a ficha no CRM.");
    return { ok: true, message: `Mensagem de teste enviada ao grupo ${group.name}. Confira no WhatsApp.` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ---------- The day's agenda in the group ----------

const TZ_OFFSET = "-03:00";
// The day's agenda goes at this hour (Brasília), every day that has meetings
export const AGENDA_HOUR = 7;
const AGENDA_KEY = "team_agenda";

const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00${TZ_OFFSET}`).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" });

/** "2026-11-13" plus n days. */
function addDays(day: string, n: number) {
  return new Date(Date.parse(`${day}T12:00:00${TZ_OFFSET}`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Today and every day up to the n-th business day after it ("hoje e os próximos 2 dias": Friday → Fri to Tue). */
export function agendaDays(today: string, businessDays: number) {
  const days = [today];
  let left = businessDays;
  while (left > 0) {
    const next = addDays(days.at(-1)!, 1);
    days.push(next);
    const weekday = new Date(`${next}T12:00:00${TZ_OFFSET}`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left--;
  }
  return days;
}

async function meetingsOn(day: string) {
  const from = new Date(`${day}T00:00:00${TZ_OFFSET}`);
  const to = new Date(from.getTime() + 86_400_000);
  return db.meeting.findMany({
    where: { startsAt: { gte: from, lt: to }, status: { not: "canceled" } },
    orderBy: { startsAt: "asc" },
    include: { user: { select: { name: true } }, lead: { include: { pipeline: { select: { name: true } } } } },
  });
}

type AgendaMeeting = Awaited<ReturnType<typeof meetingsOn>>[number];

/** One message per day: each meeting with its time, client, WhatsApp, Meet link and the lead's page. */
export function teamAgendaText(day: string, today: string, meetings: AgendaMeeting[]) {
  const title = `*Reuniões ${day === today ? "de hoje," : "de"} ${dayLabel(day)}* (${meetings.length})`;
  const items = meetings.map((m) => {
    const time = m.startsAt.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    return [
      `*${time}* · ${m.lead.name?.trim() || "sem nome"} (${m.lead.pipeline.name})${m.user ? ` · com ${m.user.name}` : ""}`,
      m.lead.phone && `WhatsApp: ${phoneLabel(m.lead.phone)} · https://wa.me/${m.lead.phone.replace(/\D/g, "")}`,
      `Meet: ${m.meetLink ?? "sem link (veja o Google Agenda)"}`,
      `Ficha: ${CRM_URL}/leads/${m.lead.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [title, ...items].join("\n\n");
}

/** Posts the agenda of each day that has meetings; says which went. */
export async function sendTeamAgenda(days: string[], today: string) {
  const group = (await getSettings()).meetingAlertGroup;
  if (!group?.id) return { ok: false, message: "Nenhum grupo escolhido em Integrações." };
  const sent: string[] = [];
  for (const day of days) {
    const meetings = await meetingsOn(day);
    if (!meetings.length) continue;
    await sendToGroup(group.id, teamAgendaText(day, today, meetings));
    sent.push(`${dayLabel(day)}: ${meetings.length}`);
  }
  return sent.length
    ? { ok: true, message: `Agenda postada no grupo ${group.name}: ${sent.join(", ")}.` }
    : { ok: true, message: `Nenhuma reunião de ${dayLabel(days[0])} a ${dayLabel(days.at(-1)!)}: nada postado.` };
}

/** Brasília's day and hour, whatever the server's clock. */
function brClock(now: Date) {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

/**
 * Every day at AGENDA_HOUR (cron, every minute): the day's meetings in the group, once. The very first time it also
 * brings the next 2 business days (Wellington, 2026-11-13: "reenviar as reuniões do dia e as dos próximos 2 dias").
 */
export async function sendTeamAgendaIfDue(now = new Date()) {
  const { day, hour } = brClock(now);
  if (hour < AGENDA_HOUR || !teamGroupOn(await getSettings())) return null;
  const last = (await db.setting.findUnique({ where: { key: AGENDA_KEY } }))?.value as { day?: string } | undefined;
  if (last?.day === day) return null;
  // Marked first: a Uazapi that fails does not post the same agenda every minute
  const value = { day, at: now.toISOString() };
  await db.setting.upsert({ where: { key: AGENDA_KEY }, create: { key: AGENDA_KEY, value }, update: { value } });
  const days = last ? [day] : agendaDays(day, 2);
  const res = await sendTeamAgenda(days, day).catch((e: Error) => ({ ok: false, message: e.message }));
  const saved = { ...value, ...res };
  await db.setting.update({ where: { key: AGENDA_KEY }, data: { value: saved } });
  return saved;
}

/** Integrações' button: today and the next 2 business days. */
export async function sendUpcomingAgenda(now = new Date()) {
  const missing = uazapiMissing();
  if (missing.length) return { ok: false, message: `Falta configurar no Vercel: ${missing.join(", ")}.` };
  const { day } = brClock(now);
  return sendTeamAgenda(agendaDays(day, 2), day).catch((e: Error) => ({ ok: false, message: e.message }));
}
