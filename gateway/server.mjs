// Banneg's own WhatsApp gateway for the support numbers (Wellington, 2026-11-19): connects each number by QR code,
// like WhatsApp Web, and posts every message it sends or receives to the CRM. It answers the same calls the CRM
// already makes to Uazapi (/instance/init, /instance/connect, /instance/status, /webhook, /send/text), so the CRM
// works with either one. Runs on a small server that stays on (Vercel cannot hold a WhatsApp connection open).
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import makeWASocket, {
  Browsers,
  DisconnectReason,
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
if (ADMIN.length < 24) {
  console.error("Defina ADMIN_TOKEN (pelo menos 24 caracteres) antes de ligar o servidor.");
  process.exit(1);
}
const log = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---- Saved numbers: token, name and where to post. The WhatsApp keys live in data/auth/<token>/
const SESSIONS_FILE = path.join(DATA, "sessions.json");
/** @type {Map<string, {token: string, name: string, webhook: string, sock?: any, qr?: string|null, status: string, owner?: string|null, sentByApi: Set<string>, retry?: NodeJS.Timeout}>} */
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
    browser: Browsers.ubuntu("Banneg CRM"),
    // Not "online": the attendant's phone keeps getting its notifications
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  s.sock = sock;
  s.status = "connecting";
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
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
      if (payload) post(s, payload);
    }
  });
}

const MEDIA = { audioMessage: "audio", imageMessage: "image", videoMessage: "video", documentMessage: "document", documentWithCaptionMessage: "document", stickerMessage: "sticker" };

/** A WhatsApp message in the shape Uazapi posts, which the CRM reads. Groups, status and system messages stay out. */
export function toPayload(s, m) {
  const jid = m.key?.remoteJid;
  if (!jid || isJidGroup(jid) || jid === "status@broadcast" || jid.endsWith("@newsletter")) return null;
  const content = normalizeMessageContent(m.message);
  const type = getContentType(content);
  if (!type || ["protocolMessage", "senderKeyDistributionMessage", "messageContextInfo"].includes(type)) return null;
  const c = content[type] || {};
  const text = content.conversation || content.extendedTextMessage?.text || c.caption || content.documentWithCaptionMessage?.message?.documentMessage?.caption || "";
  const mediaType = type === "audioMessage" ? (c.ptt ? "ptt" : "audio") : MEDIA[type] || "";
  const kind = type === "reactionMessage" ? "reaction" : type === "locationMessage" ? "location" : type === "contactMessage" ? "contact" : mediaType ? "media" : "text";
  const pn = jid.endsWith("@lid") ? m.key.remoteJidAlt || "" : jid;
  const id = m.key.id;
  const ts = Number(m.messageTimestamp?.toNumber?.() ?? m.messageTimestamp ?? 0);
  return {
    EventType: "messages",
    chat: { wa_chatid: jid, phone: digits(pn), wa_contactName: m.key.fromMe ? "" : m.pushName || "" },
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
    },
  };
}

// ---- Posting to the CRM, a few tries
async function post(s, body) {
  if (!s.webhook) return;
  const data = JSON.stringify({ ...body, token: s.token, owner: s.owner || "" });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(s.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: data, signal: AbortSignal.timeout(15_000) });
      // 4xx: the CRM refused it (unknown number, wrong token); trying again does not help
      if (res.ok || (res.status >= 400 && res.status < 500)) return;
    } catch (e) {
      log.warn({ err: e.message }, "webhook falhou");
    }
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
  }
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

  "POST /instance/connect": async (s) => {
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
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  try {
    const url = new URL(req.url, "http://x");
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return reply(404, { error: "rota não existe" });
    let body = {};
    if (req.method === "POST") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
    }
    const open = url.pathname === "/health" || url.pathname.startsWith("/instance/init") || url.pathname === "/instance/all";
    const s = open ? null : sessions.get(String(req.headers.token || ""));
    if (!open && !s) return reply(401, { error: "token inválido" });
    const [code, json] = await route(s, body, req);
    reply(code, json);
  } catch (e) {
    log.error(e);
    reply(500, { error: e.message });
  }
});

if (process.env.NODE_ENV !== "test") {
  await load();
  server.listen(PORT, () => console.log(`WhatsApp do suporte ouvindo na porta ${PORT}${PUBLIC_URL ? ` (${PUBLIC_URL})` : ""}`));
}
