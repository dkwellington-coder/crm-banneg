import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { templateSlots } from "./rules";

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta errors that mean the whole account is blocked, not this one message.
// These go to a red banner on every screen instead of hiding inside a conversation.
const ACCOUNT_ERRORS: Record<number, string> = {
  131042: "Pagamento pendente na conta do WhatsApp Business. Regularize em business.facebook.com > Faturamento.",
  131031: "A conta do WhatsApp Business foi bloqueada pela Meta.",
  190: "O token de acesso do WhatsApp expirou. Gere um novo token permanente no Meta Business.",
  131056: "Muitas mensagens para o mesmo número em pouco tempo. Aguarde alguns minutos.",
  130429: "Limite de envio da Meta atingido. As mensagens serão reenviadas automaticamente.",
};

export type SendResult = { ok: true; id: string } | { ok: false; code?: number; error: string; accountLevel: boolean };

export function isWindowOpen(lastInboundAt: Date | null | undefined, now = new Date()) {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

export function normalizePhone(raw: string) {
  // A leading 0 is the long-distance prefix ("(061) 98765-4321"), never part of the number
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits) return "";
  // Brazilian numbers without country code
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

/**
 * A Brazilian mobile written both ways: WhatsApp still sends older numbers without the 9
 * (556187654321) while forms carry it (5561987654321). Both are the same person.
 */
export function phoneVariants(raw: string) {
  const phone = normalizePhone(raw);
  const withNine = /^55(\d{2})9(\d{8})$/.exec(phone);
  if (withNine) return [phone, `55${withNine[1]}${withNine[2]}`];
  // Without the 9 only a mobile (6 to 9) can be the same number; 2 to 5 are landlines
  const withoutNine = /^55(\d{2})([6-9]\d{7})$/.exec(phone);
  if (withoutNine) return [phone, `55${withoutNine[1]}9${withoutNine[2]}`];
  return phone ? [phone] : [];
}

/**
 * Failures that say this contact cannot get WhatsApp messages: the number has no WhatsApp, or it is
 * not a phone at all. Not account problems, and not Meta holding back a marketing message (131049).
 */
export function isContactError(code: number | null | undefined, phone: string | null) {
  if (code === 131026 || code === 131021) return true;
  // "Parameter value is not valid" on a number too short or too long to be a phone
  return code === 131009 && !/^\d{12,13}$/.test(normalizePhone(phone ?? ""));
}

/**
 * The message did not reach this person: the number can't get WhatsApp, or Meta held back the message for
 * it (131049, marketing limits per person; 130472, a Meta experiment). The other category may still go.
 */
export function isUndelivered(code: number | null | undefined, phone: string | null) {
  return isContactError(code, phone) || code === 131049 || code === 130472;
}

/** The account's (or Meta's) failure, not this contact's: the same message can go again once sending is back. */
export function isAccountFailure(code: number | null | undefined) {
  return code != null && (code in ACCOUNT_ERRORS || code === 131000);
}

export function classifyError(code: number | undefined, message: string) {
  const accountMessage = code !== undefined ? ACCOUNT_ERRORS[code] : undefined;
  return { accountLevel: !!accountMessage, friendly: accountMessage ?? message };
}

/** The number a message goes out from: the lead's own (a funnel's number) or, when null, the main one. */
export function senderId(from?: string | null) {
  return from || process.env.WHATSAPP_PHONE_NUMBER_ID;
}

async function post(body: Record<string, unknown>, from?: string | null): Promise<SendResult> {
  const phoneId = senderId(from);
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) return { ok: false, error: "WhatsApp não configurado (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN).", accountLevel: true };
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      // A Meta that hangs must not hold the whole minute's queue
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, error: `Sem resposta da Meta (${(e as Error).name === "TimeoutError" ? "demorou mais de 20 s" : (e as Error).message}).`, accountLevel: false };
  }
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { code?: number; message?: string };
  };
  if (res.ok && json.messages?.[0]?.id) {
    await clearHealth(from);
    return { ok: true, id: json.messages[0].id };
  }
  const code = json.error?.code;
  const { accountLevel, friendly } = classifyError(code, json.error?.message ?? `HTTP ${res.status}`);
  if (accountLevel) await setHealth({ code, message: friendly }, problemNumber(code, from));
  return { ok: false, code, error: friendly, accountLevel };
}

export function sendText(to: string, body: string, from?: string | null) {
  return post({ to, type: "text", text: { body, preview_url: true } }, from);
}

export type MediaKind = "video" | "document" | "image";

