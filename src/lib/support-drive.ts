import { db } from "./db";
import { accessTokenFrom, googleCodeToLink, type GoogleLink } from "./google";
import { fetchSupportMedia } from "./support";

/**
 * Suporte (Wellington, 2026-11-19, "não podemos perder"): every file a support number sends or receives stays on the
 * WhatsApp server's disk and a copy goes to the owner's Google Drive, in "Banneg Suporte / <número> / <mês>".
 * drive.file only lets the CRM see the files it created itself, never the rest of the Drive.
 */
export const DRIVE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.file"];
const KEY = "suporte_drive";
const ROOT_NAME = "Banneg Suporte";
const CHUNK = 16 * 1024 * 1024; // a multiple of 256 KB, as Drive asks
const MAX_TRIES = 8;

type DriveLink = GoogleLink & { folders?: Record<string, string> };

export async function supportDrive() {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return row ? (row.value as DriveLink) : null;
}

export async function connectSupportDrive(code: string, redirectUri: string) {
  const link: DriveLink = { ...(await googleCodeToLink(code, redirectUri)), folders: {} };
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: link }, update: { value: link } });
  // Files that failed before (no Drive yet) get their tries back
  await db.supportMessage.updateMany({ where: { driveFileId: null, driveTries: { gt: 0 } }, data: { driveTries: 0, driveError: null } });
  return link;
}

export async function disconnectSupportDrive() {
  await db.setting.deleteMany({ where: { key: KEY } });
}

export async function driveSummary() {
  const [link, copied, waiting, failed, downloading, lost] = await Promise.all([
    supportDrive(),
    db.supportMessage.count({ where: { driveFileId: { not: null } } }),
    db.supportMessage.count({ where: { mediaStatus: "salvo", driveFileId: null, driveTries: { lt: MAX_TRIES } } }),
    db.supportMessage.count({ where: { mediaStatus: "salvo", driveFileId: null, driveTries: { gte: MAX_TRIES } } }),
    db.supportMessage.count({ where: { mediaStatus: "baixando" } }),
    db.supportMessage.count({ where: { mediaStatus: "erro" } }),
  ]);
  return { email: link?.email ?? null, connectedAt: link?.connectedAt ?? null, copied, waiting, failed, downloading, lost };
}

async function google<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw Object.assign(new Error(`Google Drive respondeu ${res.status}: ${json.error?.message ?? "erro"}`), { status: res.status });
  return json;
}

/** A folder made by the CRM (kept by id, so renaming it in the Drive does not matter). */
async function folder(token: string, link: DriveLink, key: string, name: string, parent?: string) {
  const known = link.folders?.[key];
  if (known) return known;
  const made = await google<{ id: string }>(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", ...(parent && { parents: [parent] }) }),
  });
  link.folders = { ...link.folders, [key]: made.id };
  await db.setting.update({ where: { key: KEY }, data: { value: link } });
  return made.id;
}

const EXT: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

const brasilia = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString();

