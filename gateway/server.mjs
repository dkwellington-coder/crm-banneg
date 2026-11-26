// Banneg's own WhatsApp gateway for the support numbers (Wellington, 2026-11-19): connects each number by QR code,
// like WhatsApp Web, and posts every message it sends or receives to the CRM. It answers the same calls the CRM
// already makes to Uazapi (/instance/init, /instance/connect, /instance/status, /webhook, /send/text), so the CRM
// works with either one. Runs on a small server that stays on (Vercel cannot hold a WhatsApp connection open).
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from "baileys";
import pino from "pino";
import QRCode from "qrcode";

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.DATA_DIR || path.resolve("data");
const ADMIN = process.env.ADMIN_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
// How far back the history that WhatsApp sends when a number is connected comes to the CRM (Wellington, 2026-11-19)
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS || 30);
if (ADMIN.length < 24) {
  console.error("Defina ADMIN_TOKEN (pelo menos 24 caracteres) antes de ligar o servidor.");
  process.exit(1);
}
// The last warnings and errors stay in memory too: the CRM reads them (GET /debug/log), so a problem can be seen
// without opening Railway (Wellington, 2026-11-26: QR code not showing for the support numbers)
const recent = [];
const log = pino(
  { level: process.env.LOG_LEVEL || "warn" },
  pino.multistream([
    { level: "warn", stream: process.stdout },
    {
      level: "warn",
      stream: {
        write(line) {
          recent.push(String(line).slice(0, 600));
          if (recent.length > 150) recent.shift();
        },
      },
    },
  ]),
);

// ---- Saved numbers: token, name and where to post. The WhatsApp keys live in data/auth/<token>/
const SESSIONS_FILE = path.join(DATA, "sessions.json");
// sendOnly: a number that only sends (Wellington's own WhatsApp posting the meetings in the team's group, 2026-11-23):
// nothing it sends or receives goes to the CRM, no history and no files are kept
// groupsOnly: the secretary's number (Wellington, 2026-11-26): only the messages of the groups listed in `groups` go to
// the CRM; private chats, other groups and the history never leave this server
/** @type {Map<string, {token: string, name: string, webhook: string, sendOnly?: boolean, groupsOnly?: boolean, groups?: string[], privates?: boolean, sock?: any, qr?: string|null, status: string, owner?: string|null, sentByApi: Set<string>, retry?: NodeJS.Timeout, chain?: Promise<void>, tries?: number, lastError?: {code: number, reason: string, at: string}|null}>} */
const sessions = new Map();

// The history syncs a send-only number still accepts (no FULL, RECENT or ON_DEMAND: those are the conversations)
export const SEND_ONLY_SYNC = new Set([
  proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
  proto.HistorySync.HistorySyncType.PUSH_NAME,
  proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
]);

async function save() {
  const list = [...sessions.values()].map(({ token, name, webhook, sendOnly, groupsOnly, groups, privates }) => ({
    token,
    name,
    webhook,
    ...(sendOnly && { sendOnly: true }),
    ...(groupsOnly && { groupsOnly: true, groups: groups || [], privates: !!privates }),
  }));
  await writeFile(SESSIONS_FILE, JSON.stringify(list, null, 2));
}

async function load() {
  await mkdir(path.join(DATA, "auth"), { recursive: true });
  if (!existsSync(SESSIONS_FILE)) return;
  for (const s of JSON.parse(await readFile(SESSIONS_FILE, "utf8"))) {
    sessions.set(s.token, { ...s, status: "disconnected", qr: null, sentByApi: new Set() });
    // Already paired before: connects again on its own
    if (existsSync(path.join(DATA, "auth", s.token, "creds.json"))) reconnect(sessions.get(s.token), 0);
  }
}