/** "video" for .mp4, "document" for .pdf, "image" for .jpg/.png; null for anything else. */
export function mediaKind(url: string): MediaKind | null {
  const file = url.split("?")[0];
  return /\.mp4$/i.test(file) ? "video" : /\.pdf$/i.test(file) ? "document" : /\.(jpe?g|png)$/i.test(file) ? "image" : null;
}

/**
 * Text with up to 3 tap-to-answer buttons (only inside the 24 h window), optionally with a video,
 * PDF or photo on top. Titles are cut to Meta's 20 characters.
 */
export function sendButtons(to: string, body: string, buttons: string[], header?: { kind: MediaKind; link: string; filename?: string }, from?: string | null) {
  return post({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      ...(header && { header: { type: header.kind, [header.kind]: { link: header.link, ...(header.filename && { filename: header.filename }) } } }),
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((title, i) => ({ type: "reply", reply: { id: `b${i}`, title: title.slice(0, 20) } })),
      },
    },
  }, from);
}

/** A video or PDF from a public link, with the message as its caption. */
export function sendMedia(to: string, kind: "video" | "document" | "image", link: string, caption: string, filename?: string, from?: string | null) {
  const media: Record<string, string> = { link };
  if (caption) media.caption = caption.slice(0, 1024);
  if (kind === "document" && filename) media.filename = filename;
  return post({ to, type: kind, [kind]: media }, from);
}

/** An audio already uploaded to Meta (uploadWhatsAppMedia, from the same number). Ogg Opus shows as a voice message. */
export function sendAudio(to: string, mediaId: string, from?: string | null) {
  return post({ to, type: "audio", audio: { id: mediaId } }, from);
}

export function sendTemplate(to: string, name: string, language: string, params: string[], headerUrl?: string | null, from?: string | null) {
  const kind = headerUrl ? mediaKind(headerUrl) : null;
  const components: Record<string, unknown>[] = [];
  if (kind && headerUrl) components.push({ type: "header", parameters: [{ type: kind, [kind]: { link: headerUrl } }] });
  if (params.length) components.push({ type: "body", parameters: params.map((text) => ({ type: "text", text })) });
  return post({ to, type: "template", template: { name, language: { code: language }, components } }, from);
}

// numberId: the problem is only on that one of the account's other numbers; without it, on the main number or the whole account
export type WhatsAppHealth = { code?: number; message: string; at: string; numberId?: string } | null;

// Meta's limits on one number (its throughput, the same person too often): the account's other numbers still send
const NUMBER_ERRORS = new Set([131056, 130429]);

/** The id of one of the account's other numbers; undefined for the main one (or when not known). */
const otherNumber = (id?: string | null) => (id && id !== process.env.WHATSAPP_PHONE_NUMBER_ID ? id : undefined);

/** The number a send error is limited to (a funnel's own number hitting its own limit); undefined when it stops the account. */
export function problemNumber(code: number | undefined, from?: string | null) {
  return code !== undefined && NUMBER_ERRORS.has(code) ? otherNumber(from) : undefined;
}

/**
 * Records a WhatsApp problem for the banner and the daily queues (null clears it). A problem of one of the other
 * numbers (numberId) never takes the place of one of the main number or of the whole account.
 */
export async function setHealth(problem: { code?: number; message: string } | null, numberId?: string | null) {
  const own = problem ? otherNumber(numberId) : undefined;
  if (own) {
    const current = await getHealth();
    if (current && !current.numberId) return;
  }
  const value = problem ? { ...problem, at: new Date().toISOString(), ...(own && { numberId: own }) } : null;
  await db.setting.upsert({
    where: { key: "whatsapp_health" },
    create: { key: "whatsapp_health", value: value ?? {} },
    update: { value: value ?? {} },
  });
}

/** A message went out (or arrived) from this number, null = the main one: the problem recorded for that number is over. */
export async function clearHealth(from?: string | null) {
  const current = await getHealth();
  if (current && current.numberId === otherNumber(from)) await setHealth(null);
}

export async function getHealth(): Promise<WhatsAppHealth> {
  const row = await db.setting.findUnique({ where: { key: "whatsapp_health" } });
  const v = row?.value as { message?: string } | undefined;
  return v?.message ? (row!.value as WhatsAppHealth) : null;
}

export function verifySignature(rawBody: string, header: string | null) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type InboundMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
  // Voice notes come with voice: true; both are files kept at Meta for a while
  audio?: { id: string; mime_type?: string; voice?: boolean };
  // The click-to-WhatsApp ad (or post) that opened the conversation, on its first message
  referral?: { source_type?: string; source_id?: string; source_url?: string; headline?: string; ctwa_clid?: string };
};

export type AdReferral = { campaign: string; adId: string | null; url: string | null; clickId: string | null };

