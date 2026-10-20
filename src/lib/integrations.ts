import Anthropic from "@anthropic-ai/sdk";
import type { Lead } from "@prisma/client";
import { db } from "./db";
import { SDR_MODEL } from "./sdr";
import { sendEmail } from "./email";
import { formatSlot, freeSlotsFor, googleBusy } from "./calendar";
import { googleAgendaFor, googleConfigured } from "./google";
import { getSettings } from "./settings";
import { normalizePhone, refreshWhatsAppNumbers, savedWhatsAppNumbers, sendTemplate, sendText, submitTemplates, syncTemplateStatus } from "./whatsapp";
import { auditMetaLeads, bringMissingMetaLeads, funnelForForm, leadForms, retryMetaLeadsNow } from "./meta-leads";
import { adAccounts, syncAdSpend } from "./meta-ads";
import { forwardTarget, setWhatsAppCopy } from "./whatsapp-forward";
import { templateFor } from "./messaging";
import { transcribe } from "./audio";

export type CheckResult = { ok: boolean; message: string; details?: string[] };

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;

function fail(e: unknown): CheckResult {
  return { ok: false, message: (e as Error).message };
}

/** One tiny call to Claude: proves the key, the model name and the network. */
export async function checkAi(): Promise<CheckResult> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, message: "Falta a ANTHROPIC_API_KEY nas variáveis do servidor." };
  try {
    const started = Date.now();
    const res = await new Anthropic().messages.create({
      model: SDR_MODEL,
      max_tokens: 16,
      messages: [{ role: "user", content: "Responda apenas: ok" }],
    });
    return { ok: true, message: `IA respondendo (${res.model}, ${((Date.now() - started) / 1000).toFixed(1)} s).` };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401) return { ok: false, message: "Chave da IA inválida. Gere outra em console.anthropic.com > API Keys." };
    if (status === 402 || status === 403) return { ok: false, message: "Conta da IA sem crédito ou sem permissão. Verifique o faturamento em console.anthropic.com." };
    return fail(e);
  }
}

async function graphGet<T>(path: string): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const code = json.error?.code;
    if (code === 190) throw new Error("Token do WhatsApp expirado ou inválido. Gere um token permanente (usuário do sistema) no Meta Business.");
    throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  }
  return json;
}

const PUBLIC_URL = (process.env.PUBLIC_BASE_URL ?? "https://crm-banneg-banneg.vercel.app").replace(/\/$/, "");
export const WEBHOOK_URL = `${PUBLIC_URL}/api/whatsapp/webhook`;

async function graphPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string } };
  if (!res.ok) throw new Error(json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

/** Where Meta delivers this WhatsApp account's messages: the app's own address (old CRM) or this CRM. */
export async function whatsappWebhookTarget(): Promise<{ here: boolean; uri: string | null }> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) throw new Error("Falta WHATSAPP_TOKEN ou WHATSAPP_BUSINESS_ACCOUNT_ID.");
  const res = await graphGet<{ data: { override_callback_uri?: string }[] }>(`${waba}/subscribed_apps`);
  const uri = res.data.find((a) => a.override_callback_uri)?.override_callback_uri ?? null;
  return { here: uri === WEBHOOK_URL, uri };
}

/**
 * Makes Meta deliver the number's messages to this CRM, overriding the app's address only for
 * this WhatsApp account. Undo with giveWhatsAppBack: the app's own address (old CRM) comes back.
 */
/** Only this CRM attends: the old one stops getting a copy of each WhatsApp message (or gets it again). */
export async function switchWhatsAppCopy(off: boolean, by: string): Promise<CheckResult> {
  const before = await forwardTarget().catch(() => null);
  await setWhatsAppCopy(off, by);
  if (off)
    return {
      ok: true,
      message: before
        ? `Pronto: o atendimento fica só neste CRM. O CRM antigo (${new URL(before).host}) não recebe mais as mensagens do WhatsApp.`
        : "Pronto: o atendimento fica só neste CRM. Nenhuma cópia vai para o CRM antigo.",
    };
  const now = await forwardTarget().catch(() => null);
  return now
    ? { ok: true, message: `A cópia voltou: o CRM antigo (${new URL(now).host}) recebe de novo cada mensagem do WhatsApp.` }
    : { ok: false, message: "A cópia foi religada, mas a Meta não informou o endereço do CRM antigo." };
}

