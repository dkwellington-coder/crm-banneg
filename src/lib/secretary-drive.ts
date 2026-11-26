import { db } from "./db";
import { accessTokenFrom, googleCodeToLink, type GoogleLink } from "./google";
import { docxToText, xlsxToText } from "./office-read";
import type { SecretaryFile } from "./secretary";

/**
 * Jessica's Google Drive (2026-11-26, Wellington: "Tudo para sócios, pasta p/ equipe"): the partners may ask any file of
 * his Drive; the collaborators only see the team folder chosen on the Secretária screen.
 *
 * Jessica's Google Drive folder (Wellington, 2026-11-26): the other Claude tabs (Marketing, Download comissões) save
 * their reports in a Drive folder, and she finds, reads and sends them when the team asks ("manda o relatório de
 * inadimplência", "quais seguradoras foram feitas"). She sees only that folder and what is inside it, never the rest.
 * drive.readonly: the folder's files were made by other tools, so drive.file (only the CRM's own files) cannot see them.
 */
export const SECRETARY_DRIVE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/drive.readonly"];
const KEY = "secretaria_drive";
const FOLDER = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3/files";

export type SecretaryDrive = GoogleLink & { folderId?: string | null; folderName?: string | null };

export type DriveEntry = { id: string; name: string; mimeType: string; modifiedTime: string; size: number | null; path: string };

export async function secretaryDrive() {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  return row ? (row.value as SecretaryDrive) : null;
}

async function save(link: SecretaryDrive) {
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: link }, update: { value: link } });
}

export async function connectSecretaryDrive(code: string, redirectUri: string) {
  const before = await secretaryDrive();
  const link: SecretaryDrive = { ...(await googleCodeToLink(code, redirectUri)), folderId: before?.folderId ?? null, folderName: before?.folderName ?? null };
  await save(link);
  return link;
}

export async function disconnectSecretaryDrive() {
  await db.setting.deleteMany({ where: { key: KEY } });
}

/** The folder's id from what was pasted: its link in the Drive (…/folders/<id>), a link with ?id=, or the id itself. */
export function folderIdFrom(input: string) {
  const v = input.trim();
  const m = v.match(/\/folders\/([\w-]{10,})/) ?? v.match(/[?&]id=([\w-]{10,})/);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(v) ? v : null;
}