const authDir = (token) => path.join(DATA, "auth", token);
// Every file a number sends or receives (audio, photo, PDF, video) is kept here, named by the message id
const mediaDir = (token) => path.join(DATA, "media", createHash("sha256").update(token).digest("hex").slice(0, 16));
const safeId = (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
const digits = (jid) => (jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");

// Why WhatsApp closed a connection, in words the CRM shows (Wellington, 2026-11-23: numbers stuck "connecting" for days)
const REASONS = {
  401: "desconectado no celular: leia o QR code de novo",
  403: "o WhatsApp recusou o acesso deste número",
  408: "o WhatsApp não respondeu a tempo",
  411: "o celular pediu para ler o QR code de novo",
  428: "a conexão com o WhatsApp caiu",
  440: "o número foi aberto em outro lugar (outro servidor ou WhatsApp Web) e derrubou este",
  500: "a sessão salva estragou: leia o QR code de novo",
  503: "o WhatsApp está fora do ar",
  515: "o WhatsApp pediu para reconectar",
};

/** Connects again, waiting longer after each failure (5 s, 10 s, 20 s... up to 5 minutes), and never gives up silently. */
function reconnect(s, ms) {
  clearTimeout(s.retry);
  s.status = "connecting";
  s.retry = setTimeout(() => {
    start(s).catch((e) => {
      log.error({ number: s.name, err: e.message }, "não conseguiu ligar o número");
      s.lastError = { code: 0, reason: `erro ao ligar: ${e.message}`.slice(0, 200), at: new Date().toISOString() };
      s.tries = (s.tries || 0) + 1;
      reconnect(s, Math.min(5_000 * 2 ** (s.tries - 1), 300_000));
    });
  }, ms);
}

// The WhatsApp Web version is asked again every 6 hours: an old one makes WhatsApp close new connections
let waVersion;
let waVersionAt = 0;
async function start(s) {
  clearTimeout(s.retry);
  if (!waVersion || Date.now() - waVersionAt > 6 * 3_600_000) {
    const latest = await fetchLatestBaileysVersion().catch(() => undefined);
    if (latest?.version) [waVersion, waVersionAt] = [latest.version, Date.now()];
  }
  const { state, saveCreds } = await useMultiFileAuthState(authDir(s.token));
  const sock = makeWASocket({
    auth: state,
    logger: log,
    ...(waVersion && { version: waVersion }),
    // A desktop browser: WhatsApp then sends the number's recent history when it is connected
    browser: Browsers.macOS("Desktop"),
    // Not "online": the attendant's phone keeps getting its notifications
    markOnlineOnConnect: false,
    // A send-only number and the secretary's (which reads only its group) ask for no history: only the small first sync
    // WhatsApp needs to keep the session stable (it carries the number's LID mappings; Baileys warns of session errors
    // without it). Their history is dropped on arrival (messaging-history.set returns early for both), so nothing is kept or posted.
    // Never "full sync" (Wellington, 2026-11-26): since 11-19, when it was turned on, WhatsApp ended every connection
    // of the support numbers with 428 before even giving a QR code, while the send-only number (without it) connected
    // on the same server. Without it WhatsApp still sends the recent history when a number is connected.
    syncFullHistory: false,
    shouldSyncHistoryMessage: (m) => (!s.sendOnly && !s.groupsOnly) || SEND_ONLY_SYNC.has(m.syncType),
  });
  s.sock = sock;
  s.status = "connecting";
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    // Only the number's current connection counts: an old one closing (after "read the QR again") touches nothing
    if (s.sock !== sock) return;
    if (u.qr) {
      s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      s.status = "qrcode";
    }
    if (u.connection === "open") {
      s.status = "connected";
      s.qr = null;
      s.tries = 0;
      s.lastError = null;
      s.owner = digits(sock.user?.id);
      post(s, { EventType: "connection", instance: { status: "connected", owner: s.owner } });
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      s.sock = undefined;
      s.tries = (s.tries || 0) + 1;
      s.lastError = { code: code ?? 0, reason: REASONS[code] || `conexão fechada (${code ?? u.lastDisconnect?.error?.message ?? "sem código"})`, at: new Date().toISOString() };
      log.warn({ number: s.name, code, tries: s.tries, err: u.lastDisconnect?.error?.message }, "conexão com o WhatsApp fechou");
      if (code === DisconnectReason.loggedOut) {
        // Disconnected on the phone: the keys are no longer valid, a new QR code is needed
        s.status = "disconnected";
        s.qr = null;
        await rm(authDir(s.token), { recursive: true, force: true });
        post(s, { EventType: "connection", instance: { status: "disconnected" } });
      } else {
        reconnect(s, code === DisconnectReason.restartRequired ? 500 : Math.min(5_000 * 2 ** (s.tries - 1), 300_000));
      }
    }
  });
  sock.ev.on("messages.upsert", ({ messages }) => {
    if (s.sendOnly) return;
    for (const m of messages) {
      const payload = s.groupsOnly ? secretaryPayload(s, m) : toPayload(s, m);
      // The message first, then its file: the CRM already has the message when the file arrives
      if (payload) post(s, payload).then(() => payload.message.media && saveMedia(s, m, payload));
    }
  });
  sock.ev.on("messaging-history.set", ({ messages, contacts, chats, lidPnMappings }) => {
    if (s.sendOnly || s.groupsOnly) return;
    const names = new Map();
    for (const c of contacts || []) if (c.id) names.set(c.id, c.name || c.notify || c.verifiedName || "");
    for (const c of chats || []) if (c.id && c.name && !names.get(c.id)) names.set(c.id, c.name);
    const lids = new Map((lidPnMappings || []).map((x) => [x.lid, x.pn]));
    const since = (Date.now() - HISTORY_DAYS * 86_400_000) / 1000;
    const list = [];
    for (const m of messages || []) {
      const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
      if (ts < since) continue;
      const payload = toPayload(s, m, { names, lids });
      if (payload) list.push([m, payload]);
    }
    if (list.length) queueHistory(s, list);
  });
}

