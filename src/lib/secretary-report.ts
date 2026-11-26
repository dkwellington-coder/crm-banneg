import { db } from "./db";
import { phoneLabel } from "./calendar";
import { METRICS, actualsBetween, currentPeriod, money, periodLabel, periodRange } from "./goals";
import { addDays, brClock, dayStart, whenBr } from "./secretary";

/**
 * The CRM's numbers the secretary reports when the team asks (Wellington, 2026-11-26, "Arquivos e relatórios"):
 * a short text for the chat, and the same rows as a CSV that opens in Excel (";" and a BOM, as Excel pt-BR expects).
 */
export const REPORT_KINDS = ["leads", "reunioes", "metas", "tarefas"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export type Report = { title: string; text: string; csv: string; fileName: string };

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(";")).join("\r\n");

const MEETING_STATUS: Record<string, string> = { scheduled: "Marcada", done: "Realizada", no_show: "Não compareceu", canceled: "Cancelada" };
const brDate = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
const brDateTime = (d: Date) => `${brDate(d)} ${d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}`;

/** The days asked, in Brasília: "de" to "ate" inclusive; by default the month so far. */
export function reportRange(from: string, to: string, now: Date) {
  const today = brClock(now).day;
  const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const first = day(from) ?? `${today.slice(0, 7)}-01`;
  const last = day(to) ?? today;
  const [a, b] = first <= last ? [first, last] : [last, first];
  return { start: dayStart(a), end: dayStart(addDays(b, 1)), label: a === b ? brDate(dayStart(a)) : `${brDate(new Date(`${a}T12:00:00-03:00`))} a ${brDate(new Date(`${b}T12:00:00-03:00`))}` };
}

function count<T>(items: T[], key: (t: T) => string) {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].sort((x, y) => y[1] - x[1]);
}