async function drive<T>(token: string, url: string | URL): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Drive respondeu ${res.status}: ${json.error?.message ?? "erro"}`);
  return json;
}

/** all: the whole Drive (partners); otherwise only the team folder (collaborators). */
export type DriveScope = { all?: boolean };

async function tokenAndFolder(scope: DriveScope = {}) {
  const link = await secretaryDrive();
  if (!link) throw new Error("O Google Drive da secretária não está conectado (tela Secretária > Google Drive).");
  if (!scope.all && !link.folderId) throw new Error("A equipe só vê a pasta da equipe, e ela ainda não foi escolhida na tela Secretária.");
  return { token: await accessTokenFrom(link.token), folderId: link.folderId ?? null, link };
}

/** Saves the folder she reads, after checking that the connected Google account sees it and that it is a folder. */
export async function setSecretaryFolder(input: string) {
  const link = await secretaryDrive();
  if (!link) throw new Error("Conecte o Google Drive primeiro.");
  const id = folderIdFrom(input);
  if (!id) throw new Error("Cole o link da pasta do Google Drive (drive.google.com/drive/folders/...).");
  const token = await accessTokenFrom(link.token);
  const meta = await drive<{ id: string; name: string; mimeType: string }>(token, `${API}/${id}?fields=id,name,mimeType&supportsAllDrives=true`);
  if (meta.mimeType !== FOLDER) throw new Error(`"${meta.name}" é um arquivo, não uma pasta.`);
  await save({ ...link, folderId: meta.id, folderName: meta.name });
  return meta.name;
}

const plain = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether every word searched is in the file's name or folder path ("inadimplencia outubro" finds "Inadimplência/2026-10"). */
export function matches(entry: Pick<DriveEntry, "name" | "path">, search: string) {
  const hay = plain(`${entry.path} ${entry.name}`);
  return plain(search)
    .split(/[\s,/_-]+/)
    .filter((w) => w.length >= 2)
    .every((w) => hay.includes(w));
}

type RawFile = { id: string; name: string; mimeType: string; modifiedTime: string; size?: string };

/** The Drive query for a search in the whole Drive: every word in the name or the text, files only. */
export function driveQuery(search: string) {
  const words = search
    .split(/[\s,/_-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 6)
    .map((w) => w.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
  return ["trashed = false", "mimeType != 'application/vnd.google-apps.folder'", ...words.map((w) => `(name contains '${w}' or fullText contains '${w}')`)].join(" and ");
}

/** Searching the whole Drive (partners): newest first, up to 30. */
async function searchWholeDrive(token: string, search: string) {
  const url = new URL(API);
  url.searchParams.set("q", driveQuery(search));
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size)");
  url.searchParams.set("pageSize", "30");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("corpora", "allDrives");
  // Google refuses ordering a fullText search: only plain listings come newest first
  if (!search.trim()) url.searchParams.set("orderBy", "modifiedTime desc");
  const page = await drive<{ files?: RawFile[] }>(token, url);
  return (page.files ?? [])
    .map((x) => ({ id: x.id, name: x.name, mimeType: x.mimeType, modifiedTime: x.modifiedTime, size: x.size ? Number(x.size) : null, path: "" }))
    .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
}

/** Everything inside her folder (sub-folders too, up to 4 levels and 600 files), newest first; partners search the whole Drive. */
export async function listDriveFiles(search = "", scope: DriveScope = {}) {
  const { token, folderId } = await tokenAndFolder(scope);
  if (scope.all) {
    const everywhere = await searchWholeDrive(token, search);
    if (!folderId) return everywhere;
    // The team folder's files keep their path, so a report saved there is easy to tell apart
    const inFolder = (await listInFolder(token, folderId, search)).slice(0, 30);
    const ids = new Set(inFolder.map((f) => f.id));
    return [...inFolder, ...everywhere.filter((f) => !ids.has(f.id))].sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
  }
  return listInFolder(token, folderId!, search);
}

async function listInFolder(token: string, folderId: string, search: string) {
  const found: DriveEntry[] = [];
  let level: { id: string; path: string }[] = [{ id: folderId, path: "" }];
  for (let depth = 0; depth < 5 && level.length && found.length < 600; depth++) {
    const next: { id: string; path: string }[] = [];
    for (const f of level.slice(0, 40)) {
      let pageToken: string | undefined;
      do {
        const url = new URL(API);
        url.searchParams.set("q", `'${f.id}' in parents and trashed = false`);
        url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,modifiedTime,size)");
        url.searchParams.set("pageSize", "200");
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const page = await drive<{ files?: RawFile[]; nextPageToken?: string }>(token, url);
        for (const x of page.files ?? []) {
          const path = f.path ? `${f.path}/${x.name}` : x.name;
          if (x.mimeType === FOLDER) next.push({ id: x.id, path });
          else found.push({ id: x.id, name: x.name, mimeType: x.mimeType, modifiedTime: x.modifiedTime, size: x.size ? Number(x.size) : null, path: f.path });
        }
        pageToken = page.nextPageToken;
      } while (pageToken && found.length < 600);
    }
    level = next;
  }
  return found.filter((e) => !search.trim() || matches(e, search)).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
}

const fileMeta = (token: string, fileId: string) =>
  drive<RawFile>(token, `${API}/${fileId}?fields=id,name,mimeType,modifiedTime,size&supportsAllDrives=true`);

/** A file, only when it really is inside her folder (its parents lead up to it). */
async function insideFolder(token: string, folderId: string, fileId: string) {
  const meta = await drive<RawFile & { parents?: string[] }>(token, `${API}/${fileId}?fields=id,name,mimeType,modifiedTime,size,parents&supportsAllDrives=true`);
  let parents = meta.parents ?? [];
  for (let i = 0; i < 8 && parents.length; i++) {
    if (parents.includes(folderId)) return meta;
    const up = await drive<{ parents?: string[] }>(token, `${API}/${parents[0]}?fields=parents&supportsAllDrives=true`);
    parents = up.parents ?? [];
  }
  throw new Error("Esse arquivo não está na pasta da secretária.");
}

// Google's own files are exported: to read (text) or to send (a file people open anywhere)
const EXPORT: Record<string, { read: string; send: string; ext: string }> = {
  "application/vnd.google-apps.document": { read: "text/plain", send: "application/pdf", ext: "pdf" },
  "application/vnd.google-apps.spreadsheet": { read: "text/csv", send: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { read: "text/plain", send: "application/pdf", ext: "pdf" },
};
const MAX_BYTES = 25 * 1024 * 1024;

async function download(token: string, meta: RawFile, purpose: "read" | "send") {
  const exp = EXPORT[meta.mimeType];
  const url = exp
    ? `${API}/${meta.id}/export?mimeType=${encodeURIComponent(exp[purpose])}`
    : `${API}/${meta.id}?alt=media&supportsAllDrives=true`;
  if (!exp && meta.mimeType.startsWith("application/vnd.google-apps.")) throw new Error("Esse tipo de arquivo do Google não dá para baixar.");
  if (Number(meta.size ?? 0) > MAX_BYTES) throw new Error("Arquivo maior que 25 MB: mande o link do Drive.");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Google Drive não entregou o arquivo (HTTP ${res.status}).`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_BYTES) throw new Error("Arquivo maior que 25 MB: mande o link do Drive.");
  const mime = exp ? exp[purpose] : meta.mimeType;
  const name = exp && purpose === "send" && !meta.name.toLowerCase().endsWith(`.${exp.ext}`) ? `${meta.name}.${exp.ext}` : meta.name;
  return { data, mime, name };
}