/** History arrives in big pieces: it goes to the CRM 25 messages at a time, one piece after the other. */
function queueHistory(s, list) {
  list.sort((a, b) => a[1].message.messageTimestamp - b[1].message.messageTimestamp);
  s.chain = (s.chain || Promise.resolve()).then(async () => {
    for (let i = 0; i < list.length; i += 25) {
      const part = list.slice(i, i + 25);
      await post(s, part.map(([, p]) => p));
      for (const [m, p] of part) if (p.message.media) saveMedia(s, m, p);
    }
    log.warn({ number: s.name, messages: list.length }, "histórico enviado ao CRM");
  });
  s.chain.catch((e) => log.error(e));
}

// ---- Files: downloaded as soon as they arrive (WhatsApp keeps them only for a while), two at a time
const downloads = [];
let downloading = 0;
function saveMedia(s, m, payload) {
  downloads.push([s, m, payload]);
  pump();
}
function pump() {
  while (downloading < 2 && downloads.length) {
    const [s, m, payload] = downloads.shift();
    downloading++;
    download(s, m, payload)
      .catch((e) => log.warn({ err: e.message }, "arquivo não baixou"))
      .finally(() => {
        downloading--;
        pump();
      });
  }
}

async function download(s, m, payload) {
  const id = safeId(m.key.id);
  const dir = mediaDir(s.token);
  const file = path.join(dir, id);
  const done = { EventType: "media", chat: payload.chat, message: { chatid: payload.message.chatid, messageid: m.key.id } };
  if (existsSync(file)) {
    const { size } = await stat(file);
    return post(s, { ...done, media: { ...payload.message.media, size, saved: true } });
  }
  await mkdir(dir, { recursive: true });
  let error = "";
  for (let attempt = 0; attempt < 3 && !existsSync(file); attempt++) {
    try {
      const stream = await downloadMediaMessage(m, "stream", {}, { logger: log, reuploadRequest: s.sock?.updateMediaMessage });
      await pipeline(stream, createWriteStream(`${file}.part`));
      await rename(`${file}.part`, file);
      error = "";
    } catch (e) {
      error = e.message;
      await rm(`${file}.part`, { force: true });
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
    }
  }
  if (!existsSync(file)) return post(s, { ...done, media: { ...payload.message.media, saved: false, error: error || "não baixou" } });
  const { size } = await stat(file);
  await writeFile(`${file}.json`, JSON.stringify({ ...payload.message.media, size, at: payload.message.messageTimestamp }));
  return post(s, { ...done, media: { ...payload.message.media, size, saved: true } });
}

/** The secretary's number posts only the groups the CRM chose (none until one is chosen). */
export function allowedGroup(s, jid) {
  return !!jid && isJidGroup(jid) && (s.groups || []).includes(jid);
}

/**
 * What the secretary's number posts: the chosen group's messages and, when the CRM asked (privates), the private chats
 * too: the chip is hers alone (Wellington, 2026-11-26: "você poderá receber msg e responder"). Other groups stay here.
 */