export async function secretaryReport(kind: string, opts: { from?: string; to?: string; now: Date; assignee?: string | null }): Promise<Report> {
  const { now } = opts;
  const range = reportRange(opts.from ?? "", opts.to ?? "", now);
  const stamp = brClock(now).day;
  if (kind === "leads") {
    const leads = await db.lead.findMany({
      where: { createdAt: { gte: range.start, lt: range.end } },
      orderBy: { createdAt: "asc" },
      take: 5000,
      select: { name: true, phone: true, email: true, city: true, state: true, source: true, campaign: true, createdAt: true, pipeline: { select: { name: true } }, stage: { select: { name: true } } },
    });
    const byFunnel = count(leads, (l) => l.pipeline.name);
    const bySource = count(leads, (l) => l.source);
    const title = `Leads novos · ${range.label}`;
    const text = [
      `*${title}*: ${leads.length}`,
      byFunnel.length ? `Por funil:\n${byFunnel.map(([k, v]) => `- ${k}: ${v}`).join("\n")}` : "",
      bySource.length ? `Por origem:\n${bySource.slice(0, 8).map(([k, v]) => `- ${k}: ${v}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const csv = toCsv([
      ["Criado em", "Nome", "WhatsApp", "E-mail", "Cidade", "UF", "Funil", "Etapa", "Origem", "Campanha"],
      ...leads.map((l) => [brDateTime(l.createdAt), l.name, l.phone && phoneLabel(l.phone), l.email, l.city, l.state, l.pipeline.name, l.stage.name, l.source, l.campaign]),
    ]);
    return { title, text, csv, fileName: `Banneg - Leads ${stamp}.csv` };
  }
  if (kind === "reunioes") {
    const meetings = await db.meeting.findMany({
      where: { startsAt: { gte: range.start, lt: range.end } },
      orderBy: { startsAt: "asc" },
      take: 2000,
      include: { lead: { select: { name: true, phone: true, pipeline: { select: { name: true } } } } },
    });
    const byStatus = count(meetings, (m) => MEETING_STATUS[m.status] ?? m.status);
    const title = `Reuniões · ${range.label}`;
    const upcoming = meetings.filter((m) => m.status === "scheduled" && m.startsAt >= now).slice(0, 10);
    const text = [
      `*${title}*: ${meetings.length}`,
      byStatus.map(([k, v]) => `- ${k}: ${v}`).join("\n"),
      upcoming.length ? `Próximas:\n${upcoming.map((m) => `- ${whenBr(m.startsAt)} · ${m.lead.name ?? "sem nome"} (${m.lead.pipeline.name})`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const csv = toCsv([
      ["Data", "Cliente", "WhatsApp", "Funil", "Situação", "Meet", "O que aconteceu"],
      ...meetings.map((m) => [brDateTime(m.startsAt), m.lead.name, m.lead.phone && phoneLabel(m.lead.phone), m.lead.pipeline.name, MEETING_STATUS[m.status] ?? m.status, m.meetLink, m.notes]),
    ]);
    return { title, text, csv, fileName: `Banneg - Reuniões ${stamp}.csv` };
  }
  if (kind === "metas") {
    const period = opts.from && /^\d{4}-\d{2}/.test(opts.from) ? opts.from.slice(0, 7) : currentPeriod(now);
    const { start, end } = periodRange(period);
    const [goals, get] = await Promise.all([db.goal.findMany({ where: { period, userId: null } }), actualsBetween(start, end)]);
    const rows = METRICS.map((m) => {
      const target = goals.find((g) => g.metric === m.key)?.target ?? 0;
      const done = get(m.key, null);
      const fmt = (v: number) => (m.money ? money(v) : String(v));
      return { label: m.label, target, done, line: `- ${m.label}: ${fmt(done)}${target ? ` de ${fmt(target)} (${Math.round((done / target) * 100)}%)` : " (sem meta)"}` };
    });
    const title = `Metas · ${periodLabel(period)}`;
    return {
      title,
      text: `*${title}*\n${rows.map((r) => r.line).join("\n")}`,
      csv: toCsv([["Meta", "Feito", "Meta do mês", "%"], ...rows.map((r) => [r.label, r.done, r.target || "", r.target ? Math.round((r.done / r.target) * 100) : ""])]),
      fileName: `Banneg - Metas ${period}.csv`,
    };
  }
  if (kind === "tarefas") {
    const tasks = await db.secretaryTask.findMany({
      where: { status: "aberta", ...(opts.assignee && { OR: [{ assignee: opts.assignee }, { createdBy: opts.assignee }] }) },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: 500,
    });
    const late = tasks.filter((t) => t.dueAt && t.dueAt < now);
    const title = `Tarefas abertas · ${brDate(now)}`;
    const line = (t: (typeof tasks)[number]) => `- ${t.title}${t.assignee ? ` · ${t.assignee}` : ""}${t.dueAt ? ` · ${whenBr(t.dueAt)}` : ""}`;
    const text = [`*${title}*: ${tasks.length}${late.length ? `, ${late.length} atrasada${late.length > 1 ? "s" : ""}` : ""}`, late.length ? `Atrasadas:\n${late.slice(0, 15).map(line).join("\n")}` : "", tasks.filter((t) => !late.includes(t)).slice(0, 15).map(line).join("\n")]
      .filter(Boolean)
      .join("\n\n");
    const csv = toCsv([
      ["Tarefa", "Tipo", "Responsável", "Prazo", "Atrasada", "Pedida por", "Anotada em"],
      ...tasks.map((t) => [t.title, t.kind, t.assignee, t.dueAt && brDateTime(t.dueAt), late.includes(t) ? "sim" : "", t.createdBy, brDateTime(t.createdAt)]),
    ]);
    return { title, text, csv, fileName: `Banneg - Tarefas ${stamp}.csv` };
  }
  throw new Error(`Relatório "${kind}" não existe: use ${REPORT_KINDS.join(", ")}.`);
}
