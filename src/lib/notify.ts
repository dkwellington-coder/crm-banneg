import { CRM_URL, phoneLabel } from "./calendar";

type NoticeLead = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  source: string;
  campaign: string | null;
  qualification: unknown;
  aiSummary: string | null;
};

type NoticeMessage = { direction: string; body: string; createdAt: Date };

// What the CRM keeps in the qualification for itself (referrals), not something the lead said
const INTERNAL = /^parceiro/i;

const brasilia = (d: Date) =>
  d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/**
 * The e-mail that tells the team a lead wants a person (Wellington, 2026-11-11: the crédito list's "Quero saber mais" goes
 * to consorcios@ with a copy to him): who the lead is, how to reach it, what it answered and the lead's page in the CRM.
 */
export function leadNotice(
  lead: NoticeLead,
  opts: { pipeline: string; stage: string; messages: NoticeMessage[]; title?: string | null; request?: string | null },
) {
  const who = lead.name?.trim() || "Lead sem nome";
  const place = [lead.city, lead.state].filter(Boolean).join(" / ");
  const facts = leadFacts(lead);
  const lines = [
    `Nome: ${who}`,
    lead.phone && `WhatsApp: ${phoneLabel(lead.phone)} · https://wa.me/${lead.phone.replace(/\D/g, "")}`,
    lead.email && `E-mail: ${lead.email}`,
    place && `Cidade: ${place}`,
    `Funil: ${opts.pipeline} · etapa ${opts.stage}`,
    `Origem: ${lead.source}${lead.campaign ? ` · ${lead.campaign}` : ""}`,
  ].filter(Boolean);
  const talk = opts.messages
    .slice(-8)
    .map((m) => `${brasilia(m.createdAt)} ${m.direction === "IN" ? "Cliente" : "Banneg"}: ${m.body.replace(/\s+/g, " ").trim()}`);
  const title = opts.title?.trim() || DEFAULT_TITLE;
  const body = [
    opts.title?.trim() ? `${title}: ${who}.` : `${who} pediu para falar com um consultor.`,
    lines.join("\n"),
    opts.request?.trim() && `O que o cliente quer:\n${opts.request.trim()}`,
    facts.length && `O que o cliente informou:\n${facts.join("\n")}`,
    lead.aiSummary?.trim() && `Resumo da IA:\n${lead.aiSummary.trim()}`,
    talk.length && `Últimas mensagens:\n${talk.join("\n")}`,
    `Ficha no CRM: ${CRM_URL}/leads/${lead.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { subject: `${title}: ${who} (${opts.pipeline})`, body };
}

const DEFAULT_TITLE = "Quer falar com um consultor";

/** What the lead answered, as "campo: valor" lines (never what the CRM keeps for itself). */
function leadFacts(lead: Pick<NoticeLead, "qualification">) {
  return Object.entries((lead.qualification ?? {}) as Record<string, unknown>)
    .filter(([k, v]) => !INTERNAL.test(k) && v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
}

/**
 * The same notice for a WhatsApp group (Wellington, 2026-11-17: a quote handed to the team goes by e-mail AND to the
 * quotes group, for speed): shorter, WhatsApp's *bold*, the request first so whoever takes it sees what to quote.
 */
export function leadGroupNotice(lead: NoticeLead, opts: { pipeline: string; stage: string; messages: NoticeMessage[]; title?: string | null; request?: string | null }) {
  const who = lead.name?.trim() || "Lead sem nome";
  const place = [lead.city, lead.state].filter(Boolean).join(" / ");
  const facts = leadFacts(lead);
  const head = [
    `*${opts.title?.trim() || DEFAULT_TITLE}*`,
    "",
    `*Cliente:* ${who} (${opts.pipeline})`,
    lead.phone && `*WhatsApp:* ${phoneLabel(lead.phone)} · https://wa.me/${lead.phone.replace(/\D/g, "")}`,
    lead.email && `*E-mail:* ${lead.email}`,
    place && `*Cidade:* ${place}`,
    `*Origem:* ${lead.source}${lead.campaign ? ` · ${lead.campaign}` : ""}`,
  ].filter((l): l is string => typeof l === "string");
  const talk = opts.messages
    .slice(-4)
    .map((m) => `${brasilia(m.createdAt)} ${m.direction === "IN" ? "Cliente" : "Banneg"}: ${m.body.replace(/\s+/g, " ").trim().slice(0, 300)}`);
  return [
    head.join("\n"),
    opts.request?.trim() && `*O que o cliente quer:* ${opts.request.trim()}`,
    facts.length && `*Dados que o cliente passou:*\n${facts.join("\n")}`,
    lead.aiSummary?.trim() && `*Resumo da IA:* ${lead.aiSummary.trim()}`,
    talk.length && `*Últimas mensagens:*\n${talk.join("\n")}`,
    `*Ficha no CRM:* ${CRM_URL}/leads/${lead.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Why the AI (or a person) handed the lead over: the open "Assumir conversa: ..." task, without its prefix. */
export function handoffRequest(tasks: { title: string }[]) {
  const t = tasks.find((x) => /^assumir conversa:/i.test(x.title));
  return t ? t.title.replace(/^assumir conversa:\s*/i, "") : null;
}