export function secretaryPayload(s, m) {
  const jid = m.key?.remoteJid;
  if (!jid) return null;
  if (isJidGroup(jid)) return allowedGroup(s, jid) ? toPayload(s, m, undefined, { group: true }) : null;
  return s.privates ? toPayload(s, m) : null;
}

const MEDIA = { audioMessage: "audio", imageMessage: "image", videoMessage: "video", documentMessage: "document", documentWithCaptionMessage: "document", stickerMessage: "sticker" };

/**
 * A WhatsApp message in the shape Uazapi posts, which the CRM reads. Groups, status and system messages stay out, except
 * a group's messages when opts.group (the secretary's number): then the sender, who was mentioned and the message it answers
 * come along.
 */
export function toPayload(s, m, history, opts = {}) {
  const jid = m.key?.remoteJid;
  if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) return null;
  const group = !!isJidGroup(jid);
  if (group !== !!opts.group) return null;
  const content = normalizeMessageContent(m.message);
  const type = getContentType(content);
  if (!type || ["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo"].includes(type)) return null;
  const c = content[type] || {};
  const text = content.conversation || content.extendedTextMessage?.text || c.caption || content.documentWithCaptionMessage?.message?.documentMessage?.caption || "";
  const mediaType = type === "audioMessage" ? (c.ptt ? "ptt" : "audio") : MEDIA[type] || "";
  const kind = type === "reactionMessage" ? "reaction" : type === "locationMessage" ? "location" : type === "contactMessage" ? "contact" : mediaType ? "media" : "text";
  // In a group the person who wrote is the participant (a LID in newer groups, with the phone alongside)
  const who = group ? [m.key.participant, m.key.participantAlt].find((j) => j?.endsWith("@s.whatsapp.net")) || m.key.participant || "" : jid;
  const pn = who.endsWith("@lid") ? (group ? "" : m.key.remoteJidAlt || history?.lids.get(jid) || "") : who;
  const ctx = c.contextInfo || content.extendedTextMessage?.contextInfo || {};
  const quoted = ctx.quotedMessage ? normalizeMessageContent(ctx.quotedMessage) : null;
  const quotedText = quoted ? quoted.conversation || quoted.extendedTextMessage?.text || quoted[getContentType(quoted)]?.caption || "" : "";
  // In the history the contact's name comes from the address book, for the client's and the attendant's messages
  const known = history?.names.get(jid) || (pn && history?.names.get(jidNormalizedUser(pn))) || "";
  const file = mediaType && mediaType !== "sticker" ? c : null;
  const id = m.key.id;
  const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
  return {
    EventType: "messages",
    chat: group ? { wa_chatid: jid, phone: "", wa_contactName: "", wa_isGroup: true } : { wa_chatid: jid, phone: digits(pn), wa_contactName: (m.key.fromMe ? "" : m.pushName) || known || "" },
    message: {
      chatid: jid,
      messageid: id,
      fromMe: !!m.key.fromMe,
      isGroup: group,
      ...(group && {
        sender_lid: [m.key.participant, m.key.participantAlt].find((j) => j?.endsWith("@lid")) ? digits([m.key.participant, m.key.participantAlt].find((j) => j?.endsWith("@lid"))) : "",
        mentioned: (ctx.mentionedJid || []).map(digits).filter(Boolean),
        ...(quoted && { quoted: { id: ctx.stanzaId || "", text: String(quotedText).slice(0, 1000), sender: digits(ctx.participant) } }),
      }),
      messageTimestamp: ts ? ts * 1000 : Date.now(),
      text,
      type: kind,
      mediaType,
      reaction: type === "reactionMessage" ? c.text || "" : "",
      senderName: m.key.fromMe ? "" : m.pushName || "",
      sender_pn: pn ? jidNormalizedUser(pn) : "",
      wasSentByApi: s.sentByApi.has(id),
      ...(history && { history: true }),
      ...(file && {
        media: {
          mimetype: String(file.mimetype || "").split(";")[0] || "application/octet-stream",
          fileName: file.fileName || file.title || "",
          size: Number(file.fileLength?.toNumber?.() ?? file.fileLength ?? 0),
          seconds: Number(file.seconds || 0),
        },
      }),
    },
  };
}

