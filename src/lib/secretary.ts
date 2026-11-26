import { randomBytes } from "node:crypto";
import type { SecretaryTask } from "@prisma/client";
import { db } from "./db";
import { CRM_URL, phoneLabel } from "./calendar";
import { canCreateInstances, createInstance, fetchSupportMedia, instanceQr, openToken, sealToken, serverOf } from "./support";
import { transcribe } from "./audio";
import { sendEmail } from "./email";
import { phoneVariants } from "./whatsapp";

/**
 * Secretária (Wellington, 2026-11-26): "uma secretária mesmo". An AI with her own WhatsApp chip, connected by QR code on
 * Banneg's own WhatsApp server (gateway/, the Suporte one: Meta's official API does not enter groups). She sits in a group
 * with Wellington and one or two people and reads every demand there: books meetings on his Google agenda with the Meet
 * link, writes e-mails, keeps the tasks and returns with who and when, reminds and chases them in the group, posts the
 * week's list. Whoever writes to her number in private gets an answer as his secretary.
 *
 * The server only posts the chosen group and the private chats of her number (instance "groupsOnly"); her other groups
 * never leave it. What she reads and does lives in SecretaryMessage / SecretaryTask / SecretaryEmail; her setup in the
 * Setting "secretaria".
 */

// socio: Wellington and his partner (the group, everything); colaborador: the office team, who ask her in private
// (Wellington, 2026-11-26: "no grupo ela cria as demandas minha e do meu sócio, o resto ela é secretária do Banneg")
export type SecretaryRole = "socio" | "colaborador";
export type SecretaryMember = { name: string; phone: string; email: string; role?: SecretaryRole };

export const roleOf = (m: SecretaryMember | null | undefined): SecretaryRole | null => (m ? (m.role ?? "colaborador") : null);
export const ROLE_LABEL: Record<SecretaryRole, string> = { socio: "Sócio", colaborador: "Colaborador" };

export type SecretarySettings = {
  // Her instance on the WhatsApp server: token sealed (lib/support sealToken), and the key in her webhook address
  token: string | null;
  webhookKey: string | null;
  phone: string | null;
  group: { id: string; name: string } | null;
  // Banneg's team group (Wellington, 2026-11-26): she follows it quietly and acts only when someone calls her by name
  teamGroup: { id: string; name: string } | null;
  // What she calls herself in the group
  name: string;
  // What the team may call her ("Jess"): calling her by it in the team group counts as calling her
  nicknames: string[];
  members: SecretaryMember[];
  // The registration checklist she sends when asked (Wellington's "check list de cadastro")
  checklist: string;
  // Anything else Wellington wants her to know or do
  instructions: string;
  // E-mails: shown in the group first and only sent after an "ok"
  confirmEmails: boolean;
  // Monday 8h: the week's tasks and meetings; other business days 8h: the day's
  weekly: boolean;
  daily: boolean;
  // Answers whoever writes to her number in private
  privates: boolean;
  // Off: she reads nothing and answers nobody (the reminders stop too)
  active: boolean;
};

const KEY = "secretaria";

export const DEFAULT_SECRETARY: SecretarySettings = {
  token: null,
  webhookKey: null,
  phone: null,
  group: null,
  teamGroup: null,
  name: "Jessica Montenegro",
  nicknames: ["Jess"],
  members: [],
  checklist: "",
  instructions: "",
  confirmEmails: true,
  weekly: true,
  daily: true,
  privates: true,
  active: true,
};

export async function getSecretary(): Promise<SecretarySettings> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return { ...DEFAULT_SECRETARY, ...((row?.value as Partial<SecretarySettings>) ?? {}) };
}

export async function saveSecretary(patch: Partial<SecretarySettings>) {
  const value = { ...(await getSecretary()), ...patch };
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return value;
}

// ---------- Brasília time (no daylight saving since 2019) ----------

const TZ = "-03:00";
const BR = "America/Sao_Paulo";

/** "2026-11-27T10:00" (or with seconds / a date alone = 9h) read as Brasília time; null when it is not a date. */
export function parseBr(value: string | null | undefined): Date | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] ?? "09"}:${m[3] ?? "00"}:00${m[4] ?? TZ}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Brasília's calendar day, hour and weekday (0 = Sunday), whatever the server's clock. */
export function brClock(now: Date) {
  const local = new Date(now.getTime() - 3 * 3_600_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours(), minute: local.getUTCMinutes(), weekday: local.getUTCDay() };
}