/** "2026-11-19 14h05 - Joana - boleto.pdf": sorts by date in the folder and says whose it is. */
export function driveFileName(m: { createdAt: Date; mediaName: string | null; mediaMime: string | null; kind: string | null; direction: string }, contact: string) {
  const at = brasilia(m.createdAt);
  const when = `${at.slice(0, 10)} ${at.slice(11, 13)}h${at.slice(14, 16)}`;
  const ext = EXT[m.mediaMime ?? ""] ?? m.mediaMime?.split("/")[1]?.replace(/[^a-z0-9]/g, "").slice(0, 5) ?? "bin";
  const label = (m.mediaName || `${m.kind === "ptt" ? "audio" : (m.kind ?? "arquivo")}${m.direction === "OUT" ? " enviado" : ""}`).replace(/[\\/:*?"<>|]+/g, " ").trim();
  const name = `${when} - ${contact.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Contato"} - ${label}`.slice(0, 180);
  return /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`;
}

/** Copies one file: from the WhatsApp server to Drive, 16 MB at a time, so a long video never fills the memory. */
async function copyOne(token: string, link: DriveLink, id: string) {
  const m = await db.supportMessage.findUniqueOrThrow({ where: { id }, include: { chat: { include: { number: true } } } });
  const number = m.chat.number;
  const root = await folder(token, link, "root", ROOT_NAME);
  const numberFolder = await folder(token, link, `n:${number.id}`, number.name, root);
  const month = brasilia(m.createdAt).slice(0, 7);
  const monthFolder = await folder(token, link, `n:${number.id}:${month}`, month, numberFolder);

  const first = await fetchSupportMedia(number, m.externalId!, `bytes=0-${CHUNK - 1}`);
  if (!first.ok) throw new Error(`O servidor do WhatsApp não entregou o arquivo (${first.status}).`);
  const size = Number(first.headers.get("content-range")?.split("/")[1] ?? first.headers.get("content-length") ?? 0);
  const mime = m.mediaMime || first.headers.get("content-type") || "application/octet-stream";
  const contact = m.chat.name || m.chat.phone || "";
  const start = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mime,
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({
      name: driveFileName(m, contact),
      parents: [monthFolder],
      description: `${m.direction === "OUT" ? `Enviado por ${m.author ?? number.name}` : `Recebido de ${contact}`} · ${number.name} · WhatsApp ${m.chat.phone ?? m.chat.waChatId}`,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const session = start.headers.get("location");
  if (!start.ok || !session) {
    const why = ((await start.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
    throw Object.assign(new Error(`Google Drive respondeu ${start.status}: ${why ?? "erro"}`), { status: start.status });
  }

  let offset = 0;
  let body = Buffer.from(await first.arrayBuffer());
  for (;;) {
    const end = offset + body.length - 1;
    const res = await fetch(session, {
      method: "PUT",
      headers: { "Content-Range": size ? `bytes ${offset}-${end}/${size}` : `bytes */0` },
      body: size ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status === 200 || res.status === 201) {
      const json = (await res.json()) as { id: string };
      return db.supportMessage.update({ where: { id }, data: { driveFileId: json.id, driveError: null } });
    }
    if (res.status !== 308) throw new Error(`Google Drive respondeu ${res.status} no envio.`);
    offset = end + 1;
    const next = await fetchSupportMedia(number, m.externalId!, `bytes=${offset}-${offset + CHUNK - 1}`);
    if (!next.ok) throw new Error(`O servidor do WhatsApp parou de entregar o arquivo (${next.status}).`);
    body = Buffer.from(await next.arrayBuffer());
  }
}

/** Run every minute: copies the files saved on the WhatsApp server that are not in the Drive yet. */
export async function copySupportMedia(budgetMs = 40_000) {
  const link = await supportDrive();
  if (!link) return { skipped: "Google Drive não conectado" };
  const until = Date.now() + budgetMs;
  const pending = await db.supportMessage.findMany({
    where: { mediaStatus: "salvo", driveFileId: null, driveTries: { lt: MAX_TRIES }, externalId: { not: null }, chat: { number: { active: true } } },
    orderBy: [{ driveTries: "asc" }, { createdAt: "asc" }],
    take: 20,
    select: { id: true },
  });
  if (!pending.length) return { copied: 0 };
  const token = await accessTokenFrom(link.token);
  let copied = 0;
  for (const { id } of pending) {
    if (Date.now() > until) break;
    try {
      await copyOne(token, link, id);
      copied++;
    } catch (e) {
      // A folder deleted in the Drive: made again on the next round
      if ((e as { status?: number }).status === 404) {
        link.folders = {};
        await db.setting.update({ where: { key: KEY }, data: { value: link } });
      }
      await db.supportMessage.update({ where: { id }, data: { driveTries: { increment: 1 }, driveError: (e as Error).message.slice(0, 300) } });
    }
  }
  return { copied, pending: pending.length };
}