// ---- Posting to the CRM, a few tries
async function post(s, body) {
  if (!s.webhook || s.sendOnly) return;
  const many = Array.isArray(body);
  const sign = (b) => ({ ...b, token: s.token, owner: s.owner || "" });
  const data = JSON.stringify(many ? body.map(sign) : sign(body));
  // A piece of history waits longer and tries more: losing it means losing those messages
  for (let attempt = 0; attempt < (many ? 9 : 5); attempt++) {
    try {
      const res = await fetch(s.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: data, signal: AbortSignal.timeout(many ? 120_000 : 15_000) });
      // 4xx: the CRM refused it (unknown number, wrong token); trying again does not help
      if (res.ok || (res.status >= 400 && res.status < 500)) return;
    } catch (e) {
      log.warn({ err: e.message }, "webhook falhou");
    }
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
  }
}

/** A saved file, whole or in parts (the browser asks for parts to play audio and video). */
async function sendFile(s, id, req, res) {
  const file = path.join(mediaDir(s.token), safeId(id));
  if (!id || !existsSync(file)) return false;
  const meta = await readFile(`${file}.json`, "utf8").then(JSON.parse).catch(() => ({}));
  const { size } = await stat(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  const headers = { "Content-Type": meta.mimetype || "application/octet-stream", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return true;
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    await pipeline(createReadStream(file, { start, end }), res);
    return true;
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  await pipeline(createReadStream(file), res);
  return true;
}

// ---- HTTP
const same = (a, b) => !!a && !!b && timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

/** Baileys' groups as Uazapi lists them: JID and Name. */
export function groupList(groups) {
  return Object.values(groups || {})
    .filter((g) => g?.id && isJidGroup(g.id))
    .map((g) => ({ JID: g.id, Name: g.subject || "" }));
}

function statusOf(s) {
  const connected = s.status === "connected";
  return {
    instance: {
      name: s.name,
      status: connected ? "connected" : s.status,
      owner: s.owner || "",
      qrcode: s.qr || "",
      profileName: s.name,
      // Why it is not connected: the last time WhatsApp closed it, and how many tries since
      ...(!connected && s.lastError && { reason: s.lastError.reason, lastDisconnect: { ...s.lastError, tries: s.tries || 0 } }),
    },
    status: { connected, jid: s.owner ? `${s.owner}@s.whatsapp.net` : "" },
  };
}

async function waitFor(s, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && s.status !== "connected" && !s.qr) await new Promise((r) => setTimeout(r, 250));
}

export const routes = {
  "GET /health": async () => [200, { ok: true, numbers: sessions.size }],

  "POST /instance/init": async (_s, body, req) => {
    if (!same(req.headers.admintoken, ADMIN)) return [401, { error: "admintoken inválido" }];
    const token = randomBytes(24).toString("base64url");
    const s = {
      token,
      name: String(body.name || "suporte").slice(0, 60),
      webhook: "",
      ...(body.sendOnly === true && { sendOnly: true }),
      ...(body.groupsOnly === true && body.sendOnly !== true && { groupsOnly: true, groups: [] }),
      status: "disconnected",
      qr: null,
      sentByApi: new Set(),
    };
    sessions.set(token, s);
    await save();
    return [200, { token, instance: { token, name: s.name, status: s.status } }];
  },

  "GET /instance/all": async (_s, _b, req) => {
    if (!same(req.headers.admintoken, ADMIN)) return [401, { error: "admintoken inválido" }];
    return [200, [...sessions.values()].map((s) => ({ name: s.name, status: s.status, owner: s.owner || "", lastDisconnect: s.lastError || null, tries: s.tries || 0 }))];
  },

  "POST /instance/connect": async (s, body) => {
    if (body.fresh) {
      // Read the QR code again: WhatsApp sends the history only to a newly connected device
      const old = s.sock;
      s.sock = undefined;
      clearTimeout(s.retry);
      // Logging out only works on an open connection; a closed one would wait a minute for nothing
      if (old && s.status === "connected") await Promise.race([old.logout().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
      old?.end?.(undefined);
      await rm(authDir(s.token), { recursive: true, force: true });
      s.status = "disconnected";
      s.qr = null;
    }
    // Someone is waiting with the phone in hand: no waiting from earlier failures
    s.tries = 0;
    for (let attempt = 0; attempt < 3 && s.status !== "connected" && !s.qr; attempt++) {
      if (!s.sock) {
        clearTimeout(s.retry);
        await start(s).catch((e) => {
          reconnect(s, 5_000);
          throw e;
        });
      }
      await waitFor(s, 12_000);
      if (s.status !== "connected" && !s.qr) log.warn({ number: s.name, attempt, lastError: s.lastError }, "QR code não veio");
    }
    return [200, { connected: s.status === "connected", ...statusOf(s) }];
  },

  "GET /instance/status": async (s) => [200, statusOf(s)],

  "GET /debug/log": async (_s, _b, req) => {
    if (!same(req.headers.admintoken, ADMIN)) return [401, { error: "admintoken inválido" }];
    return [200, { lines: recent.slice(-80), waVersion: waVersion?.join(".") || null }];
  },

  "POST /instance/logout": async (s) => {
    await s.sock?.logout().catch(() => {});
    return [200, { ok: true }];
  },

  "POST /webhook": async (s, body) => {
    if (s.sendOnly) return [409, { error: "Este número só envia: nada dele vai para o CRM." }];
    const url = String(body.url || "");
    if (url && !/^https:\/\//.test(url)) return [400, { error: "O webhook precisa ser https." }];
    s.webhook = url;
    // The secretary's number: which groups it reads (the rest never leaves this server)
    if (s.groupsOnly && Array.isArray(body.groups)) s.groups = body.groups.map(String).filter((g) => isJidGroup(g)).slice(0, 5);
    if (s.groupsOnly && typeof body.privates === "boolean") s.privates = body.privates;
    await save();
    return [200, { url, events: ["messages", "connection"] }];
  },

  // The groups the number is in (the meetings group is chosen from these in the CRM)
  "GET /group/list": async (s) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const groups = await s.sock.groupFetchAllParticipating();
    return [200, groupList(groups)];
  },

  // The secretary's group (Wellington, 2026-11-26): she adds or removes people and changes the photo when a partner asks.
  // Only for her number and only in the group she reads; she must be an admin of it.
  "POST /group/updateParticipants": async (s, body) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const jid = String(body.groupjid || "");
    if (!s.groupsOnly || !allowedGroup(s, jid)) return [403, { error: "Só no grupo da secretária." }];
    const action = String(body.action || "add");
    if (!["add", "remove", "promote", "demote"].includes(action)) return [400, { error: "Ação inválida." }];
    const people = (Array.isArray(body.participants) ? body.participants : []).map((v) => (String(v).includes("@") ? String(v) : `${String(v).replace(/\D/g, "")}@s.whatsapp.net`)).slice(0, 10);
    if (!people.length) return [400, { error: "Ninguém para incluir." }];
    let result;
    try {
      result = await s.sock.groupParticipantsUpdate(jid, people, action);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/not-authorized|forbidden|403/i.test(msg)) return [403, { error: "A secretária não é administradora do grupo." }];
      throw e;
    }
    // WhatsApp refuses to add someone whose privacy blocks it (403/408): the CRM sends that person the group's invite link
    const out = (result || []).map((r) => ({ jid: r.jid, status: String(r.status) }));
    let invite = null;
    if (action === "add" && out.some((r) => r.status !== "200")) invite = `https://chat.whatsapp.com/${await s.sock.groupInviteCode(jid)}`;
    return [200, { participants: out, invite }];
  },

  "POST /group/updateImage": async (s, body) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const jid = String(body.groupjid || "");
    if (!s.groupsOnly || !allowedGroup(s, jid)) return [403, { error: "Só no grupo da secretária." }];
    const url = String(body.image || "");
    if (!/^https:\/\//.test(url)) return [400, { error: "A imagem precisa ser um link https." }];
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [400, { error: `Não consegui baixar a imagem (HTTP ${res.status}).` }];
    try {
      await s.sock.updateProfilePicture(jid, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      const msg = String(e?.message || e);
      if (/not-authorized|forbidden|403/i.test(msg)) return [403, { error: "A secretária não é administradora do grupo." }];
      throw e;
    }
    return [200, { ok: true }];
  },

  // A file (the secretary sending a report or a material, 2026-11-26): https link or base64, up to 30 MB
  "POST /send/media": async (s, body) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const to = String(body.number || "");
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const type = String(body.type || "document");
    if (!["document", "image", "video", "audio"].includes(type)) return [400, { error: "Tipo inválido (document, image, video ou audio)." }];
    const file = String(body.file || "");
    let data;
    let mimetype = String(body.mimetype || "");
    if (/^https:\/\//.test(file)) {
      const res = await fetch(file, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return [400, { error: `Não consegui baixar o arquivo (HTTP ${res.status}).` }];
      data = Buffer.from(await res.arrayBuffer());
      mimetype ||= res.headers.get("content-type")?.split(";")[0] || "";
    } else if (file) data = Buffer.from(file.replace(/^data:[^,]*,/, ""), "base64");
    if (!data?.length) return [400, { error: "Arquivo vazio: mande um link https ou o conteúdo em base64." }];
    if (data.length > 30 * 1024 * 1024) return [413, { error: "Arquivo maior que 30 MB." }];
    const caption = String(body.text || "") || undefined;
    const fileName = String(body.docName || "") || "arquivo";
    const content =
      type === "image"
        ? { image: data, caption, ...(mimetype && { mimetype }) }
        : type === "video"
          ? { video: data, caption, ...(mimetype && { mimetype }) }
          : type === "audio"
            ? { audio: data, mimetype: mimetype || "audio/ogg; codecs=opus", ptt: body.ptt === true }
            : { document: data, fileName, caption, mimetype: mimetype || "application/octet-stream" };
    const sent = await s.sock.sendMessage(jid, content);
    const id = sent?.key?.id;
    if (id) {
      s.sentByApi.add(id);
      if (s.sentByApi.size > 5000) s.sentByApi = new Set([...s.sentByApi].slice(-1000));
    }
    return [200, { messageid: id, id, status: "sent" }];
  },

  "POST /send/text": async (s, body) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const to = String(body.number || "");
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const text = String(body.text || "");
    if (!text.trim()) return [400, { error: "Mensagem vazia." }];
    // @mentions (the secretary chasing someone in the group): phones or JIDs, written as @<phone> in the text
    const mentions = Array.isArray(body.mentions) ? body.mentions.map((v) => (String(v).includes("@") ? String(v) : `${String(v).replace(/\D/g, "")}@s.whatsapp.net`)) : [];
    const sent = await s.sock.sendMessage(jid, mentions.length ? { text, mentions } : { text });
    const id = sent?.key?.id;
    if (id) {
      s.sentByApi.add(id);
      // Keep the list small: only recent sends matter for the echo
      if (s.sentByApi.size > 5000) s.sentByApi = new Set([...s.sentByApi].slice(-1000));
    }
    return [200, { messageid: id, id, status: "sent" }];
  },
};

const server = createServer(async (req, res) => {
  const reply = (code, json) => {
    if (res.headersSent) return res.end();
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  try {
    const url = new URL(req.url, "http://x");
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route && url.pathname !== "/media") return reply(404, { error: "rota não existe" });
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    }
    const open = url.pathname === "/health" || url.pathname.startsWith("/instance/init") || url.pathname === "/instance/all" || url.pathname === "/debug/log";
    const s = open ? null : sessions.get(String(req.headers.token || ""));
    if (!open && !s) return reply(401, { error: "token inválido" });
    if (req.method === "GET" && url.pathname === "/media") {
      if (!(await sendFile(s, url.searchParams.get("id"), req, res))) reply(404, { error: "arquivo não está aqui (ainda baixando ou não veio do WhatsApp)" });
      return;
    }
    const [code, json] = await route(s, body, req);
    reply(code, json);
  } catch (e) {
    // The browser stopped a file halfway (it asks the next piece of an audio or video): nothing went wrong
    if (e.code === "ERR_STREAM_PREMATURE_CLOSE") return;
    log.error(e);
    reply(500, { error: e.message });
  }
});

if (process.env.NODE_ENV !== "test") {
  await load();
  server.listen(PORT, () => console.log(`WhatsApp do suporte ouvindo na porta ${PORT}${PUBLIC_URL ? ` (${PUBLIC_URL})` : ""}`));
}
