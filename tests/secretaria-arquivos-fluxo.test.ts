// Secretária, end to end with Google (Wellington, 2026-11-26): Camila asks in private for a Meet link for her own
// meeting (on his agenda, her name first, shown as free), then for the inadimplência report from the Drive folder,
// and a spreadsheet of the CRM's leads. Google, the WhatsApp server and the AI are stubbed. Runs with TEST_DATABASE_URL.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { INADIMPLENCIA_XLSX } from "./fixtures/office";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.CRON_SECRET = "segredo-de-teste";
process.env.SUPPORT_WA_URL = "https://wa.banneg.app/";
process.env.SUPPORT_WA_ADMIN_TOKEN = "admin";
process.env.GOOGLE_CLIENT_ID = "cliente";
process.env.GOOGLE_CLIENT_SECRET = "segredo";

vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => "id1") }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

const script: unknown[] = [];
const seen: { system: string; messages: { content: unknown }[] }[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = {
      messages: {
        create: async (req: { system: { text: string }[]; messages: { content: unknown }[] }) => {
          seen.push({ system: req.system[0].text, messages: structuredClone(req.messages) });
          const next = script.shift();
          if (!next) throw new Error("sem resposta roteirizada");
          return next;
        },
      },
    };
  },
}));

const CAMILA = "5517992223333";
const FOLDER = "pastaJessica123";
const pm = (id: string, text: string) => ({
  EventType: "messages",
  message: { chatid: `${CAMILA}@s.whatsapp.net`, messageid: id, isGroup: false, fromMe: false, messageTimestamp: Date.now(), text, senderName: "Camila", sender_pn: `${CAMILA}@s.whatsapp.net` },
  chat: { phone: CAMILA },
});

