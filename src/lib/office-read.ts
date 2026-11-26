import { inflateRawSync } from "node:zlib";

/**
 * Reads the text of Office files (.xlsx and .docx) without any library: both are zip files of XML. The secretary uses
 * it to read the reports in her Google Drive folder (inadimplência, produção por seguradora) and answer about them.
 */

/** The files inside a zip, by name (only stored and deflated entries, which is all Office writes). */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory: the last 22 bytes, plus up to 64 KB of comment
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Arquivo não é um zip válido.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()],
  );

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");

// Built-in Excel number formats that are dates
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel's day number (1 = 1900-01-01, with its 1900 leap-year bug) as dd/mm/aaaa, with the time when there is one. */
export function excelDate(serial: number) {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const day = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  const time = d.getUTCHours() || d.getUTCMinutes() ? ` ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}` : "";
  return day + time;
}

const colIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
};

const csvCell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Every sheet of a workbook as CSV text (";" between cells), headed by the sheet's name. */
export function xlsxToText(buf: Buffer, maxRows = 3000) {
  const files = unzip(buf);
  const read = (name: string) => files.get(name)?.toString("utf8") ?? "";
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]));
  // Which cell styles show a date
  const styles = read("xl/styles.xml");
  const customDates = new Set(
    [...styles.matchAll(/<numFmt\s[^>]*>/g)]
      .filter((m) => /[dmy]/i.test(unescapeXml(attr(m[0], "formatCode") ?? "").replace(/"[^"]*"|\[[^\]]*\]/g, "")))
      .map((m) => Number(attr(m[0], "numFmtId"))),
  );
  const xfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyle = [...xfs.matchAll(/<xf\s[^>]*?\/?>/g)].map((m) => {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    return DATE_FORMATS.has(id) || customDates.has(id);
  });
  // Sheet names in the workbook's order, and the file of each one
  const rels = new Map([...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\s[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet\s[^>]*>/g)].map((m) => {
    const target = rels.get(attr(m[0], "r:id")) ?? "";
    return { name: unescapeXml(attr(m[0], "name") ?? "Planilha"), file: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}` };
  });
  const parts: string[] = [];
  for (const sheet of sheets) {
    const xml = read(sheet.file);
    const lines: string[] = [];
    let total = 0;
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = c[1] ?? "";
        const inner = c[2] ?? "";
        const type = attr(tag, "t");
        const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "inlineStr") value = texts(inner);
        else if (type === "b") value = raw === "1" ? "VERDADEIRO" : "FALSO";
        else if (raw !== undefined) {
          const v = unescapeXml(raw);
          const n = Number(v);
          value = type !== "str" && dateStyle[Number(attr(tag, "s") ?? 0)] && Number.isFinite(n) && n > 0 ? excelDate(n) : v;
        }
        const at = colIndex(attr(tag, "r") ?? "");
        while (cells.length < at) cells.push("");
        cells.push(value);
      }
      if (!cells.some((v) => v.trim())) continue;
      total++;
      if (lines.length < maxRows) lines.push(cells.map(csvCell).join(";"));
    }
    parts.push(`## Planilha "${sheet.name}" (${total} linhas${total > maxRows ? `, mostrando as primeiras ${maxRows}` : ""})\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** The text of a Word document, a paragraph per line (tables come cell by cell). */
export function docxToText(buf: Buffer) {
  const xml = unzip(buf).get("word/document.xml")?.toString("utf8") ?? "";
  return xml
    .split(/<\/w:p>/)
    .map((p) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => unescapeXml(m[1])).join(""))
    .filter((line) => line.trim())
    .join("\n");
}