export const dayStart = (day: string) => new Date(`${day}T00:00:00${TZ}`);
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00${TZ}`) + n * 86_400_000).toISOString().slice(0, 10);

/** "qui., 27/11 às 10:00" */
export function whenBr(d: Date, withTime = true) {
  const day = d.toLocaleDateString("pt-BR", { timeZone: BR, weekday: "short", day: "2-digit", month: "2-digit" });
  return withTime ? `${day} às ${d.toLocaleTimeString("pt-BR", { timeZone: BR, hour: "2-digit", minute: "2-digit" })}` : day;
}

/** "2026-11-27T10:00", what the AI reads and writes. */
export const isoBr = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 16);

const NUDGE_HOUR = 9;
// She asks about a late task at most this many times; after that it stays in the morning list as late
export const MAX_NUDGES = 3;

/** The next business day (Mon-Fri) at 9h Brasília after `from`. */
export function nextBusinessMorning(from: Date) {
  let day = brClock(from).day;
  for (;;) {
    day = addDays(day, 1);
    const weekday = new Date(`${day}T12:00:00${TZ}`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return new Date(`${day}T${String(NUDGE_HOUR).padStart(2, "0")}:00:00${TZ}`);
  }
}

/**
 * When she first asks the group about a task: at its due time (a due date alone = 9h that day), moved to the next
 * business morning when it falls at night or on a weekend. Reminders-only and tasks without a date: never.
 */
export function firstNudge(task: { kind: string; dueAt: Date | null }) {
  if (!task.dueAt || task.kind === "lembrete") return null;
  const { day, hour, weekday } = brClock(task.dueAt);
  if (weekday === 0 || weekday === 6 || hour >= 19) return nextBusinessMorning(task.dueAt);
  // Before the day starts: that same morning
  if (hour < 8) return new Date(`${day}T${String(NUDGE_HOUR).padStart(2, "0")}:00:00${TZ}`);
  return task.dueAt;
}

// ---------- People ----------

const onlyDigits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

/** The member a phone belongs to (any format: with or without 55, with or without the 9). */
export function memberByPhone(members: SecretaryMember[], phone: string | null | undefined) {
  const d = onlyDigits(phone);
  if (d.length < 8) return null;
  const mine = phoneVariants(d);
  return members.find((m) => {
    const x = onlyDigits(m.phone);
    return x.length >= 8 && (phoneVariants(x).some((v) => mine.includes(v)) || d.endsWith(x) || x.endsWith(d));
  }) ?? null;
}

/** The member a name refers to ("Odair", "@Odair", "odair bellentani"). */
export function memberByName(members: SecretaryMember[], name: string | null | undefined) {
  const n = norm(name).replace(/^@/, "");
  if (!n) return null;
  return members.find((m) => norm(m.name) === n) ?? members.find((m) => norm(m.name).split(" ")[0] === n.split(" ")[0]) ?? null;
}

const norm = (v: string | null | undefined) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** WhatsApp's number for a member: 55 + DDD + number. */
export function waNumber(phone: string) {
  const d = onlyDigits(phone);
  return d.length <= 11 ? `55${d}` : d;
}

/**
 * "@Odair, pode ver?" → "@5517999990000, pode ver?" with Odair in the mentions, so WhatsApp shows the name and notifies
 * him. Only the members' names (their first name or the full one) become mentions; any other @word stays as written.
 */
export function withMentions(text: string, members: SecretaryMember[]) {
  const mentions: string[] = [];
  const sorted = [...members].filter((m) => m.name.trim() && onlyDigits(m.phone).length >= 8).sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const m of sorted) {
    const first = m.name.trim().split(/\s+/)[0];
    for (const label of [m.name.trim(), first]) {
      const re = new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "giu");
      if (re.test(out)) {
        const number = waNumber(m.phone);
        out = out.replace(re, `@${number}`);
        if (!mentions.includes(number)) mentions.push(number);
      }
    }
  }
  return { text: out, mentions };
}

// ---------- Her number on the WhatsApp server ----------

type Raw = Record<string, unknown> & { error?: string; message?: string };

async function api<T>(path: string, body?: unknown, settings?: SecretarySettings, timeoutMs = 20_000): Promise<T> {
  const s = settings ?? (await getSecretary());
  if (!s.token) throw new Error("A secretária ainda não tem número conectado: leia o QR code na tela Secretária.");
  const base = serverOf({ server: null });
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { token: openToken(s.token), Accept: "application/json", "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Sem resposta do servidor do WhatsApp (${(e as Error).name === "TimeoutError" ? `demorou mais de ${Math.round(timeoutMs / 1000)} s` : (e as Error).message}).`);
  }
  const json = (await res.json().catch(() => ({}))) as T & Raw;
  if (!res.ok) throw new Error(`O servidor do WhatsApp respondeu ${res.status}: ${json.error ?? json.message ?? "erro"}`);
  return json;
}

