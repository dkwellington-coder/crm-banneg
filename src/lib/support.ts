import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { CRM_URL } from "./calendar";

/**
 * Suporte (Wellington, 2026-11-19): the support WhatsApp numbers, each on its own Uazapi instance. Uazapi posts every
 * message the number sends or receives to /api/suporte/webhook/<key>, including what the attendant types on the
 * phone or on WhatsApp Web, so the CRM measures the work even of someone who never opens it.
 */

// ---- The instance token is stored encrypted: a copy of the database alone does not open anyone's WhatsApp
function cipherKey() {
  const secret = process.env.WA_CREDENTIAL_KEY || process.env.CRON_SECRET;
  if (!secret) throw new Error("Falta CRON_SECRET no servidor para guardar o token com segurança.");
  return createHash("sha256").update(`banneg:suporte:${secret}`).digest();
}

export function sealToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

export function openToken(sealed: string) {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

const sameText = (a: string, b: string) => {
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(a), h(b));
};

// ---- Uazapi, one instance per number
type NumberAccess = { server: string | null; token: string };

// Banneg's own WhatsApp server (gateway/ in this repo, chosen by Wellington on 2026-11-19 instead of paying Uazapi
// per number) answers the same calls; SUPPORT_WA_* point at it, and UAZAPI_* remain as the fallback
const supportServer = () => process.env.SUPPORT_WA_URL?.trim() || process.env.UAZAPI_URL?.trim() || "";
const supportAdmin = () => process.env.SUPPORT_WA_ADMIN_TOKEN?.trim() || process.env.UAZAPI_ADMIN_TOKEN?.trim() || "";

export function serverOf(n: { server: string | null }) {
  return (n.server?.trim() || supportServer()).replace(/\/+$/, "");
}

async function uazapi<T>(n: NumberAccess, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const base = serverOf(n);
  if (!base) throw new Error("Falta o endereço do servidor do WhatsApp do suporte (SUPPORT_WA_URL).");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { token: openToken(n.token), Accept: "application/json", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error(`Sem resposta do servidor do WhatsApp (${(e as Error).name === "TimeoutError" ? "demorou mais de 20 s" : (e as Error).message}).`);
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`O servidor do WhatsApp respondeu ${res.status}: ${json.error ?? json.message ?? "erro"}`);
  return json;
}

export const webhookUrl = (key: string) => `${CRM_URL}/api/suporte/webhook/${key}`;
export const newWebhookKey = () => randomBytes(24).toString("base64url");

type RawStatus = {
  instance?: { status?: string; owner?: string; profileName?: string; name?: string; reason?: string };
  status?: { connected?: boolean; jid?: string; loggedIn?: boolean } | string;
  connected?: boolean;
};

/** Is the number connected, and which phone is it. */
export function readStatus(raw: RawStatus) {
  const nested = typeof raw.status === "object" ? raw.status : undefined;
  const text = raw.instance?.status ?? (typeof raw.status === "string" ? raw.status : undefined);
  const connected = nested?.connected ?? raw.connected ?? (text ? /^(connected|open|online)$/i.test(text) : false);
  const phone = (raw.instance?.owner || nested?.jid || "").split(/[@:]/)[0].replace(/\D/g, "") || null;
  const status = connected ? "connected" : (text ?? "disconnected");
  // Our gateway also says why (the last time WhatsApp closed the connection); kept with the status so the screen shows it
  const reason = connected ? null : raw.instance?.reason || null;
  return { connected: !!connected, status, reason, saved: reason ? `${status}: ${reason}`.slice(0, 250) : status, phone, profile: raw.instance?.profileName ?? null };
}

export async function numberStatus(n: NumberAccess) {
  return readStatus(await uazapi<RawStatus>(n, "GET", "/instance/status"));
}

/** Points the instance's webhook at the CRM: every message, sent and received, except groups. */
export async function connectWebhook(n: NumberAccess & { webhookKey: string }) {
  await uazapi(n, "POST", "/webhook", {
    enabled: true,
    url: webhookUrl(n.webhookKey),
    events: ["messages", "connection"],
    excludeMessages: ["isGroupYes"],
  });
}

