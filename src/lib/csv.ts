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

/** Maps columns from Kommo, RD Station or a hand-made spreadsheet to a lead. */
export function mapRow(row: Record<string, string>): NewLeadInput {
  return {
    name: find(row, [/^nome$/, /contato principal/, /^nome do contato/, /^name$/, /nome/]),
    phone: find(row, [/celular/, /whats/, /telefone/, /phone/, /fone/]),
    email: find(row, [/e-?mail/]),
    city: find(row, [/cidade/, /city/]),
    state: find(row, [/^estado$/, /^uf$/, /state/]),
    campaign: find(row, [/campanha/, /utm_campaign/]),
    externalId: find(row, [/^id$/, /id do lead/]),
    source: find(row, [/origem/, /fonte/, /source/]) ?? "importação",
  };
}