export type SecretaryQr = { connected: boolean; phone?: string | null; qr?: string | null; error?: string };

/** "Conectar o número dela": her instance (created once, reads only her group and private chats) and its QR code. */
export async function connectSecretary(fresh = false): Promise<SecretaryQr> {
  if (!canCreateInstances()) return { connected: false, error: "Falta ligar o servidor do WhatsApp (SUPPORT_WA_URL e SUPPORT_WA_ADMIN_TOKEN no Vercel)." };
  try {
    let s = await getSecretary();
    if (!s.token) s = await saveSecretary({ token: sealToken(await createInstance("secretaria", { groupsOnly: true })), webhookKey: randomBytes(24).toString("base64url") });
    return await qrStep(s, true, fresh);
  } catch (e) {
    return { connected: false, error: (e as Error).message };
  }
}

export async function secretaryQr(): Promise<SecretaryQr> {
  const s = await getSecretary();
  if (!s.token) return { connected: false, error: "Nenhum número em conexão." };
  return qrStep(s, false).catch((e: Error) => ({ connected: false, error: e.message }));
}

async function qrStep(s: SecretarySettings, start: boolean, fresh = false): Promise<SecretaryQr> {
  const step = await instanceQr({ server: null, token: s.token! }, start, fresh);
  if (step.connected) {
    if (step.phone && step.phone !== s.phone) s = await saveSecretary({ phone: step.phone });
    await pointWebhook(s).catch(() => {});
  }
  return { connected: step.connected, phone: step.phone, qr: step.qr };
}

export const secretaryWebhookUrl = (key: string) => `${CRM_URL}/api/secretaria/webhook/${key}`;

/** Tells the server where to post and what: the chosen group and, when on, the private chats. */
export async function pointWebhook(s: SecretarySettings) {
  if (!s.token || !s.webhookKey) return;
  const groups = [s.group?.id, s.teamGroup?.id].filter((g): g is string => !!g);
  await api("/webhook", { url: secretaryWebhookUrl(s.webhookKey), groups, privates: s.privates }, s);
}

export async function secretaryStatus(s?: SecretarySettings) {
  const raw = await api<{ instance?: { status?: string; owner?: string; reason?: string }; status?: { connected?: boolean } }>("/instance/status", undefined, s);
  const connected = !!raw.status?.connected || raw.instance?.status === "connected";
  return { connected, status: raw.instance?.status ?? (connected ? "connected" : "disconnected"), reason: raw.instance?.reason ?? null, phone: raw.instance?.owner || null };
}

type RawGroup = { JID?: string; Name?: string };

