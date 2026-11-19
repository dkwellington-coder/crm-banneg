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
const log = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---- Saved numbers: token, name and where to post. The WhatsApp keys live in data/auth/<token>/
const SESSIONS_FILE = path.join(DATA, "sessions.json");
/** @type {Map<string, {token: string, name: string, webhook: string, sock?: any, qr?: string|null, status: string, owner?: string|null, sentByApi: Set<string>, retry?: NodeJS.Timeout, chain?: Promise<void>}>} */
const sessions = new Map();

async function save() {
  const list = [...sessions.values()].map(({ token, name, webhook }) => ({ token, name, webhook }));
  await writeFile(SESSIONS_FILE, JSON.stringify(list, null, 2));
}

async function load() {
  await mkdir(path.join(DATA, "auth"), { recursive: true });
  if (!existsSync(SESSIONS_FILE)) return;
  for (const s of JSON.parse(await readFile(SESSIONS_FILE, "utf8"))) {
    sessions.set(s.token, { ...s, status: "disconnected", qr: null, sentByApi: new Set() });
    // Already paired before: connects again on its own
    if (existsSync(path.join(DATA, "auth", s.token, "creds.json"))) start(sessions.get(s.token)).catch((e) => log.error(e));
  }
}

const authDir = (token) => path.join(DATA, "auth", token);
// Every file a number sends or receives (audio, photo, PDF, video) is kept here, named by the message id
const mediaDir = (token) => path.join(DATA, "media", createHash("sha256").update(token).digest("hex").slice(0, 16));
const safeId = (id) => String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
const digits = (jid) => (jid || "").split("@")[0].split(":")[0].replace(/\D/g, "");