export async function receiveWhatsAppHere(): Promise<CheckResult> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return { ok: false, message: "Falta WHATSAPP_TOKEN ou WHATSAPP_BUSINESS_ACCOUNT_ID." };
  if (!process.env.WHATSAPP_VERIFY_TOKEN) return { ok: false, message: "Falta WHATSAPP_VERIFY_TOKEN." };
  try {
    await graphPost(`${waba}/subscribed_apps`, { override_callback_uri: WEBHOOK_URL, verify_token: process.env.WHATSAPP_VERIFY_TOKEN });
    const now = await whatsappWebhookTarget();
    const copy = await forwardTarget().catch(() => null);
    return now.here
      ? {
          ok: true,
          message: copy
            ? `As mensagens do WhatsApp agora chegam neste CRM, e uma cópia continua indo para o CRM antigo (${new URL(copy).host}).`
            : "As mensagens do WhatsApp agora chegam neste CRM.",
        }
      : { ok: false, message: `A Meta aceitou, mas o endereço ainda é ${now.uri ?? "o do aplicativo"}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function giveWhatsAppBack(): Promise<CheckResult> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return { ok: false, message: "Falta WHATSAPP_TOKEN ou WHATSAPP_BUSINESS_ACCOUNT_ID." };
  try {
    // Subscribing again without the override goes back to the address set in the Meta app
    await graphPost(`${waba}/subscribed_apps`, {});
    const now = await whatsappWebhookTarget();
    return now.here ? { ok: false, message: "A Meta ainda aponta para este CRM." } : { ok: true, message: "As mensagens voltaram para o endereço do aplicativo da Meta (CRM antigo)." };
  } catch (e) {
    return fail(e);
  }
}

type HealthEntity = { entity_type: string; can_send_message: string; errors?: { error_code: number; error_description: string }[] };

/**
 * Whether Meta lets this number (the main one unless another is given) send right now, without sending anything.
 * A pending payment on the WhatsApp account (error 131042 on sends) shows up here as BLOCKED with the reason.
 */
export async function whatsappSendStatus(
  id = process.env.WHATSAPP_PHONE_NUMBER_ID,
): Promise<{ canSend: boolean; problem: { code?: number; message: string } | null } | null> {
  if (!id || !process.env.WHATSAPP_TOKEN) return null;
  const res = await graphGet<{ health_status?: { can_send_message: string; entities?: HealthEntity[] } }>(`${id}?fields=health_status`);
  const health = res.health_status;
  if (!health) return null;
  const error = health.entities?.flatMap((e) => e.errors ?? [])[0];
  if (health.can_send_message === "AVAILABLE") return { canSend: true, problem: null };
  return { canSend: false, problem: { code: error?.error_code, message: error?.error_description ?? `Meta: envio ${health.can_send_message}` } };
}

/** The CRM's WhatsApp number as people dial it ("+55 11 92013-8123"), read from Meta once and kept. */
export async function whatsappNumber(): Promise<string | null> {
  const saved = await db.setting.findUnique({ where: { key: "whatsapp_number" } });
  const number = (saved?.value as { number?: string } | undefined)?.number;
  if (number) return number;
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) return null;
  const n = await graphGet<{ display_phone_number?: string }>(`${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number`).catch(() => null);
  if (!n?.display_phone_number) return null;
  const value = { number: n.display_phone_number };
  await db.setting.upsert({ where: { key: "whatsapp_number" }, create: { key: "whatsapp_number", value }, update: { value } });
  return n.display_phone_number;
}

/** The number this lead talks to us on, as people dial it: its funnel's own number, or the main one. */
export async function whatsappNumberFor(lead: Pick<Lead, "whatsappNumberId">): Promise<string | null> {
  const id = lead.whatsappNumberId;
  if (!id || id === process.env.WHATSAPP_PHONE_NUMBER_ID) return whatsappNumber();
  const saved = (await savedWhatsAppNumbers().catch(() => null))?.numbers.find((n) => n.id === id)?.display;
  if (saved) return saved;
  const n = process.env.WHATSAPP_TOKEN ? await graphGet<{ display_phone_number?: string }>(`${id}?fields=display_phone_number`).catch(() => null) : null;
  return n?.display_phone_number ?? (await whatsappNumber());
}

/** Each number of the account with the funnels that start conversations on it, read again from Meta. */
async function numberDetails() {
  const main = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const list = await refreshWhatsAppNumbers();
  const funnels = await db.pipeline.findMany({ select: { name: true, whatsappNumberId: true }, orderBy: { position: "asc" } });
  const details = (list?.numbers ?? []).map((n) => {
    const using = funnels.filter((f) => (f.whatsappNumberId ?? main) === n.id).map((f) => f.name);
    return `${n.display}${n.name ? ` (${n.name})` : ""}${n.id === main ? ", principal" : ""}: ${using.length ? `${using.length > 1 ? "funis" : "funil"} ${using.join(", ")}` : "nenhum funil"}.`;
  });
  // A funnel's own number may not be able to send yet (new number, name still in review at Meta)
  const own = new Set(funnels.flatMap((f) => (f.whatsappNumberId && f.whatsappNumberId !== main ? [f.whatsappNumberId] : [])));
  for (const id of own) {
    const display = list?.numbers.find((n) => n.id === id)?.display ?? id;
    const sending = await whatsappSendStatus(id).catch((e: Error) => ({ canSend: false, problem: { message: e.message } }));
    if (sending) details.push(sending.canSend ? `${display}: envio liberado pela Meta.` : `${display}: envio bloqueado pela Meta: ${sending.problem?.message}`);
  }
  if (list?.error) details.push(`Lista de números da Meta: ${list.error}`);
  return details;
}

/** Reads the number's profile from Meta without sending anything. */
export async function checkWhatsApp(): Promise<CheckResult> {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return { ok: false, message: "Faltam WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID." };
  try {
    const n = await graphGet<{ display_phone_number?: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string }>(
      `${WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
    );
    const details = [`Qualidade: ${n.quality_rating ?? "?"}`, `Limite: ${n.messaging_limit_tier ?? "?"}`];
    const sending = await whatsappSendStatus().catch(() => null);
    if (sending) details.unshift(sending.canSend ? "Envio liberado pela Meta." : `Envio bloqueado pela Meta: ${sending.problem?.message}`);
    if (WHATSAPP_BUSINESS_ACCOUNT_ID) {
      const t = await graphGet<{ data: { name: string; status: string }[] }>(`${WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=name,status&limit=100`);
      const approved = t.data.filter((x) => x.status === "APPROVED").length;
      details.push(`${approved} modelos aprovados na Meta`);
    }
    if (!process.env.WHATSAPP_APP_SECRET) details.push("Falta WHATSAPP_APP_SECRET: o webhook não consegue conferir a assinatura da Meta.");
    if (!process.env.WHATSAPP_VERIFY_TOKEN) details.push("Falta WHATSAPP_VERIFY_TOKEN para cadastrar o webhook.");
    if (WHATSAPP_BUSINESS_ACCOUNT_ID) {
      const target = await whatsappWebhookTarget().catch(() => null);
      if (target) details.push(target.here ? "Mensagens recebidas: neste CRM." : "Mensagens recebidas: ainda no CRM antigo.");
      const copy = await forwardTarget().catch(() => null);
      if (copy)
        details.push(
          `${target?.here ? "Uma cópia de cada mensagem continua indo" : "Quando as mensagens vierem para cá, uma cópia continua indo"} para o CRM antigo (${new URL(copy).host}).`,
        );
    }
    details.push(...(await numberDetails().catch(() => [])));
    return { ok: true, message: `Conectado ao número ${n.display_phone_number} (${n.verified_name}).`, details };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Copies the templates Meta already approved into the CRM, so automations can use them by name.
 * They come from the old CRM ("reunião confirmada", "copa desconto"...), so they are never picked on
 * their own for a use: that is for the CRM's own templates. The use can be changed in Ajustes.
 */
export async function importWhatsAppTemplates(): Promise<CheckResult> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return { ok: false, message: "Falta WHATSAPP_BUSINESS_ACCOUNT_ID (ID da conta do WhatsApp Business)." };
  try {
    type T = { name: string; status: string; language: string; components: { type: string; text?: string }[] };
    const res = await graphGet<{ data: T[] }>(`${waba}/message_templates?fields=name,status,language,components&limit=200`);
    const approved = res.data.filter((t) => t.status === "APPROVED");
    for (const t of approved) {
      const body = t.components.find((c) => c.type === "BODY")?.text ?? "";
      await db.whatsAppTemplate.upsert({
        where: { name: t.name },
        create: { name: t.name, language: t.language, body, purpose: "importado", status: "APPROVED", active: true },
        update: { language: t.language, body, status: "APPROVED", active: true, metaNote: null },
      });
    }
    return { ok: true, message: `${approved.length} modelos aprovados importados.`, details: approved.map((t) => t.name) };
  } catch (e) {
    return fail(e);
  }
}

/** Sends a real message to the person testing. Outside the 24 h window, uses an approved template. */
export async function sendWhatsAppTest(rawPhone: string): Promise<CheckResult> {
  const phone = normalizePhone(rawPhone);
  if (phone.length < 12) return { ok: false, message: "Digite o número com DDD." };
  const text = await sendText(phone, "Teste do CRM Banneg: se você recebeu esta mensagem, o WhatsApp está conectado. Responda qualquer coisa para testar o recebimento.");
  if (text.ok) return { ok: true, message: `Mensagem enviada para ${phone}. Responda no celular e veja se ela aparece em Conversas.` };
  // 131047: more than 24 h since the person last wrote to this number
  const template =
    (await templateFor("reengagement")) ?? (await db.whatsAppTemplate.findFirst({ where: { active: true }, orderBy: { name: "asc" } }));
  if (!template) return { ok: false, message: `${text.error} Para números que não escreveram nas últimas 24 h é preciso um modelo aprovado: envie os modelos para a Meta.` };
  const params = template.body.includes("{{2}}") ? ["teste", "Duda"] : template.body.includes("{{1}}") ? ["teste"] : [];
  const res = await sendTemplate(phone, template.name, template.language, params);
  return res.ok
    ? { ok: true, message: `Enviado pelo modelo "${template.name}" (o número não escreveu nas últimas 24 h). Responda no celular para testar o recebimento.` }
    : { ok: false, message: res.error };
}

/** Lists the Facebook and Instagram lead forms the CRM reads and the funnel each one feeds. */
export async function checkMetaLeads(): Promise<CheckResult> {
  try {
    const groups = await leadForms();
    const count = groups.reduce((n, g) => n + g.forms.length, 0);
    const details = groups.flatMap((g) =>
      g.forms.length ? g.forms.map((f) => `${g.page.name}: "${f.name}" entra no funil ${funnelForForm(f.name) ?? "franquias (padrão)"}`) : [`${g.page.name}: nenhum formulário ativo`],
    );
    await retryMetaLeadsNow();
    return { ok: true, message: `${count} formulários ativos. Os leads novos entram sozinhos a cada 2 minutos.`, details };
  } catch (e) {
    return fail(e);
  }
}

/** The last 30 days of every form against the CRM: how many leads came and which never got here. */
export async function checkMissingMetaLeads(): Promise<CheckResult> {
  const audit = await auditMetaLeads();
  if (audit.error) return { ok: false, message: audit.error };
  const n = audit.missing.length;
  return {
    ok: true,
    message: n
      ? `${audit.total} leads nos formulários nos últimos ${audit.days} dias: ${n} não estão no CRM.`
      : `${audit.total} leads nos formulários nos últimos ${audit.days} dias: todos estão no CRM.`,
    details: audit.noContact ? [`${audit.noContact} vieram sem telefone e sem e-mail (não dá para atender).`] : undefined,
  };
}

/** Brings into their funnels the form leads the check found missing. */
export async function bringMissingFormLeads(): Promise<CheckResult> {
  try {
    const { created, audit } = await bringMissingMetaLeads();
    const left = audit?.missing.length ?? 0;
    return {
      ok: !audit?.error,
      message: `${created} lead(s) trazido(s) para o CRM.${left ? ` Ainda faltam ${left}.` : ""}`,
    };
  } catch (e) {
    return fail(e);
  }
}

/** Reads the ad accounts and brings their spend now, instead of waiting for the next half hour. */
export async function checkMetaAds(): Promise<CheckResult> {
  try {
    const accounts = await adAccounts();
    const res = await syncAdSpend();
    if ("error" in res) return { ok: false, message: res.error ?? "Erro ao ler os anúncios." };
    return {
      ok: true,
      message: `${accounts.length} conta(s) de anúncios lida(s). O investimento por campanha aparece no Painel.`,
      details: accounts.map((a) => a.name),
    };
  } catch (e) {
    return fail(e);
  }
}

/** Sends the kit's templates to Meta for review, straight from the CRM. */
export async function submitWhatsAppTemplates(): Promise<CheckResult> {
  try {
    const { done, failed } = await submitTemplates();
    if (!done.length && !failed.length) return { ok: true, message: "Nenhum modelo aguardando envio." };
    return {
      ok: failed.length === 0,
      message: `${done.length} modelos enviados para a Meta${failed.length ? `, ${failed.length} com erro` : ""}. A análise costuma sair em minutos; o CRM confere sozinho.`,
      details: [...done, ...failed],
    };
  } catch (e) {
    return fail(e);
  }
}

/** Brings Meta's review result now instead of waiting for the automatic check. */
export async function syncWhatsAppTemplates(): Promise<CheckResult> {
  if (!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || !process.env.WHATSAPP_TOKEN)
    return { ok: false, message: "Falta WHATSAPP_TOKEN ou WHATSAPP_BUSINESS_ACCOUNT_ID." };
  try {
    const { changed } = await syncTemplateStatus();
    return { ok: true, message: changed.length ? `${changed.length} modelos mudaram de situação.` : "Nenhuma mudança desde a última conferência.", details: changed };
  } catch (e) {
    return fail(e);
  }
}

export async function sendEmailTest(to: string): Promise<CheckResult> {
  try {
    await sendEmail(to, "Teste do CRM Banneg", "Se você recebeu este e-mail, os e-mails automáticos do CRM estão funcionando.");
    return { ok: true, message: `E-mail enviado para ${to}. Confira também a caixa de spam.` };
  } catch (e) {
    const m = (e as Error).message;
    if (/535|Username and Password not accepted|Invalid login/i.test(m)) {
      const host = process.env.SMTP_HOST ?? "";
      return {
        ok: false,
        message: /gmail/i.test(host)
          ? "Login do e-mail recusado pelo Gmail. Use uma senha de app (Conta Google > Segurança > Senhas de app), não a senha normal."
          : `Login do e-mail recusado por ${host}. Confira no Vercel se SMTP_USER é o e-mail completo e SMTP_PASSWORD é a senha dessa caixa.`,
      };
    }
    return { ok: false, message: m };
  }
}

/** Reads the manager's Google agenda and shows the next times the AI would offer. */
export async function checkCalendar(userId: string): Promise<CheckResult> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, message: "Usuário não encontrado." };
  const settings = await getSettings();
  try {
    if (!googleConfigured()) {
      return { ok: false, message: "Google Agenda ainda não liberado: faltam o GOOGLE_CLIENT_ID e o GOOGLE_CLIENT_SECRET na Vercel (passo a passo nesta tela)." };
    }
    const agenda = await googleAgendaFor(user);
    if (!agenda) return { ok: false, message: "Ninguém conectou o Google ainda. Clique em \"Conectar minha Agenda Google\"." };
    const details: string[] = [];
    const busy = await googleBusy(user, new Date(), new Date(Date.now() + 7 * 86_400_000));
    details.push(
      agenda.invite
        ? `As reuniões de ${user.name} entram na agenda de ${agenda.account}, com ${user.name} convidado. ${busy.length} compromissos de ${user.name} nos próximos 7 dias.`
        : `Agenda ${agenda.account}: ${busy.length} compromissos nos próximos 7 dias.`,
    );
    const slots = await freeSlotsFor(user.id, settings.businessHours, settings.meetingMinutes);
    details.push(`Próximos horários que a IA ofereceria: ${slots.slice(0, 3).map((s) => formatSlot(s.startsAt)).join("; ") || "nenhum"}`);
    return { ok: true, message: `Google Agenda conectado (${agenda.account}).`, details };
  } catch (e) {
    return fail(e);
  }
}

/** Transcribes a 6-second sample of Wellington's video: proves the speech-to-text access the lead audios use. */
export async function checkTranscription(): Promise<CheckResult> {
  const base = process.env.PUBLIC_BASE_URL ?? "https://crm-banneg-banneg.vercel.app";
  try {
    const file = await fetch(`${base}/materiais/teste-audio.ogg`);
    if (!file.ok) throw new Error(`Não achei o áudio de teste: HTTP ${file.status}`);
    const text = await transcribe(new Uint8Array(await file.arrayBuffer()), "audio/ogg");
    return { ok: !!text, message: text ? "Transcrição de áudio funcionando." : "A transcrição voltou vazia.", details: text ? [`Teste: “${text}”`] : [] };
  } catch (e) {
    return fail(e);
  }
}
