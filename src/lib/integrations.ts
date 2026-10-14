import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { SDR_MODEL } from "./sdr";
import { sendEmail } from "./email";
import { formatSlot, freeSlotsFor, googleAccessToken, googleBusy } from "./calendar";
import { getSettings } from "./settings";
import { normalizePhone, sendTemplate, sendText, submitTemplates, syncTemplateStatus } from "./whatsapp";

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
export async function receiveWhatsAppHere(): Promise<CheckResult> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return { ok: false, message: "Falta WHATSAPP_TOKEN ou WHATSAPP_BUSINESS_ACCOUNT_ID." };
  if (!process.env.WHATSAPP_VERIFY_TOKEN) return { ok: false, message: "Falta WHATSAPP_VERIFY_TOKEN." };
  try {
    await graphPost(`${waba}/subscribed_apps`, { override_callback_uri: WEBHOOK_URL, verify_token: process.env.WHATSAPP_VERIFY_TOKEN });
    const now = await whatsappWebhookTarget();
    return now.here
      ? { ok: true, message: "As mensagens do WhatsApp agora chegam neste CRM." }
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

/** Reads the number's profile from Meta without sending anything. */
export async function checkWhatsApp(): Promise<CheckResult> {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return { ok: false, message: "Faltam WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID." };
  try {
    const n = await graphGet<{ display_phone_number?: string; verified_name?: string; quality_rating?: string; messaging_limit_tier?: string }>(
      `${WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
    );
    const details = [`Qualidade: ${n.quality_rating ?? "?"}`, `Limite: ${n.messaging_limit_tier ?? "?"}`];
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
    }
    return { ok: true, message: `Conectado ao número ${n.display_phone_number} (${n.verified_name}).`, details };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Copies the templates Meta already approved into the CRM, so the 24-hour rule works without
 * typing them by hand. Purpose is guessed from the name and can be changed in Ajustes.
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
      const n = t.name.toLowerCase();
      const purpose = /lembr|remind/.test(n) ? "reminder" : /follow|retom|cobr/.test(n) ? "followup" : /boas|bem_vindo|welcome|primeir|contato/.test(n) ? "first_contact" : "reengagement";
      await db.whatsAppTemplate.upsert({
        where: { name: t.name },
        create: { name: t.name, language: t.language, body, purpose, status: "APPROVED", active: true },
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
    (await db.whatsAppTemplate.findFirst({ where: { active: true, purpose: "reengagement" }, orderBy: { name: "asc" } })) ??
    (await db.whatsAppTemplate.findFirst({ where: { active: true }, orderBy: { name: "asc" } }));
  if (!template) return { ok: false, message: `${text.error} Para números que não escreveram nas últimas 24 h é preciso um modelo aprovado: envie os modelos para a Meta.` };
  const params = template.body.includes("{{2}}") ? ["teste", "Duda"] : template.body.includes("{{1}}") ? ["teste"] : [];
  const res = await sendTemplate(phone, template.name, template.language, params);
  return res.ok
    ? { ok: true, message: `Enviado pelo modelo "${template.name}" (o número não escreveu nas últimas 24 h). Responda no celular para testar o recebimento.` }
    : { ok: false, message: res.error };
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
      return { ok: false, message: "Login do e-mail recusado. No Gmail, use uma senha de app (Conta Google > Segurança > Senhas de app), não a senha normal." };
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
    const token = await googleAccessToken();
    const details: string[] = [];
    if (token) {
      const cal = user.calendarId ?? user.email;
      const busy = await googleBusy(cal, new Date(), new Date(Date.now() + 7 * 86_400_000));
      details.push(`Agenda ${cal}: ${busy.length} compromissos nos próximos 7 dias.`);
    } else {
      details.push("Google Agenda não configurado: a IA usa só as reuniões do próprio CRM.");
    }
    const slots = await freeSlotsFor(user.id, settings.businessHours, settings.meetingMinutes);
    details.push(`Próximos horários que a IA ofereceria: ${slots.slice(0, 3).map((s) => formatSlot(s.startsAt)).join("; ") || "nenhum"}`);
    return { ok: !!token, message: token ? `Google Agenda de ${user.name} conectado.` : "Google Agenda não configurado.", details };
  } catch (e) {
    return fail(e);
  }
}