/** The file as it goes out on WhatsApp. */
export async function driveFileToSend(fileId: string, scope: DriveScope = {}): Promise<SecretaryFile> {
  const { token, folderId } = await tokenAndFolder(scope);
  const meta = scope.all ? await fileMeta(token, fileId) : await insideFolder(token, folderId!, fileId);
  return download(token, meta, "send");
}

export type ReadContent =
  | { type: "text"; text: string }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };

const MAX_TEXT = 80_000;
const cut = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n[… arquivo cortado: mostrando os primeiros ${MAX_TEXT} caracteres]` : t);
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What she reads of a file: text for sheets, documents and CSV; the PDF or the picture itself for the model to look at. */
export function contentFor(file: { name: string; mime: string; data: Buffer }): ReadContent[] {
  const head: ReadContent = { type: "text", text: `Arquivo "${file.name}":` };
  const lower = file.name.toLowerCase();
  if (file.mime === "application/pdf" || lower.endsWith(".pdf"))
    return [head, { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data.toString("base64") } }];
  if (/^image\/(jpeg|png|gif|webp)$/.test(file.mime)) {
    if (file.data.length > 5 * 1024 * 1024) return [{ type: "text", text: `A imagem "${file.name}" é grande demais para eu ver (mais de 5 MB).` }];
    return [head, { type: "image", source: { type: "base64", media_type: file.mime as "image/png", data: file.data.toString("base64") } }];
  }
  if (file.mime === XLSX || lower.endsWith(".xlsx")) return [{ type: "text", text: `${head.text}\n${cut(xlsxToText(file.data))}` }];
  if (file.mime === DOCX || lower.endsWith(".docx")) return [{ type: "text", text: `${head.text}\n${cut(docxToText(file.data))}` }];
  if (file.mime.startsWith("text/") || /json|xml|csv/.test(file.mime) || /\.(csv|txt|json|md)$/.test(lower))
    return [{ type: "text", text: `${head.text}\n${cut(file.data.toString("utf8").replace(/^﻿/, ""))}` }];
  return [{ type: "text", text: `Não consigo ler arquivos "${file.mime}" (${file.name}), mas posso enviar o arquivo.` }];
}

export async function readDriveFile(fileId: string, scope: DriveScope = {}) {
  const { token, folderId } = await tokenAndFolder(scope);
  const meta = scope.all ? await fileMeta(token, fileId) : await insideFolder(token, folderId!, fileId);
  const file = await download(token, meta, "read");
  return contentFor(file);
}
