import type { Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { isClosed } from "./messaging";
import { fillVariables, type RuleConfig } from "./rules";
import { getSettings, isTestContact, messageVars } from "./settings";
import { uazapi, uazapiMissing } from "./team-alert";

/**
 * Messages from the director's own WhatsApp (Wellington, 2026-11-19): when a lead reaches "Proposta enviada", a personal
 * message 1 day later, and two more (5 and 10 days) only if the lead did not answer. The CRM speaks to Meta from the
 * company's numbers; this one goes through Uazapi, the instance connected to his personal number (the same one that
 * posts in the team's group). What went is kept in the lead's conversation as a note, so the AI never reads it as its
 * own words, and the lead's answer on that WhatsApp is read from Uazapi's history of that chat.
 */
export const PERSONAL_AUTHOR = "WhatsApp pessoal (Uazapi)";
export const PERSONAL_EVENT = "whatsapp.personal";

/** "joão pedro" → "João": the first name, as a person would write it. */
export function personalFirstName(name: string | null) {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  if (!first || /\d|@/.test(first)) return "";
  return first === first.toLowerCase() || first === first.toUpperCase() ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : first;
}

type RawMessage = { fromMe?: unknown; messageTimestamp?: unknown; timestamp?: unknown };

const millis = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
};

/**
 * Whether the chat's history (Uazapi's /message/find) has a message from the lead after `since`. null when the history
 * can't be read (no message with fromMe at all, not even the one we sent): then nobody knows, and nothing goes.
 */
export function answeredSince(raw: unknown, since: Date): boolean | null {
  const obj = raw as { messages?: unknown; data?: unknown } | null;
  const list = (Array.isArray(raw) ? raw : Array.isArray(obj?.messages) ? obj.messages : Array.isArray(obj?.data) ? obj.data : []) as RawMessage[];
  const known = list.filter((m) => m && typeof m.fromMe === "boolean");
  if (!known.length) return null;
  return known.some((m) => m.fromMe === false && millis(m.messageTimestamp ?? m.timestamp) > since.getTime());
}

/** The chat Uazapi answered the send with ("5517...@s.whatsapp.net"), else the one its number makes. */
export function chatOf(res: unknown, digits: string) {
  const r = res as { chatid?: unknown; chatId?: unknown; message?: { chatid?: unknown } } | null;
  const id = r?.chatid ?? r?.chatId ?? r?.message?.chatid;
  return typeof id === "string" && id.includes("@") ? id : `${digits}@s.whatsapp.net`;
}

const messageIdOf = (res: unknown) => {
  const r = res as { messageid?: unknown; id?: unknown; message?: { messageid?: unknown; id?: unknown } } | null;
  const id = r?.messageid ?? r?.message?.messageid ?? r?.id ?? r?.message?.id;
  return typeof id === "string" && id ? id : null;
};

/** Does a "whatsapp_pessoal" rule. Throws when Uazapi fails, so the job tries again later. */
export async function sendPersonalWhatsApp(lead: Lead, config: RuleConfig): Promise<string> {
  if (!lead.phone) return "Ignorado: lead sem telefone.";
  if (lead.whatsappOptOut) return "Ignorado: o lead pediu para não receber mensagens.";
  if (isClosed(lead)) return "Ignorado: lead encerrado.";
  const missing = uazapiMissing();
  if (missing.length) return `Ignorado: falta ${missing.join(" e ")} nas variáveis do servidor.`;
  const settings = await getSettings();
  const digits = lead.phone.replace(/\D/g, "");

  if (config.ifNoReply) {
    // The previous personal message of this stay in the stage, and whether the lead answered it anywhere
    const previous = await db.leadEvent.findFirst({
      where: { leadId: lead.id, type: PERSONAL_EVENT, createdAt: { gte: lead.stageEnteredAt } },
      orderBy: { createdAt: "desc" },
    });
    if (!previous) return "Ignorado: a mensagem pessoal anterior não foi enviada nesta etapa.";
    if (lead.lastInboundAt && lead.lastInboundAt > previous.createdAt) return "Ignorado: o lead respondeu (no WhatsApp do CRM).";
    const chatid = ((previous.data ?? {}) as { chatid?: string }).chatid ?? `${digits}@s.whatsapp.net`;
    if (!(previous.data as { simulated?: boolean } | null)?.simulated) {
      const history = await uazapi<unknown>("/message/find", { chatid, chatId: chatid, limit: 50 });
      const answered = answeredSince(history, previous.createdAt);
      if (answered === null) return "Ignorado: não consegui ler a conversa no WhatsApp pessoal para saber se o lead respondeu.";
      if (answered) return "Ignorado: o lead respondeu no WhatsApp pessoal.";
    }
  }

  const text = fillVariables(config.text ?? "", { ...messageVars(settings, lead, ""), nome: personalFirstName(lead.name) });
  if (!text) return "Ignorado: mensagem vazia.";
  const simulated = settings.testMode && !isTestContact(settings, lead.phone);
  let chatid = `${digits}@s.whatsapp.net`;
  let messageId: string | null = null;
  if (!simulated) {
    const res = await uazapi<unknown>("/send/text", { number: digits, text, linkPreview: false });
    chatid = chatOf(res, digits);
    messageId = messageIdOf(res);
  }
  await db.message.create({
    data: {
      leadId: lead.id,
      channel: "NOTE",
      direction: "OUT",
      body: `Enviada do WhatsApp pessoal:\n\n${text}`,
      author: PERSONAL_AUTHOR,
      status: simulated ? "SIMULATED" : "SENT",
      ...(messageId && { externalId: `uazapi:${messageId}` }),
    },
  });
  await logEvent(lead.id, PERSONAL_EVENT, PERSONAL_AUTHOR, simulated ? "Mensagem pessoal simulada (modo teste)." : "Mensagem enviada do WhatsApp pessoal.", {
    chatid,
    ...(messageId && { messageId }),
    ...(simulated && { simulated: true }),
  });
  return simulated ? "WhatsApp pessoal simulado (modo teste)." : "WhatsApp pessoal enviado.";
}