let waVersion;
async function start(s) {
  clearTimeout(s.retry);
  waVersion ??= await fetchLatestBaileysVersion()
    .then((r) => r.version)
    .catch(() => undefined);
  const { state, saveCreds } = await useMultiFileAuthState(authDir(s.token));
  const sock = makeWASocket({
    auth: state,
    logger: log,
    ...(waVersion && { version: waVersion }),
    // A desktop browser with full sync: WhatsApp then sends the number's history when it is connected
    browser: Browsers.macOS("Desktop"),
    // Not "online": the attendant's phone keeps getting its notifications
    markOnlineOnConnect: false,
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
  });
  s.sock = sock;
  s.status = "connecting";
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    // An old connection closing after a new one started must not touch the new one
    if (s.sock !== sock && s.sock) return;
    if (u.qr) {
      s.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      s.status = "qrcode";
    }
    if (u.connection === "open") {
      s.status = "connected";
      s.qr = null;
      s.owner = digits(sock.user?.id);
      post(s, { EventType: "connection", instance: { status: "connected", owner: s.owner } });
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      s.sock = undefined;
      if (code === DisconnectReason.loggedOut) {
        // Disconnected on the phone: the keys are no longer valid, a new QR code is needed
        s.status = "disconnected";
        s.qr = null;
        await rm(authDir(s.token), { recursive: true, force: true });
        post(s, { EventType: "connection", instance: { status: "disconnected" } });
      } else {
        s.status = "connecting";
        s.retry = setTimeout(() => start(s).catch((e) => log.error(e)), code === DisconnectReason.restartRequired ? 500 : 5_000);
      }
    }
  });
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      const payload = toPayload(s, m);
      // The message first, then its file: the CRM already has the message when the file arrives
      if (payload) post(s, payload).then(() => payload.message.media && saveMedia(s, m, payload));
    }
  });
  sock.ev.on("messaging-history.set", ({ messages, contacts, chats, lidPnMappings }) => {
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

const MEDIA = { audioMessage: "audio", imageMessage: "image", videoMessage: "video", documentMessage: "document", documentWithCaptionMessage: "document", stickerMessage: "sticker" };

/** A WhatsApp message in the shape Uazapi posts, which the CRM reads. Groups, status and system messages stay out. */
export function toPayload(s, m, history) {
  const jid = m.key?.remoteJid;
  if (!jid || isJidGroup(jid) || jid === "status@broadcast" || jid.endsWith("@newsletter")) return null;
  const content = normalizeMessageContent(m.message);
  const type = getContentType(content);
  if (!type || ["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo"].includes(type)) return null;
  const c = content[type] || {};
  const text = content.conversation || content.extendedTextMessage?.text || c.caption || content.documentWithCaptionMessage?.message?.documentMessage?.caption || "";
  const mediaType = type === "audioMessage" ? (c.ptt ? "ptt" : "audio") : MEDIA[type] || "";
  const kind = type === "reactionMessage" ? "reaction" : type === "locationMessage" ? "location" : type === "contactMessage" ? "contact" : mediaType ? "media" : "text";
  const pn = jid.endsWith("@lid") ? m.key.remoteJidAlt || history?.lids.get(jid) || "" : jid;
  // In the history the contact's name comes from the address book, for the client's and the attendant's messages
  const known = history?.names.get(jid) || (pn && history?.names.get(jidNormalizedUser(pn))) || "";
  const file = mediaType && mediaType !== "sticker" ? c : null;
  const id = m.key.id;
  const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
  return {
    EventType: "messages",
    chat: { wa_chatid: jid, phone: digits(pn), wa_contactName: (m.key.fromMe ? "" : m.pushName) || known || "" },
    message: {
      chatid: jid,
      messageid: id,
      fromMe: !!m.key.fromMe,
      isGroup: false,
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
  if (!s.webhook) return;
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

function statusOf(s) {
  const connected = s.status === "connected";
  return {
    instance: { name: s.name, status: connected ? "connected" : s.status, owner: s.owner || "", qrcode: s.qr || "", profileName: s.name },
    status: { connected, jid: s.owner ? `${s.owner}@s.whatsapp.net` : "" },
  };
}

async function waitFor(s, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && s.status !== "connected" && !s.qr) await new Promise((r) => setTimeout(r, 250));
}

const routes = {
  "GET /health": async () => [200, { ok: true, numbers: sessions.size }],

  "POST /instance/init": async (_s, body, req) => {
    if (!same(req.headers.admintoken, ADMIN)) return [401, { error: "admintoken inválido" }];
    const token = randomBytes(24).toString("base64url");
    const s = { token, name: String(body.name || "suporte").slice(0, 60), webhook: "", status: "disconnected", qr: null, sentByApi: new Set() };
    sessions.set(token, s);
    await save();
    return [200, { token, instance: { token, name: s.name, status: s.status } }];
  },

  "GET /instance/all": async (_s, _b, req) => {
    if (!same(req.headers.admintoken, ADMIN)) return [401, { error: "admintoken inválido" }];
    return [200, [...sessions.values()].map((s) => ({ name: s.name, status: s.status, owner: s.owner || "" }))];
  },

  "POST /instance/connect": async (s, body) => {
    if (body.fresh) {
      // Read the QR code again: WhatsApp sends the history only to a newly connected device
      const old = s.sock;
      s.sock = undefined;
      clearTimeout(s.retry);
      await old?.logout().catch(() => {});
      old?.end?.(undefined);
      await rm(authDir(s.token), { recursive: true, force: true });
      s.status = "disconnected";
      s.qr = null;
    }
    if (s.status !== "connected" && !s.sock) await start(s);
    await waitFor(s, 10_000);
    return [200, { connected: s.status === "connected", ...statusOf(s) }];
  },

  "GET /instance/status": async (s) => [200, statusOf(s)],

  "POST /instance/logout": async (s) => {
    await s.sock?.logout().catch(() => {});
    return [200, { ok: true }];
  },

  "POST /webhook": async (s, body) => {
    const url = String(body.url || "");
    if (url && !/^https:\/\//.test(url)) return [400, { error: "O webhook precisa ser https." }];
    s.webhook = url;
    await save();
    return [200, { url, events: ["messages", "connection"] }];
  },

  "POST /send/text": async (s, body) => {
    if (s.status !== "connected" || !s.sock) return [409, { error: "Número desconectado. Leia o QR code de novo no CRM." }];
    const to = String(body.number || "");
    const jid = to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`;
    const text = String(body.text || "");
    if (!text.trim()) return [400, { error: "Mensagem vazia." }];
    const sent = await s.sock.sendMessage(jid, { text });
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
    const open = url.pathname === "/health" || url.pathname.startsWith("/instance/init") || url.pathname === "/instance/all";
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