// ---- Connecting by QR code inside the CRM: the number's session is created with the server's admin token

export const canCreateInstances = () => !!(supportAdmin() && supportServer());

type RawInstance = { token?: string; qrcode?: string; paircode?: string; status?: string; owner?: string };

/** A new Uazapi instance for a support number; gives back its token. */
export async function createInstance(name: string, opts: { sendOnly?: boolean; groupsOnly?: boolean } = {}) {
  const base = serverOf({ server: null });
  const admin = supportAdmin();
  if (!base || !admin) throw new Error("Falta ligar o servidor do WhatsApp do suporte (SUPPORT_WA_URL e SUPPORT_WA_ADMIN_TOKEN).");
  const res = await fetch(`${base}/instance/init`, {
    method: "POST",
    headers: { admintoken: admin, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `${opts.sendOnly || opts.groupsOnly ? "" : "suporte-"}${name}`.toLowerCase().normalize("NFD").replace(/[^a-z0-9-]+/g, "-").slice(0, 40),
      systemName: "crm-banneg",
      // Only sends (the meetings group): the server keeps nothing of what the number sends or receives
      ...(opts.sendOnly && { sendOnly: true }),
      // The secretary's number: only her group and her private chats come to the CRM
      ...(opts.groupsOnly && { groupsOnly: true }),
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => {
    throw new Error(`Sem resposta do servidor do WhatsApp (${e.message}).`);
  });
  const json = (await res.json().catch(() => ({}))) as { token?: string; instance?: RawInstance; error?: string; message?: string };
  if (!res.ok) throw new Error(`O servidor do WhatsApp respondeu ${res.status}: ${json.error ?? json.message ?? "erro"}`);
  const token = json.instance?.token ?? json.token;
  if (!token) throw new Error("O servidor do WhatsApp criou o número mas não devolveu o token.");
  return token;
}

/** The QR code to read (an image), or that the number is already connected. */
export function readQr(raw: { instance?: RawInstance; qrcode?: string | { base64?: string }; base64?: string; status?: unknown; connected?: boolean }) {
  const status = readStatus(raw as RawStatus);
  const qrRaw = raw.instance?.qrcode || (typeof raw.qrcode === "string" ? raw.qrcode : raw.qrcode?.base64) || raw.base64 || "";
  const qr = qrRaw ? (qrRaw.startsWith("data:") ? qrRaw : `data:image/png;base64,${qrRaw}`) : null;
  return { connected: status.connected, phone: status.phone, qr: status.connected ? null : qr, pairCode: raw.instance?.paircode || null };
}

/** Asks Uazapi for a QR code (first call) or how the reading is going (next calls). */
export async function instanceQr(n: NumberAccess, start: boolean, fresh = false) {
  // fresh: drops the current connection and asks a new QR code (WhatsApp sends the history only to a new connection)
  const raw = start
    ? await uazapi<Parameters<typeof readQr>[0]>(n, "POST", "/instance/connect", fresh ? { fresh: true } : {})
    : await uazapi<Parameters<typeof readQr>[0]>(n, "GET", "/instance/status");
  return readQr(raw);
}

// ---- What Uazapi posts
type RawMessage = {
  chatid?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  id?: string;
  messageid?: string;
  messageTimestamp?: number;
  messageType?: string;
  mediaType?: string;
  type?: string;
  text?: string;
  content?: unknown;
  senderName?: string;
  sender_pn?: string;
  wasSentByApi?: boolean;
  reaction?: string;
  // Banneg's own server: the file that came with the message (it downloads it and tells when it is saved)
  media?: RawMedia;
  history?: boolean;
};
type RawMedia = { mimetype?: string; fileName?: string; size?: number; seconds?: number; saved?: boolean; error?: string };
type RawChat = { phone?: string; name?: string; wa_contactName?: string; wa_name?: string; wa_chatid?: string; wa_isGroup?: boolean };
export type SupportPayload = {
  EventType?: string;
  event?: string;
  message?: RawMessage;
  chat?: RawChat;
  token?: string;
  instance?: { status?: string };
  status?: string;
  state?: string;
  media?: RawMedia;
};

const MEDIA_LABEL: Record<string, string> = {
  ptt: "Áudio",
  audio: "Áudio",
  image: "Imagem",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
};

export type ParsedEvent =
  | {
      kind: "message";
      waChatId: string;
      phone: string | null;
      name: string | null;
      fromMe: boolean;
      byApi: boolean;
      externalId: string | null;
      at: Date;
      body: string;
      mediaKind: string | null;
      file: { mime: string; name: string | null; size: number | null } | null;
    }
  | { kind: "media"; waChatId: string; externalId: string; saved: boolean; size: number | null; error: string | null }
  | { kind: "connection"; status: string }
  | { kind: "ignore"; reason: string };

const digits = (v: string | undefined | null) => (v ?? "").replace(/\D/g, "");

/** Turns Uazapi's post into what the CRM keeps. Groups, reactions and empty messages are left out. */
export function parsePayload(p: SupportPayload, now = new Date()): ParsedEvent {
  const type = String(p.EventType ?? p.event ?? "").toLowerCase();
  if (type.startsWith("connection")) return { kind: "connection", status: String(p.instance?.status ?? p.status ?? p.state ?? "desconhecido") };
  if (type === "media") {
    // The server finished downloading a message's file (or WhatsApp no longer had it)
    const waChatId = p.message?.chatid || p.chat?.wa_chatid || "";
    const externalId = p.message?.messageid || p.message?.id || "";
    if (!waChatId || !externalId) return { kind: "ignore", reason: "arquivo sem mensagem" };
    return { kind: "media", waChatId, externalId, saved: !!p.media?.saved, size: Number(p.media?.size) || null, error: p.media?.error ? String(p.media.error).slice(0, 300) : null };
  }
  if (!type.startsWith("messages") || !p.message) return { kind: "ignore", reason: `evento ${type || "sem tipo"}` };
  const m = p.message;
  const waChatId = m.chatid || p.chat?.wa_chatid || "";
  if (!waChatId) return { kind: "ignore", reason: "sem chat" };
  if (m.isGroup || p.chat?.wa_isGroup || waChatId.endsWith("@g.us")) return { kind: "ignore", reason: "grupo" };
  if (waChatId.endsWith("@broadcast") || waChatId.endsWith("@newsletter")) return { kind: "ignore", reason: "status/canal" };
  if (m.type === "reaction" || /reaction/i.test(m.messageType ?? "") || m.reaction) return { kind: "ignore", reason: "reação" };

  const caption = typeof m.content === "object" && m.content ? String((m.content as { caption?: string }).caption ?? "") : "";
  const text = (m.text || (typeof m.content === "string" ? m.content : "") || caption).trim();
  const media = (m.mediaType || (m.type === "media" ? "media" : "") || (m.type === "location" || m.type === "contact" ? m.type : "")).toLowerCase() || null;
  const label = media ? `[${MEDIA_LABEL[media] ?? "Arquivo"}]` : "";
  const body = [label, text].filter(Boolean).join(" ");
  if (!body) return { kind: "ignore", reason: "mensagem vazia" };

  const ts = Number(m.messageTimestamp);
  // Uazapi sends milliseconds; seconds are accepted too. Never in the future
  const at = ts > 0 ? new Date(Math.min(ts < 1e12 ? ts * 1000 : ts, now.getTime())) : now;
  const phone = waChatId.endsWith("@s.whatsapp.net") ? digits(waChatId.split("@")[0]) : digits(p.chat?.phone) || digits(m.sender_pn) || null;
  const contactName = p.chat?.wa_contactName || p.chat?.name || p.chat?.wa_name || (!m.fromMe ? m.senderName : "") || null;
  return {
    kind: "message",
    waChatId,
    phone: phone || null,
    name: contactName,
    fromMe: !!m.fromMe,
    byApi: !!m.wasSentByApi,
    externalId: m.messageid || m.id || null,
    at,
    body,
    mediaKind: media,
    file: m.media
      ? { mime: String(m.media.mimetype || "application/octet-stream").slice(0, 120), name: m.media.fileName ? String(m.media.fileName).slice(0, 200) : null, size: Number(m.media.size) || null }
      : null,
  };
}

/** Uazapi's post for this number: keeps the message and moves the chat's queue. */
export async function receiveSupport(key: string, payload: SupportPayload) {
  const number = await db.supportNumber.findUnique({ where: { webhookKey: key }, include: { attendants: { where: { active: true } } } });
  if (!number || !number.active) return { ok: false as const, status: 404, reason: "número não encontrado" };
  // Uazapi sends the instance's token along: when it does, it must be this number's
  if (payload.token && !sameText(payload.token, openToken(number.token))) return { ok: false as const, status: 401, reason: "token diferente" };

  const event = parsePayload(payload);
  if (event.kind === "ignore") return { ok: true as const, ignored: event.reason };
  if (event.kind === "connection") {
    await db.supportNumber.update({ where: { id: number.id }, data: { status: event.status, statusAt: new Date() } });
    return { ok: true as const };
  }
  if (event.kind === "media") {
    const chat = await db.supportChat.findUnique({ where: { numberId_waChatId: { numberId: number.id, waChatId: event.waChatId } }, select: { id: true } });
    if (!chat) return { ok: true as const, ignored: "arquivo de conversa desconhecida" };
    await db.supportMessage.updateMany({
      where: { chatId: chat.id, externalId: event.externalId },
      data: event.saved
        ? { mediaStatus: "salvo", mediaError: null, ...(event.size && { mediaSize: event.size }) }
        : { mediaStatus: "erro", mediaError: event.error ?? "O WhatsApp não entregou o arquivo." },
    });
    return { ok: true as const };
  }
  const chat = await db.supportChat.upsert({
    where: { numberId_waChatId: { numberId: number.id, waChatId: event.waChatId } },
    create: { numberId: number.id, waChatId: event.waChatId, phone: event.phone, name: event.name, lastMessageAt: event.at },
    update: { ...(event.phone && { phone: event.phone }), ...(event.name && !event.fromMe && { name: event.name }) },
  });
  if (event.externalId) {
    const seen = await db.supportMessage.findUnique({ where: { chatId_externalId: { chatId: chat.id, externalId: event.externalId } } });
    // Already here: sent from the CRM (which records it as it sends) or posted twice
    if (seen) return { ok: true as const, duplicate: true };
  }
  // Typed on the phone: it is the work of the number's attendant, when the number has only one
  const only = number.attendants.length === 1 ? number.attendants[0] : null;
  const via = !event.fromMe ? "phone" : event.byApi ? "api" : "phone";
  const message = await db.supportMessage
    .create({
      data: {
        chatId: chat.id,
        direction: event.fromMe ? "OUT" : "IN",
        body: event.body,
        kind: event.mediaKind,
        via,
        author: event.fromMe ? (via === "api" ? "Automático" : (only?.name ?? number.name)) : (event.name ?? chat.name),
        attendantId: event.fromMe && via !== "api" ? (only?.id ?? null) : null,
        externalId: event.externalId,
        createdAt: event.at,
        ...(event.file && { mediaMime: event.file.mime, mediaName: event.file.name, mediaSize: event.file.size, mediaStatus: "baixando" }),
      },
    })
    .catch((e: { code?: string }) => {
      // The same message posted twice at the same moment
      if (e.code === "P2002") return null;
      throw e;
    });
  if (message) await updateChatAfter(chat.id, { at: event.at, body: event.body, fromMe: event.fromMe });
  return { ok: true as const };
}

/**
 * The list's last line and the queue: a client message starts the wait, a person's answer ends it. Worked out from
 * the messages themselves, because the history arrives out of order: an old question answered later never waits.
 */
async function updateChatAfter(chatId: string, m: { at: Date; body: string; fromMe: boolean }) {
  const chat = await db.supportChat.findUniqueOrThrow({ where: { id: chatId } });
  const newest = m.at >= chat.lastMessageAt;
  const answer = await db.supportMessage.findFirst({
    where: { chatId, direction: "OUT", via: { not: "api" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const waiting = await db.supportMessage.findFirst({
    where: { chatId, direction: "IN", ...(answer && { createdAt: { gt: answer.createdAt } }) },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  await db.supportChat.update({
    where: { id: chatId },
    data: { waitingSince: waiting?.createdAt ?? null, ...(newest && { lastMessageAt: m.at, lastBody: m.body.slice(0, 300), lastFromMe: m.fromMe }) },
  });
}

/** An answer typed in the CRM: goes out by the chat's number and stays with the name of who sent it. */
export async function sendSupportText(chatId: string, text: string, user: { id: string; name: string }) {
  const chat = await db.supportChat.findUniqueOrThrow({ where: { id: chatId }, include: { number: true } });
  const attendant = await db.supportAttendant.findUnique({ where: { userId: user.id } });
  const to = chat.phone || chat.waChatId;
  const res = await uazapi<{ messageid?: string; id?: string; key?: { id?: string } }>(chat.number, "POST", "/send/text", { number: to, text });
  const externalId = res.messageid || res.key?.id || res.id || null;
  const at = new Date();
  const data = { via: "crm", author: user.name, attendantId: attendant?.id ?? null };
  if (externalId) {
    // Uazapi may have posted it back already (as automatic): it becomes this person's message
    await db.supportMessage.upsert({
      where: { chatId_externalId: { chatId, externalId } },
      create: { chatId, direction: "OUT", body: text, externalId, createdAt: at, ...data },
      update: data,
    });
  } else {
    await db.supportMessage.create({ data: { chatId, direction: "OUT", body: text, createdAt: at, ...data } });
  }
  await updateChatAfter(chatId, { at, body: text, fromMe: true });
}

/** What the open chat compares to know a new message arrived. */
export async function supportChatVersion(chatId: string) {
  // The count catches older messages arriving from the history; "baixando" catches a file that finished downloading
  const [last, count, downloading] = await Promise.all([
    db.supportMessage.findFirst({ where: { chatId }, orderBy: { createdAt: "desc" }, select: { id: true, via: true } }),
    db.supportMessage.count({ where: { chatId } }),
    db.supportMessage.count({ where: { chatId, mediaStatus: "baixando" } }),
  ]);
  return last ? `${last.id}:${last.via}:${count}:${downloading}` : "0";
}

/** A message's file, straight from the support WhatsApp server (in parts when the browser asks, to play audio and video). */
export async function fetchSupportMedia(n: NumberAccess, externalId: string, range?: string | null) {
  const base = serverOf(n);
  if (!base) throw new Error("Falta o endereço do servidor do WhatsApp do suporte (SUPPORT_WA_URL).");
  return fetch(`${base}/media?id=${encodeURIComponent(externalId)}`, {
    headers: { token: openToken(n.token), ...(range && { range }) },
    signal: AbortSignal.timeout(60_000),
  });
}

/**
 * Run by the scheduler every 5 minutes (2026-11-23, after 4 days with no message and nobody noticing): asks the
 * WhatsApp server how each number is, so a number that fell shows red on the screen. A connected number gets its
 * webhook pointed at the CRM again, which also heals a server that lost it.
 */
export async function checkSupportNumbers() {
  const numbers = await db.supportNumber.findMany({ where: { active: true } });
  const results: { name: string; status?: string; error?: string }[] = [];
  for (const n of numbers) {
    try {
      const s = await numberStatus(n);
      if (s.connected) await connectWebhook(n);
      await db.supportNumber.update({ where: { id: n.id }, data: { status: s.saved, statusAt: new Date(), ...(s.phone && { phone: s.phone }) } });
      results.push({ name: n.name, status: s.saved });
    } catch (e) {
      const error = (e as Error).message.slice(0, 200);
      await db.supportNumber.update({ where: { id: n.id }, data: { status: `erro: ${error}`, statusAt: new Date() } });
      results.push({ name: n.name, error });
    }
  }
  const value = { at: new Date().toISOString(), results };
  await db.setting.upsert({ where: { key: "suporte_check" }, create: { key: "suporte_check", value }, update: { value } });
  return results;
}