/** The ad behind a message sent from a click-to-WhatsApp ad: the lead's campaign is the ad's title. */
export function adReferral(m: InboundMessage): AdReferral | null {
  const r = m.referral;
  if (r?.source_type !== "ad") return null;
  const title = r.headline?.replace(/\s+/g, " ").trim();
  return {
    campaign: `Anúncio: ${title || r.source_id || "WhatsApp"}`.slice(0, 120),
    adId: r.source_id ?? null,
    url: r.source_url ?? null,
    clickId: r.ctwa_clid ?? null,
  };
}

// Shape of the parts of the Cloud API webhook we use
export type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        // Which of our numbers got the message
        metadata?: { phone_number_id?: string; display_phone_number?: string };
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: InboundMessage[];
        statuses?: {
          id: string;
          status: "sent" | "delivered" | "read" | "failed";
          errors?: { code: number; title?: string; message?: string }[];
        }[];
      };
    }[];
  }[];
};

export function messageText(m: InboundMessage) {
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    `[${m.type} recebido]`
  );
}

// ---------- Numbers of the WhatsApp account ----------
// Templates belong to the account, so an approved template goes from any of its numbers.

export type WhatsAppNumber = { id: string; display: string; name: string | null; quality: string | null };
export type WhatsAppNumbers = { at: string; numbers: WhatsAppNumber[]; error?: string | null };
const NUMBERS_KEY = "whatsapp_numbers";

/** Every number of the WhatsApp Business account, as Meta lists them; empty without the account id or the token. */
export async function listWhatsAppNumbers(): Promise<WhatsAppNumber[]> {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return [];
  const res = await graph<{ data: { id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }[] }>(
    `${waba}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
  );
  return res.data.map((n) => ({ id: n.id, display: n.display_phone_number ?? n.id, name: n.verified_name ?? null, quality: n.quality_rating ?? null }));
}

/** The account's numbers as last read from Meta; null before the first read. */
export async function savedWhatsAppNumbers(): Promise<WhatsAppNumbers | null> {
  const row = await db.setting.findUnique({ where: { key: NUMBERS_KEY } });
  const v = row?.value as Partial<WhatsAppNumbers> | undefined;
  return v?.at ? { at: v.at, numbers: v.numbers ?? [], error: v.error ?? null } : null;
}

/**
 * Reads the account's numbers from Meta again and keeps them for the funnel and Integrações screens. Never throws:
 * without the account id or the token nothing changes, and when Meta fails the last list stays.
 */
export async function refreshWhatsAppNumbers(opts: { ifOlderThanMs?: number } = {}): Promise<WhatsAppNumbers | null> {
  try {
    const saved = await savedWhatsAppNumbers();
    if (saved && opts.ifOlderThanMs !== undefined && Date.now() - Date.parse(saved.at) < opts.ifOlderThanMs) return saved;
    if (!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || !process.env.WHATSAPP_TOKEN) return saved;
    let value: WhatsAppNumbers;
    try {
      value = { at: new Date().toISOString(), numbers: await listWhatsAppNumbers(), error: null };
    } catch (e) {
      value = { at: new Date().toISOString(), numbers: saved?.numbers ?? [], error: (e as Error).message };
    }
    await db.setting.upsert({ where: { key: NUMBERS_KEY }, create: { key: NUMBERS_KEY, value }, update: { value } });
    return value;
  } catch (e) {
    console.error(`Números do WhatsApp: falha ao atualizar a lista (${(e as Error).message}).`);
    return null;
  }
}

/** "+55 17 99999-0101" as the account's saved list has it; the id when the number is not in it. */
export async function numberDisplay(id: string) {
  const n = (await savedWhatsAppNumbers().catch(() => null))?.numbers.find((x) => x.id === id);
  return n?.display ?? id;
}

/** "o número principal" or "o número +55 17 99999-0101", for the lead's history. */
export async function numberName(id: string | null) {
  if (!id || id === process.env.WHATSAPP_PHONE_NUMBER_ID) return "o número principal";
  return `o número ${await numberDisplay(id)}`;
}

// ---------- Templates at Meta ----------

type MetaTemplate = { id: string; name: string; status: string; language: string; category?: string; rejected_reason?: string };

async function graph<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
  const token = process.env.WHATSAPP_TOKEN;
  if (!token) throw new Error("Falta o WHATSAPP_TOKEN nas variáveis do servidor.");
  const res = await fetch(`${GRAPH}/${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; error_user_msg?: string; code?: number } };
  if (!res.ok) throw new Error(json.error?.error_user_msg ?? json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

// Samples Meta's review reads in place of {{1}}, {{2}}...: the name, the SDR, the partner store and the product
const TEMPLATE_EXAMPLES = ["Maria", "Duda", "Lotus Veículos", "seguro auto"];

/**
 * Meta's template body: {{1}} is the lead's first name and {{2}} the SDR's (automations can fill more,
 * like the partner store), with examples so review can read it. A media header needs a sample Meta already holds (headerHandle).
 */
export function templateComponents(t: { body: string; buttons: string[]; headerKind?: MediaKind | null; headerHandle?: string }) {
  const example = Array.from({ length: templateSlots(t.body) }, (_, i) => TEMPLATE_EXAMPLES[i] ?? `exemplo ${i + 1}`);
  const components: Record<string, unknown>[] = [];
  if (t.headerKind && t.headerHandle) components.push({ type: "HEADER", format: t.headerKind.toUpperCase(), example: { header_handle: [t.headerHandle] } });
  components.push({ type: "BODY", text: t.body, ...(example.length && { example: { body_text: [example] } }) });
  if (t.buttons.length) components.push({ type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text: text.slice(0, 25) })) });
  return components;
}