/** The groups her number is in. */
export async function secretaryGroups() {
  const list = await api<RawGroup[]>("/group/list");
  return (Array.isArray(list) ? list : [])
    .map((g) => ({ id: g.JID ?? "", name: g.Name || g.JID || "" }))
    .filter((g) => g.id.endsWith("@g.us"))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export async function setSecretaryGroup(groupId: string | null, which: "group" | "teamGroup" = "group") {
  if (!groupId) return pointWebhook(await saveSecretary({ [which]: null }));
  const group = (await secretaryGroups()).find((g) => g.id === groupId);
  if (!group) throw new Error("Esse grupo não aparece no número da secretária. Confira se ela está no grupo.");
  await pointWebhook(await saveSecretary({ [which]: group }));
  return group;
}

// ---------- The partners' group: people and photo (Wellington, 2026-11-26) ----------

/** Banneg's logo for the group photo (gold monogram on the brand blue). */
export const GROUP_PHOTO = `${CRM_URL}/brand/grupo-banneg.png`;

/**
 * Adds people to one of her groups (she must be an admin there). Whoever WhatsApp refuses to add (privacy) gets the
 * group's invite link from her in private.
 */
export async function addToSecretaryGroup(groupId: string, people: { name: string; phone: string }[], s?: SecretarySettings) {
  const settings = s ?? (await getSecretary());
  const res = await api<{ participants?: { jid: string; status: string }[]; invite?: string | null }>(
    "/group/updateParticipants",
    { groupjid: groupId, action: "add", participants: people.map((p) => waNumber(p.phone)) },
    settings,
  );
  const added: string[] = [];
  const invited: string[] = [];
  const failed: string[] = [];
  for (const p of people) {
    const r = res.participants?.find((x) => onlyDigits(x.jid.split("@")[0]) === waNumber(p.phone));
    if (!r || r.status === "200" || r.status === "409") added.push(p.name);
    else if (res.invite) {
      await secretarySend(`${waNumber(p.phone)}@s.whatsapp.net`, `Oi, ${p.name.split(" ")[0]}! Aqui é a ${settings.name}, secretária do Banneg. O WhatsApp não me deixou colocar você direto no grupo, então segue o convite: ${res.invite}`, settings)
        .then(() => invited.push(p.name))
        .catch(() => failed.push(p.name));
    } else failed.push(p.name);
  }
  return { added, invited, failed };
}

export async function setSecretaryGroupPhoto(groupId: string, image = GROUP_PHOTO, s?: SecretarySettings) {
  await api("/group/updateImage", { groupjid: groupId, image }, s);
}

/** Disconnects her number (as removing the device on the phone). */
export async function removeSecretaryNumber() {
  const s = await getSecretary();
  if (!s.token) return;
  await api("/instance/logout", {}, s).catch(() => {});
  await saveSecretary({ token: null, webhookKey: null, phone: null });
}

// ---------- Sending ----------

/** Sends from her number (to the group or a private chat) and keeps it, so she remembers what she said. */
export async function secretarySend(chatId: string, text: string, s?: SecretarySettings) {
  const settings = s ?? (await getSecretary());
  const body = text.trim();
  if (!body) return null;
  const people = chatId === settings.teamGroup?.id ? await everyone(settings) : settings.members;
  const { text: out, mentions } = withMentions(body, people);
  const res = await api<{ messageid?: string; id?: string }>("/send/text", { number: chatId, text: out, ...(mentions.length && { mentions }) }, settings);
  const externalId = res.messageid ?? res.id ?? null;
  await db.secretaryMessage
    .create({
      data: { chatId, isGroup: chatId.endsWith("@g.us"), externalId, fromMe: true, byApi: true, senderName: settings.name, body, at: new Date(), handledAt: new Date() },
    })
    .catch(() => {});
  return externalId;
}

export type SecretaryFile = { name: string; mime: string; url?: string; data?: Buffer };

/** WhatsApp shows pictures and videos inline; everything else goes as a document with its name. */
export function mediaKind(mime: string): "image" | "video" | "document" {
  if (/^image\/(jpeg|png|webp)$/.test(mime)) return "image";
  if (mime === "video/mp4") return "video";
  return "document";
}

/** Sends a file from her number (a report from the Drive, a CRM material) and keeps a line of it in the chat. */
export async function secretarySendFile(chatId: string, file: SecretaryFile, caption = "", s?: SecretarySettings) {
  const settings = s ?? (await getSecretary());
  if (!file.url && !file.data?.length) throw new Error("Arquivo vazio.");
  const res = await api<{ messageid?: string; id?: string }>(
    "/send/media",
    { number: chatId, type: mediaKind(file.mime), file: file.url ?? file.data!.toString("base64"), docName: file.name, mimetype: file.mime, text: caption.trim() },
    settings,
    90_000,
  );
  const externalId = res.messageid ?? res.id ?? null;
  await db.secretaryMessage
    .create({
      data: {
        chatId,
        isGroup: chatId.endsWith("@g.us"),
        externalId,
        fromMe: true,
        byApi: true,
        senderName: settings.name,
        body: `[Arquivo enviado: ${file.name}]${caption.trim() ? ` ${caption.trim()}` : ""}`,
        at: new Date(),
        handledAt: new Date(),
      },
    })
    .catch(() => {});
  return externalId;
}

export async function sendToSecretaryGroup(text: string) {
  const s = await getSecretary();
  if (!s.group) throw new Error("Nenhum grupo escolhido na tela Secretária.");
  return secretarySend(s.group.id, text, s);
}

// ---------- What the server posts ----------

type Payload = {
  EventType?: string;
  token?: string;
  chat?: { wa_chatid?: string; phone?: string; wa_contactName?: string };
  message?: {
    chatid?: string;
    messageid?: string;
    fromMe?: boolean;
    isGroup?: boolean;
    messageTimestamp?: number;
    text?: string;
    type?: string;
    mediaType?: string;
    senderName?: string;
    sender_pn?: string;
    wasSentByApi?: boolean;
    quoted?: { text?: string; sender?: string };
    mentioned?: string[];
    media?: { mimetype?: string };
  };
  media?: { saved?: boolean; error?: string; mimetype?: string };
};

const LABEL: Record<string, string> = { image: "Imagem", video: "Vídeo", document: "Documento", sticker: "Figurinha", location: "Localização", contact: "Contato" };
// How long she waits for the reader to finish typing before she answers
export const TURN_DEBOUNCE_MS = 6_000;
// An audio she could not get in this time is read as "an audio I could not hear"
const AUDIO_WAIT_MS = 90_000;

export type SecretaryEvent =
  | { kind: "message"; chatId: string; isGroup: boolean; externalId: string | null; fromMe: boolean; byApi: boolean; phone: string | null; name: string | null; body: string; audio: boolean; quoted: string | null; quotedSender?: string | null; mentioned?: string[]; at: Date }
  | { kind: "media"; chatId: string; externalId: string; saved: boolean }
  | { kind: "ignore"; reason: string };

export function parseSecretary(p: Payload, now = new Date()): SecretaryEvent {
  const type = String(p.EventType ?? "").toLowerCase();
  const m = p.message;
  if (type === "media") {
    const chatId = m?.chatid || p.chat?.wa_chatid || "";
    if (!chatId || !m?.messageid) return { kind: "ignore", reason: "arquivo sem mensagem" };
    return { kind: "media", chatId, externalId: m.messageid, saved: !!p.media?.saved };
  }
  if (type !== "messages" || !m) return { kind: "ignore", reason: `evento ${type || "sem tipo"}` };
  const chatId = m.chatid || p.chat?.wa_chatid || "";
  if (!chatId) return { kind: "ignore", reason: "sem conversa" };
  if (m.type === "reaction") return { kind: "ignore", reason: "reação" };
  const isGroup = chatId.endsWith("@g.us");
  const audio = m.mediaType === "ptt" || m.mediaType === "audio";
  const label = audio ? "🎤 (áudio, ouvindo…)" : m.mediaType ? `[${LABEL[m.mediaType] ?? "Arquivo"}]` : m.type === "location" || m.type === "contact" ? `[${LABEL[m.type]}]` : "";
  const body = [label, (m.text ?? "").trim()].filter(Boolean).join(" ");
  if (!body) return { kind: "ignore", reason: "mensagem vazia" };
  const ts = Number(m.messageTimestamp);
  const at = ts > 0 ? new Date(Math.min(ts < 1e12 ? ts * 1000 : ts, now.getTime())) : now;
  const phone = onlyDigits((m.sender_pn || "").split("@")[0]) || (!isGroup ? onlyDigits(p.chat?.phone) : "") || null;
  return {
    kind: "message",
    chatId,
    isGroup,
    externalId: m.messageid ?? null,
    fromMe: !!m.fromMe,
    byApi: !!m.wasSentByApi,
    phone,
    name: (m.senderName || p.chat?.wa_contactName || "").trim() || null,
    body,
    audio,
    quoted: m.quoted?.text?.trim() || null,
    quotedSender: onlyDigits(m.quoted?.sender) || null,
    mentioned: (m.mentioned ?? []).map(onlyDigits).filter(Boolean),
    at,
  };
}

/** Schedules her turn on this chat a few seconds ahead; a new message pushes it again (people send in bursts). */
export async function queueTurn(chatId: string, delayMs = TURN_DEBOUNCE_MS) {
  const dedupeKey = `secretaria.turn:${chatId}:pending`;
  const runAt = new Date(Date.now() + delayMs);
  const existing = await db.job.findUnique({ where: { dedupeKey } });
  if (existing?.status === "PENDING") {
    // Never later than it already was by much: an audio still downloading does not hold a text back forever
    return db.job.update({ where: { id: existing.id }, data: { runAt } });
  }
  if (existing) await db.job.update({ where: { id: existing.id }, data: { dedupeKey: null } });
  return db.job.create({ data: { type: "secretaria.turn", payload: { chatId }, runAt, dedupeKey, maxAttempts: 3 } });
}

/** The server's post: keeps the message (audios get transcribed) and schedules her answer. */
export async function receiveSecretary(key: string, payload: Payload) {
  const s = await getSecretary();
  if (!s.webhookKey || key !== s.webhookKey || !s.token) return { ok: false as const, status: 404, reason: "secretária não encontrada" };
  if (payload.token && payload.token !== openToken(s.token)) return { ok: false as const, status: 401, reason: "token diferente" };
  const event = parseSecretary(payload);
  if (event.kind === "ignore") return { ok: true as const, ignored: event.reason };
  if (event.kind === "media") return receiveAudio(s, event);
  // Only her groups and private chats (the server already filters; an old group left behind stays out)
  const team = event.isGroup && event.chatId === s.teamGroup?.id;
  if (event.isGroup && event.chatId !== s.group?.id && !team) return { ok: true as const, ignored: "outro grupo" };
  if (!event.isGroup && !s.privates) return { ok: true as const, ignored: "privado desligado" };
  if (event.externalId) {
    const seen = await db.secretaryMessage.findUnique({ where: { chatId_externalId: { chatId: event.chatId, externalId: event.externalId } } });
    if (seen) return { ok: true as const, duplicate: true };
  }
  const member = memberByPhone(s.members, event.phone);
  // What she sent herself is already kept (secretarySend); typed on her phone, someone spoke for her: kept, not answered
  const own = event.fromMe;
  // The team group: she learns who is who, keeps every message as context, and acts only when called by name
  if (team && !own && event.phone && event.name) await rememberTeamPerson(event.phone, event.name);
  const quiet = team && !event.audio && !callsHer(s, event);
  await db.secretaryMessage.create({
    data: {
      chatId: event.chatId,
      isGroup: event.isGroup,
      externalId: event.externalId,
      fromMe: own,
      byApi: event.byApi,
      senderPhone: event.phone,
      senderName: own ? s.name : member?.name ?? event.name,
      body: event.body,
      kind: event.audio ? "audio" : null,
      mediaStatus: event.audio ? "aguardando" : null,
      quotedText: event.quoted,
      at: event.at,
      handledAt: own || quiet ? new Date() : null,
    },
  });
  if (own || !s.active) return { ok: true as const };
  if (quiet) return { ok: true as const, quiet: true };
  await queueTurn(event.chatId, event.audio ? AUDIO_WAIT_MS : TURN_DEBOUNCE_MS);
  return { ok: true as const, queued: true };
}

/** The server finished downloading an audio: transcribed, and her turn comes right after. */
async function receiveAudio(s: SecretarySettings, event: { chatId: string; externalId: string; saved: boolean }) {
  const msg = await db.secretaryMessage.findUnique({ where: { chatId_externalId: { chatId: event.chatId, externalId: event.externalId } } });
  if (!msg || msg.kind !== "audio" || msg.mediaStatus !== "aguardando") return { ok: true as const, ignored: "arquivo que não é áudio esperado" };
  let body = "🎤 (mandou um áudio que não consegui ouvir)";
  let status = "erro";
  if (event.saved) {
    try {
      const res = await fetchSupportMedia({ server: null, token: s.token! }, event.externalId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await transcribe(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type") || "audio/ogg");
      if (text) {
        body = `🎤 ${text}`;
        status = "transcrito";
      }
    } catch (e) {
      console.error("Secretária: áudio não transcrito", (e as Error).message);
    }
  }
  // In the team group an audio only wakes her when it calls her by name
  const quiet = event.chatId === s.teamGroup?.id && !callsHer(s, { body });
  await db.secretaryMessage.update({ where: { id: msg.id }, data: { body, mediaStatus: status, ...(quiet && !msg.handledAt && { handledAt: new Date() }) } });
  if (s.active && !msg.handledAt && !quiet) await queueTurn(event.chatId, 2_000);
  return { ok: true as const };
}

// ---------- The team group: who is who ----------

const TEAM_DIR = "secretaria_equipe";
export type TeamPerson = { phone: string; name: string; at: string };

export async function getTeamPeople(): Promise<TeamPerson[]> {
  return ((await db.setting.findUnique({ where: { key: TEAM_DIR } }))?.value as TeamPerson[] | undefined) ?? [];
}

/** Whoever writes in the team group (name as WhatsApp shows it); kept so she can call and chase them. */
async function rememberTeamPerson(phone: string, name: string) {
  const list = await getTeamPeople();
  const found = list.find((p) => p.phone === phone);
  if (found && found.name === name && Date.now() - new Date(found.at).getTime() < 86_400_000) return;
  const next = [...list.filter((p) => p.phone !== phone), { phone, name, at: new Date().toISOString() }].slice(-80);
  await db.setting.upsert({ where: { key: TEAM_DIR }, create: { key: TEAM_DIR, value: next }, update: { value: next } });
}

/** The registered people plus the team group's (as collaborators), for names, @mentions and tasks. */
export async function everyone(s: SecretarySettings): Promise<SecretaryMember[]> {
  if (!s.teamGroup) return s.members;
  const extra = (await getTeamPeople())
    .filter((p) => !memberByPhone(s.members, p.phone))
    .map((p) => ({ name: p.name, phone: p.phone, email: "", role: "colaborador" as const }));
  return [...s.members, ...extra];
}

const plain = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Someone in the team group is talking to her: her first name, an @mention of her number, or a reply to her message. */
export function callsHer(s: Pick<SecretarySettings, "name" | "phone"> & { nicknames?: string[] }, m: { body: string; mentioned?: string[]; quotedSender?: string | null }) {
  const text = plain(m.body);
  const names = [s.name.split(/\s+/)[0] ?? "", ...(s.nicknames ?? [])].map((n) => plain(n.trim())).filter((n) => n.length >= 3);
  if (names.some((n) => new RegExp(`(^|[^a-z])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(text))) return true;
  const mine = s.phone ? phoneVariants(s.phone) : [];
  return [...(m.mentioned ?? []), m.quotedSender ?? ""].some((x) => !!x && mine.includes(x));
}

// ---------- Tasks ----------

export const TASK_KIND_LABEL: Record<string, string> = { tarefa: "Tarefa", retorno: "Retorno", lembrete: "Lembrete" };

export function taskLine(t: Pick<SecretaryTask, "title" | "assignee" | "dueAt" | "kind">, now = new Date()) {
  const late = t.dueAt && t.dueAt < now;
  return [
    `${t.kind === "retorno" ? "↩️" : t.kind === "lembrete" ? "⏰" : "▫️"} ${t.title}`,
    t.assignee && `· ${t.assignee}`,
    t.dueAt && `· ${late ? "*atrasada*, era " : "até "}${whenBr(t.dueAt, brClock(t.dueAt).hour !== NUDGE_HOUR || brClock(t.dueAt).minute !== 0)}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Where a task's reminder and chasing go: to a collaborator in private (they are not in the group), else the group. */
export function taskChat(s: SecretarySettings, task: Pick<SecretaryTask, "assigneePhone" | "chatId">) {
  // Noted in the team group: reminded and chased there
  if (s.teamGroup && task.chatId === s.teamGroup.id) return s.teamGroup.id;
  const member = memberByPhone(s.members, task.assigneePhone);
  return roleOf(member) === "colaborador" ? `${waNumber(member!.phone)}@s.whatsapp.net` : s.group!.id;
}

// ---------- Every minute (cron): reminders, chasing, the week's and the day's list ----------

const MORNING_HOUR = 8;

/** The week's (Monday) or the day's (other business days) list: open tasks by person and the meetings ahead. */
export function morningText(opts: {
  weekly: boolean;
  today: string;
  tasks: Pick<SecretaryTask, "title" | "assignee" | "dueAt" | "kind">[];
  meetings: { startsAt: Date; title: string; meet?: string | null }[];
  now: Date;
}) {
  const { weekly, tasks, meetings, now } = opts;
  const title = weekly ? `*Bom dia! Tarefas da semana* (${whenBr(now, false)})` : `*Bom dia! O que temos hoje* (${whenBr(now, false)})`;
  const end = weekly ? dayStart(addDays(opts.today, 7)) : dayStart(addDays(opts.today, 1));
  const relevant = weekly ? tasks : tasks.filter((t) => !t.dueAt || t.dueAt < end);
  const dueToday = weekly ? relevant : relevant.filter((t) => t.dueAt && t.dueAt < end);
  const groups = new Map<string, typeof relevant>();
  for (const t of weekly ? relevant : dueToday) {
    const k = t.assignee?.trim() || "Sem responsável";
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const parts = [title];
  const ahead = meetings.filter((m) => m.startsAt >= now && m.startsAt < end);
  if (ahead.length)
    parts.push(
      [`*Reuniões${weekly ? " da semana" : " de hoje"}:*`, ...ahead.map((m) => `📅 ${whenBr(m.startsAt)} · ${m.title}${m.meet ? `\n   ${m.meet}` : ""}`)].join("\n"),
    );
  for (const [who, list] of groups) parts.push([`*${who}:*`, ...list.map((t) => taskLine(t, now))].join("\n"));
  if (parts.length === 1) return null;
  if (!weekly) {
    const open = tasks.length - dueToday.length;
    if (open > 0) parts.push(`Mais ${open} tarefa${open > 1 ? "s" : ""} em aberto para os próximos dias.`);
  }
  return parts.join("\n\n");
}

async function upcomingMeetings(from: Date, to: Date) {
  const { listAgenda } = await import("./secretary-agenda");
  return listAgenda(from, to).catch(() => []);
}

async function onceADay(key: string, day: string) {
  const row = (await db.setting.findUnique({ where: { key } }))?.value as { day?: string } | undefined;
  if (row?.day === day) return false;
  // Marked first: a WhatsApp that fails does not post the same list every minute
  const value = { day, at: new Date().toISOString() };
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return true;
}

export async function runSecretaryCron(now = new Date()) {
  const s = await getSecretary();
  if (!s.active || !s.token || !s.group) return null;
  const done: string[] = [];
  const due = await db.secretaryTask.findMany({ where: { status: "aberta", remindAt: { lte: now }, remindedAt: null }, take: 10 });
  for (const t of due) {
    await db.secretaryTask.update({ where: { id: t.id }, data: { remindedAt: now } });
    const who = t.assignee ? `@${t.assignee} ` : "";
    await secretarySend(taskChat(s, t), `⏰ *Lembrete* ${who}\n${t.title}${t.details ? `\n${t.details}` : ""}${t.dueAt ? `\nPrazo: ${whenBr(t.dueAt)}` : ""}`).then(
      () => done.push(`lembrete ${t.id}`),
      (e: Error) => done.push(`lembrete ${t.id} falhou: ${e.message}`),
    );
  }
  const late = await db.secretaryTask.findMany({ where: { status: "aberta", nextNudgeAt: { lte: now }, nudges: { lt: MAX_NUDGES } }, take: 10 });
  for (const t of late) {
    const nudges = t.nudges + 1;
    await db.secretaryTask.update({ where: { id: t.id }, data: { nudges, nextNudgeAt: nudges >= MAX_NUDGES ? null : nextBusinessMorning(now) } });
    const who = t.assignee ? `@${t.assignee}` : "Pessoal";
    const ask = t.kind === "retorno" ? "já teve o retorno?" : "como está?";
    await secretarySend(
      taskChat(s, t),
      `🔔 *Cobrando${nudges > 1 ? ` (${nudges}ª vez)` : ""}:* ${who}, ${ask}\n${t.title}${t.dueAt ? ` (prazo ${whenBr(t.dueAt)})` : ""}\nSe já resolveu, me avise que eu dou baixa.`,
      s,
    ).then(
      () => done.push(`cobrança ${t.id}`),
      (e: Error) => done.push(`cobrança ${t.id} falhou: ${e.message}`),
    );
  }
  const { day, hour, weekday } = brClock(now);
  const business = weekday >= 1 && weekday <= 5;
  const weekly = weekday === 1 && s.weekly;
  if (business && hour >= MORNING_HOUR && hour < 12 && (weekly || s.daily) && (await onceADay("secretaria_morning", day))) {
    const tasks = await db.secretaryTask.findMany({ where: { status: "aberta", kind: { not: "lembrete" } }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }], take: 60 });
    const meetings = await upcomingMeetings(now, dayStart(addDays(day, weekly ? 7 : 1)));
    const text = morningText({ weekly, today: day, tasks, meetings, now });
    if (text) await sendToSecretaryGroup(text).then(() => done.push("lista da manhã"), (e: Error) => done.push(`lista da manhã falhou: ${e.message}`));
  }
  if (now.getMinutes() % 5 === 3) done.push(await checkSecretaryNumber(s, now));
  return done.length ? done : null;
}

// ---------- Her number fell ----------

const HEALTH = "secretaria_health";
export type SecretaryHealth = { ok: boolean; status: string; reason?: string | null; since: string; checkedAt: string; bad: number; alertedAt?: string };

export async function getSecretaryHealth() {
  return ((await db.setting.findUnique({ where: { key: HEALTH } }))?.value as SecretaryHealth | undefined) ?? null;
}

/** Every 5 minutes: is her number still connected. Two bad checks in a row and the owner gets an e-mail. */
async function checkSecretaryNumber(s: SecretarySettings, now: Date) {
  const last = await getSecretaryHealth();
  const st = await secretaryStatus(s).catch((e: Error) => ({ connected: false, status: "sem resposta", reason: e.message, phone: null }));
  const changed = !last || last.ok !== st.connected;
  const next: SecretaryHealth = {
    ok: st.connected,
    status: st.status,
    reason: st.reason,
    since: changed ? now.toISOString() : last.since,
    checkedAt: now.toISOString(),
    bad: st.connected ? 0 : (last?.bad ?? 0) + 1,
    ...(last?.alertedAt && !st.connected && { alertedAt: last.alertedAt }),
  };
  if (!st.connected && next.bad === 2) {
    const owners = await db.user.findMany({ where: { role: "OWNER" }, select: { email: true } });
    const text = `O WhatsApp da secretária${s.phone ? ` (${phoneLabel(s.phone)})` : ""} desconectou${st.reason ? `: ${st.reason}` : ""}. Enquanto estiver desconectado ela não lê o grupo nem manda lembretes.\n\nPara reconectar: abra ${CRM_URL}/secretaria, clique em "Ler o QR code" e aponte o celular do chip dela (WhatsApp > Aparelhos conectados > Conectar um aparelho).`;
    for (const o of owners) await sendEmail(o.email, "A secretária do CRM desconectou do WhatsApp", text).catch(() => {});
    next.alertedAt = now.toISOString();
  }
  // Connected: the server is told again where to post (heals a server that lost it)
  if (st.connected) await pointWebhook(s).catch(() => {});
  await db.setting.upsert({ where: { key: HEALTH }, create: { key: HEALTH, value: next }, update: { value: next } });
  return st.connected ? "número conectado" : `número desconectado (${next.bad})`;
}