describe.skipIf(!dbUrl)("Jessica: the team's Meet links, the Drive reports and the CRM spreadsheets", () => {
  let db: typeof import("@/lib/db").db;
  let sec: typeof import("@/lib/secretary");
  let ai: typeof import("@/lib/secretary-ai");
  const texts: { number: string; text: string }[] = [];
  const media: { number: string; type: string; file: string; docName: string; mimetype: string; text: string }[] = [];
  const events: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    sec = await import("@/lib/secretary");
    ai = await import("@/lib/secretary-ai");
    vi.stubGlobal("fetch", async (input: string | URL, init: { method?: string; body?: unknown } = {}) => {
      const url = new URL(String(input));
      const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
      if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "at" });
      if (url.pathname === "/send/text") return texts.push(body), Response.json({ messageid: `T${texts.length}` });
      if (url.pathname === "/send/media") return media.push(body), Response.json({ messageid: `M${media.length}` });
      if (url.pathname === "/instance/status") return Response.json({ instance: { status: "connected" }, status: { connected: true } });
      if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/")) {
        if (init.method === "POST") return events.push(body), Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
        return Response.json({ items: [{ id: "ev0", summary: "Reunião do Wellington", start: { dateTime: "2026-11-27T13:00:00Z" }, end: { dateTime: "2026-11-27T14:00:00Z" } }] });
      }
      if (url.host === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files")) {
        const q = url.searchParams.get("q") ?? "";
        if (q.includes(`'${FOLDER}' in parents`))
          return Response.json({ files: [{ id: "sub1", name: "Inadimplência", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-11-20T10:00:00Z" }] });
        if (q.includes("'sub1' in parents"))
          return Response.json({
            files: [
              { id: "f1", name: "inadimplencia-novembro.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", modifiedTime: "2026-11-25T10:00:00Z", size: "900" },
              { id: "f2", name: "inadimplencia-outubro.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", modifiedTime: "2026-10-25T10:00:00Z", size: "900" },
            ],
          });
        if (url.pathname.endsWith("/f1") && url.searchParams.get("alt") === "media") return new Response(new Uint8Array(INADIMPLENCIA_XLSX()));
        if (url.pathname.endsWith("/f1")) return Response.json({ id: "f1", name: "inadimplencia-novembro.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", modifiedTime: "2026-11-25T10:00:00Z", size: "900", parents: ["sub1"] });
        if (url.pathname.endsWith("/sub1")) return Response.json({ parents: [FOLDER] });
        if (url.pathname.endsWith("/fora")) return Response.json({ id: "fora", name: "segredo.pdf", mimeType: "application/pdf", modifiedTime: "2026-11-25T10:00:00Z", parents: ["outraPasta"] });
        if (url.pathname.endsWith("/outraPasta")) return Response.json({ parents: [] });
      }
      return Response.json({ ok: true });
    });
  });

  beforeEach(async () => {
    texts.length = 0;
    media.length = 0;
    events.length = 0;
    script.length = 0;
    seen.length = 0;
    await db.$executeRawUnsafe('TRUNCATE "User","Setting","Job","SecretaryMessage","SecretaryTask","SecretaryEmail","KnowledgeItem" CASCADE');
    const owner = await db.user.create({ data: { name: "Wellington Gayde", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    const google = await import("@/lib/google");
    const { sealToken } = await import("@/lib/support");
    await db.setting.create({ data: { key: `google:${owner.id}`, value: { email: "wellington@banneg.com.br", connectedAt: "2026-11-01", token: google.sealToken("rt") } } });
    await db.setting.create({ data: { key: "secretaria_drive", value: { email: "wellington@banneg.com.br", connectedAt: "2026-11-26", token: google.sealToken("rt2"), folderId: FOLDER, folderName: "Jessica" } } });
    await db.knowledgeItem.create({ data: { title: "Telemedicina Banneg", content: "Planos individuais e familiares." } });
    await sec.saveSecretary({
      token: sealToken("tok-sec"),
      webhookKey: "chave",
      group: { id: "120363009999@g.us", name: "Sócios" },
      name: "Jessica Montenegro",
      privates: true,
      members: [
        { name: "Wellington", phone: "17981600088", email: "wellington@banneg.com.br", role: "socio" },
        { name: "Camila", phone: "17992223333", email: "camila@banneg.com.br", role: "colaborador" },
      ],
    });
  });

  it("books Camila's Meet on his agenda with her name first, shown as free, and over his own meeting", async () => {
    await sec.receiveSecretary("chave", pm("C1", "Jess, me gera um link do Meet amanhã 10h pra reunião com a Porto Seguro"));
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "marcar_reuniao", input: { titulo: "Reunião com a Porto Seguro", inicio: "2026-11-27T10:00", duracao_minutos: 60 } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Pronto, Camila! Amanhã 10h: https://meet.google.com/abc-defg-hij" }] },
    );
    await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:00Z"));
    // His own 10h meeting does not stop hers: she does not take his time
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ summary: "Camila · Reunião com a Porto Seguro", transparency: "transparent" });
    const result = seen[1].messages.at(-1)!.content as { content: string }[];
    expect(result[0].content).toContain("aparece como livre para o Wellington");
    expect(seen[0].system).toContain("### Telemedicina Banneg");
    expect(texts[0]).toEqual({ number: `${CAMILA}@s.whatsapp.net`, text: "Pronto, Camila! Amanhã 10h: https://meet.google.com/abc-defg-hij" });
    // His meeting is not hers: she cannot cancel or move it
    const ctx = { s: await sec.getSecretary(), chatId: `${CAMILA}@s.whatsapp.net`, isGroup: false, member: { name: "Camila", phone: "17992223333", email: "", role: "colaborador" as const }, contact: { phone: CAMILA, name: "Camila" }, actor: "Camila", now: new Date("2026-11-26T14:00:00Z") };
    await expect(ai.runTool("desmarcar_reuniao", { evento_id: "ev0" }, ctx)).rejects.toThrow("só desmarca as reuniões dele");
    await expect(ai.runTool("remarcar_reuniao", { evento_id: "ev0", novo_inicio: "2026-11-27T11:00" }, ctx)).rejects.toThrow("só remarca");
  });

  it("finds the newest inadimplência report in the folder, reads it and sends it to her", async () => {
    await sec.receiveSecretary("chave", pm("C2", "Jess, me manda o relatório de inadimplência e quais seguradoras tem lá"));
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buscar_arquivo", input: { busca: "inadimplencia" } }] },
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t2", name: "ler_arquivo", input: { arquivo_id: "f1" } },
          { type: "tool_use", id: "t3", name: "enviar_arquivo", input: { arquivo_id: "f1", legenda: "Inadimplência de novembro" } },
          { type: "tool_use", id: "t4", name: "ler_arquivo", input: { arquivo_id: "fora" } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Segue! Seguradora: Porto Seguro." }] },
    );
    await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:00Z"));
    const found = (seen[1].messages.at(-1)!.content as { content: string }[])[0].content;
    expect(found.indexOf("inadimplencia-novembro.xlsx")).toBeLessThan(found.indexOf("inadimplencia-outubro.xlsx"));
    expect(found).toContain("pasta Inadimplência");
    const [read, send, outside] = seen[2].messages.at(-1)!.content as { content: unknown; is_error?: boolean }[];
    expect(JSON.stringify(read.content)).toContain("Porto Seguro");
    expect(send.content).toBe("Enviado aqui: inadimplencia-novembro.xlsx.");
    expect(outside).toMatchObject({ is_error: true });
    expect(JSON.stringify(outside.content)).toContain("não está na pasta");
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ number: `${CAMILA}@s.whatsapp.net`, type: "document", docName: "inadimplencia-novembro.xlsx", text: "Inadimplência de novembro" });
    expect(Buffer.from(media[0].file, "base64").equals(INADIMPLENCIA_XLSX())).toBe(true);
    expect(await db.secretaryMessage.count({ where: { fromMe: true, body: { contains: "[Arquivo enviado: inadimplencia-novembro.xlsx]" } } })).toBe(1);
  });

  it("sends the CRM's tasks as a spreadsheet that opens in Excel", async () => {
    await db.secretaryTask.create({ data: { title: "Ligar para a Porto", assignee: "Camila", dueAt: new Date("2026-11-25T15:00:00Z") } });
    await db.secretaryTask.create({ data: { title: "Tarefa de outra pessoa", assignee: "Laiane" } });
    await sec.receiveSecretary("chave", pm("C3", "Jess, manda minhas tarefas em planilha"));
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "relatorio", input: { tipo: "tarefas", formato: "planilha" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Mandei a planilha." }] },
    );
    await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:00Z"));
    expect(media[0]).toMatchObject({ type: "document", mimetype: "text/csv", docName: "Banneg - Tarefas 2026-11-26.csv" });
    const csv = Buffer.from(media[0].file, "base64").toString("utf8");
    expect(csv.startsWith("﻿Tarefa;Tipo;Responsável")).toBe(true);
    expect(csv).toContain("Ligar para a Porto;tarefa;Camila");
    // A collaborator sees only her own tasks
    expect(csv).not.toContain("Laiane");
  });
});
