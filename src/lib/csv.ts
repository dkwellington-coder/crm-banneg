import type { NewLeadInput } from "./leads";

/** Minimal RFC 4180 parser; detects ";" (Excel pt-BR, Kommo) or "," as the delimiter. */
export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^﻿/, "");
  const firstLine = clean.slice(0, clean.indexOf("\n") === -1 ? undefined : clean.indexOf("\n"));
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

function find(row: Record<string, string>, patterns: RegExp[]) {
  for (const p of patterns) {
    for (const [k, v] of Object.entries(row)) if (v && p.test(norm(k))) return v;
  }
  return null;
}

/** A name the AI can greet: no e-mails or placeholders, and "MARIA SILVA" becomes "Maria Silva". */
export function cleanName(raw: string | null) {
  const n = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!n || n.includes("@") || /^sem nome/i.test(n) || !/\p{L}/u.test(n)) return null;
  if (n !== n.toUpperCase() && n !== n.toLowerCase()) return n;
  return n
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "2026-10-02 17:11", "02/10/2026 17:11" or "02.10.2026" in São Paulo time (no daylight saving since 2019). */
export function parseLocalDate(raw: string | null) {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  const br = /^(\d{2})[/.](\d{2})[/.](\d{4})(?:[ T,]+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  const [y, m, d, h, min, sec] = iso
    ? [iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]]
    : br
      ? [br[3], br[2], br[1], br[4], br[5], br[6]]
      : [];
  if (!y) return null;
  const date = new Date(`${y}-${m}-${d}T${h ?? "12"}:${min ?? "00"}:${sec ?? "00"}-03:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const yes = (v: string | null) => /^(sim|s|yes|y|true|1|x)$/i.test((v ?? "").trim());

export type ImportRow = NewLeadInput & {
  lastContactAt: Date | null;
  // Asked not to be contacted: kept in Descartado, never messaged
  optOut: boolean;
  lost: boolean;
  won: boolean;
  // Funnel named in the file ("funil" column), overriding the one the import was started from
  funnel: string | null;
  oldStage: string | null;
  oldStatus: string | null;
};

/** Maps columns from Kommo, RD Station, the old CRM or a hand-made spreadsheet to a lead. */
export function mapRow(row: Record<string, string>): ImportRow {
  const oldStage = find(row, [/^etapa$/, /^etapa do lead/, /^stage$/]);
  const oldStatus = find(row, [/^status$/, /^situacao$/]);
  const status = norm(oldStatus ?? "");
  return {
    name: cleanName(find(row, [/^nome$/, /contato principal/, /^nome do contato/, /^name$/, /nome/])),
    phone: find(row, [/celular/, /whats/, /telefone/, /phone/, /fone/]),
    email: find(row, [/e-?mail/]),
    city: find(row, [/cidade/, /city/]),
    state: find(row, [/^estado$/, /^uf$/, /state/]),
    campaign: find(row, [/campanha/, /utm_campaign/]),
    externalId: find(row, [/^id$/, /id do lead/]),
    source: find(row, [/origem/, /fonte/, /source/]) ?? "importação",
    createdAt: parseLocalDate(find(row, [/^criado_?em$/, /^criado em/, /data de criacao/, /^created/])),
    lastContactAt: parseLocalDate(find(row, [/ultimo_?contato/, /ultimo contato/, /last_?contact/])),
    optOut: yes(find(row, [/nao_?contatar/, /nao contatar/, /opt.?out/])) || /nao contatar/.test(norm(oldStage ?? "")),
    lost: /^(lost|perdido|perdida|descartado)$/.test(status),
    won: /^(won|ganho|ganha|fechado|vendido)$/.test(status),
    funnel: find(row, [/^funil$/, /^pipeline$/]),
    oldStage,
    oldStatus,
  };
}