/** Uploads a sample of a template's header (the video itself) so Meta's review can see it. */
async function uploadHeaderSample(url: string) {
  const token = process.env.WHATSAPP_TOKEN!;
  const file = await fetch(url);
  if (!file.ok) throw new Error(`Não consegui baixar o arquivo do cabeçalho (${url}): HTTP ${file.status}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const type = file.headers.get("content-type")?.split(";")[0] || "video/mp4";
  const appId = process.env.META_APP_ID || (await graph<{ id: string }>("app")).id;
  const name = encodeURIComponent(url.split("/").pop() ?? "header");
  const session = await graph<{ id: string }>(`${appId}/uploads?file_name=${name}&file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`, {
    method: "POST",
    body: {},
  });
  const res = await fetch(`${GRAPH}/${session.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_offset: "0" },
    body: bytes,
  });
  const json = (await res.json().catch(() => ({}))) as { h?: string; error?: { message?: string } };
  if (!res.ok || !json.h) throw new Error(`Envio do vídeo do cabeçalho para a Meta falhou: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json.h;
}

/** Sends every template still only in the CRM to Meta for review. */
export async function submitTemplates() {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba) throw new Error("Falta o WHATSAPP_BUSINESS_ACCOUNT_ID (ID da conta do WhatsApp Business).");
  const drafts = await db.whatsAppTemplate.findMany({ where: { status: "draft" }, orderBy: { name: "asc" } });
  const done: string[] = [];
  const failed: string[] = [];
  for (const t of drafts) {
    try {
      const headerKind = t.headerUrl ? mediaKind(t.headerUrl) : null;
      const headerHandle = headerKind && t.headerUrl ? await uploadHeaderSample(t.headerUrl) : undefined;
      const res = await graph<{ id: string; status: string }>(`${waba}/message_templates`, {
        method: "POST",
        body: {
          name: t.name,
          language: t.language,
          category: t.category,
          components: templateComponents({ body: t.body, buttons: t.buttons as string[], headerKind, headerHandle }),
        },
      });
      await db.whatsAppTemplate.update({ where: { id: t.id }, data: { status: res.status ?? "PENDING", active: res.status === "APPROVED", metaNote: null } });
      done.push(t.name);
    } catch (e) {
      await db.whatsAppTemplate.update({ where: { id: t.id }, data: { metaNote: (e as Error).message } });
      failed.push(`${t.name}: ${(e as Error).message}`);
    }
  }
  return { done, failed };
}

/** Brings each template's review result from Meta; approved ones start being used right away. */
export async function syncTemplateStatus() {
  const waba = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) return { changed: [] as string[] };
  const res = await graph<{ data: MetaTemplate[] }>(`${waba}/message_templates?fields=id,name,status,language,category,rejected_reason&limit=200`);
  const changed: string[] = [];
  for (const m of res.data) {
    const local = await db.whatsAppTemplate.findUnique({ where: { name: m.name } });
    if (!local) continue;
    // Meta may move a utility template to marketing, which it can hold back from people who never wrote
    const category = m.category ?? local.category;
    if (local.status === m.status && local.category === category) continue;
    const note = m.rejected_reason && m.rejected_reason !== "NONE" ? m.rejected_reason : null;
    await db.whatsAppTemplate.update({ where: { id: local.id }, data: { status: m.status, active: m.status === "APPROVED", metaNote: note, category } });
    changed.push(`${m.name}: ${m.status}${category !== local.category ? ` (${category})` : ""}`);
  }
  return { changed };
}
