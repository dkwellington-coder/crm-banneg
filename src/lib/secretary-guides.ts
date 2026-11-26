import { db } from "./db";
import { driveDocText } from "./secretary-drive";

/**
 * Banneg's standard guides (Wellington, 2026-11-26): the "Guia de Marketing Banneg" and the "Guia de Consórcios Banneg"
 * his other Claude projects wrote in Google Docs. Jessica reads them (guia_banneg) before making arts, captions, videos
 * or answering about consórcio, so she keeps the same standard. Kept in Setting "secretaria_guias"; "Atualizar" reads
 * the Docs again through her Google Drive.
 */
export type Guide = { nome: string; docId: string; texto: string; lidoEm: string };

const KEY = "secretaria_guias";
const MAX_CHARS = 60_000;

export async function getGuides(): Promise<Guide[]> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  const list = (row?.value as { guias?: Guide[] } | null)?.guias;
  return Array.isArray(list) ? list : [];
}

async function save(guias: Guide[]) {
  const value = { guias };
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

/** The Google Docs id from a link (docs.google.com/document/d/ID/...) or the bare id. */
export function docIdFrom(input: string) {
  const v = input.trim();
  const m = v.match(/\/document\/d\/([\w-]{20,})/) ?? v.match(/[?&]id=([\w-]{20,})/) ?? v.match(/^([\w-]{20,})$/);
  return m ? m[1] : null;
}

const norm = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** The guide whose name matches what she asked ("marketing", "consórcio"), or null. */
export function findGuide(guias: Guide[], name: string) {
  const n = norm(name);
  if (!n) return null;
  return guias.find((g) => norm(g.nome) === n) ?? guias.find((g) => norm(g.nome).includes(n) || n.includes(norm(g.nome))) ?? guias.find((g) => n.split(/\s+/).some((w) => w.length > 3 && norm(g.nome).includes(w.replace(/s$/, "")))) ?? null;
}

/** Adds (or reads again) a guide from its Google Docs link. */
export async function addGuide(nome: string, link: string) {
  const docId = docIdFrom(link);
  if (!docId) throw new Error("Cole o link do Google Docs (docs.google.com/document/d/...).");
  const texto = (await driveDocText(docId)).slice(0, MAX_CHARS);
  const guias = await getGuides();
  const guide: Guide = { nome: nome.trim() || "Guia", docId, texto, lidoEm: new Date().toISOString() };
  await save([...guias.filter((g) => g.docId !== docId), guide]);
  return guide;
}

/** Reads every guide again from Google Docs. Returns the ones that failed, with why. */
export async function refreshGuides() {
  const guias = await getGuides();
  const failed: string[] = [];
  const fresh: Guide[] = [];
  for (const g of guias) {
    try {
      fresh.push({ ...g, texto: (await driveDocText(g.docId)).slice(0, MAX_CHARS), lidoEm: new Date().toISOString() });
    } catch (e) {
      failed.push(`${g.nome}: ${(e as Error).message}`);
      fresh.push(g);
    }
  }
  await save(fresh);
  return failed;
}

export async function removeGuide(docId: string) {
  await save((await getGuides()).filter((g) => g.docId !== docId));
}
