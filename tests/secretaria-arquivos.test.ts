// Secretária: files, reports and the team's meetings (Wellington, 2026-11-26). Pure parts: reading Office files, the
// Drive folder link, whose meeting it is and what blocks his time, the nickname, the CSV; and what a collaborator may do.
import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

import { INADIMPLENCIA_XLSX, zip } from "./fixtures/office";
import { docxToText, excelDate, unzip, xlsxToText } from "@/lib/office-read";
import { contentFor, driveQuery, folderIdFrom, matches } from "@/lib/secretary-drive";
import { normalizeArt, renderArt, titleSize } from "@/lib/secretary-art";
import { readFileSync } from "node:fs";
import { overlapping, ownedBy, ownerTitle, type AgendaEvent } from "@/lib/secretary-agenda";
import { reportRange, toCsv } from "@/lib/secretary-report";
import { DEFAULT_SECRETARY, callsHer, mediaKind } from "@/lib/secretary";
import { buildSystemPrompt, runTool, type TurnContext } from "@/lib/secretary-ai";

describe("reading the reports", () => {
  it("reads a workbook: shared and inline strings, dates, gaps, and cells with ;", () => {
    const text = xlsxToText(INADIMPLENCIA_XLSX());
    expect(text).toContain('## Planilha "Inadimplência" (3 linhas)');
    expect(text).toContain("Cliente;Seguradora;Vencimento;Valor");
    expect(text).toContain("João & Filhos;Porto Seguro;26/10/2026;1250.5");
    expect(text).toContain('"Maria; Silva";;;300');
    expect(excelDate(46321.5)).toBe("26/10/2026 12:00");
  });

  it("reads a Word document paragraph by paragraph", () => {
    const docx = zip({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Contrato de franquia</w:t></w:r></w:p><w:p><w:r><w:t>Cláusula 1</w:t></w:r><w:r><w:t xml:space="preserve"> - prazo</w:t></w:r></w:p></w:body></w:document>` });
    expect(docxToText(docx)).toBe("Contrato de franquia\nCláusula 1 - prazo");
    expect([...unzip(docx).keys()]).toEqual(["word/document.xml"]);
  });

  it("hands the model a PDF or picture as is, sheets and CSV as text", () => {
    const pdf = contentFor({ name: "Comissões.pdf", mime: "application/pdf", data: Buffer.from("%PDF") });
    expect(pdf[1]).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: Buffer.from("%PDF").toString("base64") } });
    const sheet = contentFor({ name: "inad.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: INADIMPLENCIA_XLSX() });
    expect(sheet[0]).toMatchObject({ type: "text" });
    expect((sheet[0] as { text: string }).text).toContain("Porto Seguro");
    expect(contentFor({ name: "a.csv", mime: "text/csv", data: Buffer.from("﻿a;b\n1;2") })[0]).toEqual({ type: "text", text: 'Arquivo "a.csv":\na;b\n1;2' });
    expect((contentFor({ name: "a.zip", mime: "application/zip", data: Buffer.from("x") })[0] as { text: string }).text).toContain("posso enviar");
  });

  it("takes the folder from the link he pastes, and finds files by any word of the name or folder", () => {
    expect(folderIdFrom("https://drive.google.com/drive/folders/1mHHLn-D7RSN1ciegL4de-E2iL5DijVSr?usp=sharing")).toBe("1mHHLn-D7RSN1ciegL4de-E2iL5DijVSr");
    expect(folderIdFrom("https://drive.google.com/open?id=1mHHLn-D7RSN1cie")).toBe("1mHHLn-D7RSN1cie");
    expect(folderIdFrom("minha pasta")).toBeNull();
    const f = { name: "base-unica.json", path: "Inadimplência/2026-10" };
    expect(matches(f, "inadimplencia")).toBe(true);
    expect(matches(f, "inadimplência 2026-10")).toBe(true);
    expect(matches(f, "comissões")).toBe(false);
  });

  it("sends pictures and videos inline, the rest as documents", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("application/pdf")).toBe("document");
    expect(mediaKind("text/csv")).toBe("document");
  });
});

describe("the team's meetings on his agenda", () => {
  const ev = (title: string, start: string, end: string, free = false): AgendaEvent => ({
    id: title,
    title,
    startsAt: new Date(`${start}-03:00`),
    endsAt: new Date(`${end}-03:00`),
    meet: null,
    guests: [],
    leadId: null,
    allDay: false,
    free,
  });
  const agenda = [ev("Reunião com lead", "2026-11-27T10:00", "2026-11-27T10:30"), ev("Camila · Porto Seguro", "2026-11-27T14:00", "2026-11-27T15:00", true)];

  it("starts the title with whose meeting it is", () => {
    expect(ownerTitle("Camila", "Reunião com a Porto")).toBe("Camila · Reunião com a Porto");
    expect(ownerTitle("Camila", "camila - alinhamento")).toBe("camila - alinhamento");
    expect(ownerTitle("Camila", "")).toBe("Camila · Reunião");
    expect(ownedBy("Camila · Porto Seguro", "Camila")).toBe(true);
    expect(ownedBy("Camilaa · x", "Camila")).toBe(false);
  });

  it("his time is blocked only by his own meetings; a collaborator's only by that person's", () => {
    const at = (a: string, b: string) => [new Date(`${a}-03:00`), new Date(`${b}-03:00`)] as const;
    expect(overlapping(agenda, ...at("2026-11-27T14:15", "2026-11-27T14:45")).map((e) => e.title)).toEqual([]);
    expect(overlapping(agenda, ...at("2026-11-27T10:15", "2026-11-27T10:45")).map((e) => e.title)).toEqual(["Reunião com lead"]);
    expect(overlapping(agenda, ...at("2026-11-27T10:15", "2026-11-27T10:45"), { owner: "Camila" })).toEqual([]);
    expect(overlapping(agenda, ...at("2026-11-27T14:30", "2026-11-27T15:30"), { owner: "Camila" }).map((e) => e.title)).toEqual(["Camila · Porto Seguro"]);
    expect(overlapping(agenda, ...at("2026-11-27T14:30", "2026-11-27T15:30"), { owner: "Laiane" })).toEqual([]);
  });
});

describe("her nickname and what she knows", () => {
  const s = { ...DEFAULT_SECRETARY, name: "Jessica Montenegro", nicknames: ["Jess"], phone: "5517976027768" };

  it("calling her Jess calls her; a longer name does not", () => {
    expect(callsHer(s, { body: "Jess, marca uma reunião pra mim" })).toBe(true);
    expect(callsHer(s, { body: "jessica me ajuda" })).toBe(true);
    expect(callsHer(s, { body: "a Jessiane chegou" })).toBe(false);
    expect(callsHer({ ...s, nicknames: [] }, { body: "Jess, oi" })).toBe(false);
  });

  it("carries the nickname and the CRM's knowledge base in her prompt", () => {
    const prompt = buildSystemPrompt(s, [], [{ title: "Telemedicina Banneg", content: "Planos a partir de R$ 29,90." }]);
    expect(prompt).toContain('"Jess"');
    expect(prompt).toContain("### Telemedicina Banneg\nPlanos a partir de R$ 29,90.");
    expect(prompt).toContain("buscar_arquivo");
    expect(buildSystemPrompt(s)).not.toContain("O que você sabe do Banneg");
  });
});

describe("reports", () => {
  it("writes CSV for Excel pt-BR and reads the days asked in Brasília", () => {
    expect(toCsv([["Nome", "Obs"], ["Ana", 'disse "oi"; tchau'], ["Bia", null]])).toBe('Nome;Obs\r\nAna;"disse ""oi""; tchau"\r\nBia;');
    const now = new Date("2026-11-26T14:00:00Z");
    const month = reportRange("", "", now);
    expect(month.start.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(month.end.toISOString()).toBe("2026-11-27T03:00:00.000Z");
    const day = reportRange("2026-11-20", "2026-11-20", now);
    expect(day.end.getTime() - day.start.getTime()).toBe(86_400_000);
  });
});

describe("what a collaborator may ask", () => {
  const ctx: TurnContext = {
    s: { ...DEFAULT_SECRETARY, group: { id: "g@g.us", name: "Sócios" } },
    chatId: "5517992223333@s.whatsapp.net",
    isGroup: false,
    member: { name: "Camila", phone: "17992223333", email: "", role: "colaborador" },
    contact: { phone: "5517992223333", name: "Camila" },
    actor: "Camila",
    now: new Date("2026-11-26T14:00:00Z"),
  };

  it("cannot book a CRM lead's meeting or send files to someone else", async () => {
    await expect(runTool("marcar_reuniao", { titulo: "x", inicio: "2026-11-27T10:00", lead_id: "abc" }, ctx)).rejects.toThrow("lead do CRM");
    await expect(runTool("enviar_arquivo", { material: "tabela_comissoes", para: "Franklin" }, ctx)).rejects.toThrow("Colaborador recebe o arquivo aqui");
  });

  it("someone from outside cannot open files or reports", async () => {
    const outside = { ...ctx, member: null };
    await expect(runTool("buscar_arquivo", {}, outside)).rejects.toThrow("Só a equipe");
    await expect(runTool("relatorio", { tipo: "leads" }, outside)).rejects.toThrow("Só a equipe");
  });
});

describe("arts", () => {
  it("keeps what the AI asks within what fits, with Banneg's defaults", () => {
    const a = normalizeArt({ titulo: "  Black   Banneg ", formato: "banner", tema: "rosa", chamada: "oferta", itens: ["a", "", "b", "c", "d", "e", "f"] });
    expect(a).toMatchObject({ formato: "post", tema: "azul", titulo: "Black Banneg", chamada: "OFERTA", rodape: "banneg.com.br" });
    expect(a.itens).toEqual(["a", "b", "c", "d", "e"]);
    expect(() => normalizeArt({ titulo: " " })).toThrow("título");
    expect(titleSize("Black Banneg", 1080, false)).toBeGreaterThan(titleSize("Um título bem mais comprido que precisa caber em três linhas na arte", 1080, false));
  });

  it("draws a real PNG in each format", async () => {
    const ab = (p: string) => {
      const b = readFileSync(p);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;
    };
    const logo = `data:image/png;base64,${readFileSync("public/brand/monograma-dourado.png").toString("base64")}`;
    const assets = { fonts: ([400, 700, 800] as const).map((w) => ({ weight: w, data: ab(`public/brand/fonts/montserrat-${w}.woff`) })), logoGold: logo, logoBlue: logo };
    const png = await renderArt({ formato: "story", tema: "claro", titulo: "Telemedicina Banneg", itens: ["24h"], destaque: "R$ 29,90" }, assets);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1920]);
  }, 30_000);

  it("searches the whole Drive word by word, safely quoted", () => {
    expect(driveQuery("contrato d'Ávila")).toBe(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder' and (name contains 'contrato' or fullText contains 'contrato') and (name contains 'd\\'Ávila' or fullText contains 'd\\'Ávila')",
    );
    expect(driveQuery("")).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
  });
});
