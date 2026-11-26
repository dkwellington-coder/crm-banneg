// Secretária, end to end with Google (Wellington, 2026-11-26): Camila asks in private for a Meet link for her own
// meeting (on his agenda, her name first, shown as free), then for the inadimplência report from the Drive folder,
// and a spreadsheet of the CRM's leads. Google, the WhatsApp server and the AI are stubbed. Runs with TEST_DATABASE_URL.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { INADIMPLENCIA_XLSX } from "./fixtures/office";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.CRON_SECRET = "segredo-de-teste";
process.env.SUPPORT_WA_URL = "https://wa.banneg.app/";
process.env.SUPPORT_WA_ADMIN_TOKEN = "admin";
process.env.GOOGLE_CLIENT_ID = "cliente";
process.env.GOOGLE_CLIENT_SECRET = "segredo";
process.env.GROQ_API_KEY = "groq";

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
  const slides: { images: string[]; width: number; height: number; seconds: number }[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    sec = await import("@/lib/secretary");
    ai = await import("@/lib/secretary-ai");
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL, init: { method?: string; body?: unknown } = {}) => {
      const url = new URL(String(input));
      // The image renderer loads its own WebAssembly (data: and file: links)
      if (!url.protocol.startsWith("http")) return realFetch(input, init as RequestInit);
      const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
      if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "at" });
      // The fonts and the monograms of the arts, from the CRM's public folder
      if (url.pathname.startsWith("/brand/")) return new Response(new Uint8Array(readFileSync(`public${url.pathname}`)));
      if (url.pathname.startsWith("/materiais/")) return new Response(new Uint8Array(readFileSync(`public${url.pathname}`)), { headers: { "content-type": "image/jpeg" } });
      // Files that arrived on her number, and the server's video work
      if (url.pathname === "/media") {
        const id = url.searchParams.get("id");
        if (id === "IMG1" || id === "IMG2") return new Response(new Uint8Array(readFileSync("public/materiais/fachada-loja.jpg")), { headers: { "content-type": "image/jpeg" } });
        if (id === "PDF1") return new Response(new Uint8Array(Buffer.from("%PDF-1.4 boleto")), { headers: { "content-type": "application/pdf" } });
        return new Response("não", { status: 404 });
      }
      if (url.pathname === "/media/convert")
        return body.to === "audio" ? Response.json({ mimetype: "audio/mpeg", data: Buffer.from("mp3").toString("base64") }) : Response.json({ mimetype: "image/jpeg", data: Buffer.from("cenas").toString("base64") });
      if (url.pathname === "/video/slideshow") return slides.push(body), Response.json({ mimetype: "video/mp4", data: Buffer.from("....ftypmp4").toString("base64") });
      if (url.host === "api.groq.com") return Response.json({ text: "Olha a fachada da loja nova" });
      if (url.pathname === "/send/text") return texts.push(body), Response.json({ messageid: `T${texts.length}` });
      if (url.pathname === "/send/media") return media.push(body), Response.json({ messageid: `M${media.length}` });
      if (url.pathname === "/instance/status") return Response.json({ instance: { status: "connected" }, status: { connected: true } });
      if (url.host === "www.googleapis.com" && url.pathname.startsWith("/calendar/")) {
        if (init.method === "POST") return events.push(body), Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
        return Response.json({ items: [{ id: "ev0", summary: "Reunião do Wellington", start: { dateTime: "2026-11-27T13:00:00Z" }, end: { dateTime: "2026-11-27T14:00:00Z" } }] });
      }
      if (url.host === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files")) {
        const q = url.searchParams.get("q") ?? "";
        // The partners search the whole Drive
        if (url.searchParams.get("corpora") === "allDrives")
          return Response.json({ files: q.includes("contrato") ? [{ id: "fora", name: "Contrato social.pdf", mimeType: "application/pdf", modifiedTime: "2026-11-01T10:00:00Z", size: "10" }] : [] });
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
        if (url.pathname.endsWith("/fora") && url.searchParams.get("alt") === "media") return new Response(new Uint8Array(Buffer.from("%PDF-1.4 contrato")));
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
    slides.length = 0;
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

  it("a partner finds and gets any file of his Drive, outside the team folder", async () => {
    await sec.receiveSecretary("chave", { ...pm("W1", "Jess, me manda o contrato social"), message: { ...pm("W1", "x").message, chatid: "5517981600088@s.whatsapp.net", text: "Jess, me manda o contrato social", senderName: "Wellington", sender_pn: "5517981600088@s.whatsapp.net" }, chat: { phone: "5517981600088" } });
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buscar_arquivo", input: { busca: "contrato social" } }] },
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t2", name: "enviar_arquivo", input: { arquivo_id: "fora" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Segue o contrato." }] },
    );
    await ai.runSecretaryTurn("5517981600088@s.whatsapp.net", new Date("2026-11-26T14:00:00Z"));
    const found = (seen[1].messages.at(-1)!.content as { content: string }[])[0].content;
    expect(found).toContain("No Google Drive do Wellington");
    expect(found).toContain("fora · Contrato social.pdf");
    expect(media[0]).toMatchObject({ number: "5517981600088@s.whatsapp.net", docName: "segredo.pdf", mimetype: "application/pdf" });
  });

  it("makes a post in Banneg's look, with a CRM photo behind, and sends it as a picture", async () => {
    await sec.receiveSecretary("chave", pm("C4", "Jess, faz um post da inauguração da loja"));
    script.push(
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "criar_arte",
            input: { formato: "post", chamada: "Evento", titulo: "Inauguração da nova loja", texto: "Venha conhecer o Banneg.", foto: "foto_fachada", legenda: "Te esperamos!" },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Pronto, mandei o post!" }] },
    );
    await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:00Z"));
    const result = (seen[1].messages.at(-1)!.content as { content: string; is_error?: boolean }[])[0];
    expect(result.content).toBe("Arte enviada aqui (post, tema azul).");
    expect(media[0]).toMatchObject({ number: `${CAMILA}@s.whatsapp.net`, type: "image", mimetype: "image/png", docName: "Banneg - Inauguração da nova loja.png", text: "Te esperamos!" });
    const png = Buffer.from(media[0].file, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1080);
    expect(png.readUInt32BE(20)).toBe(1350);
  });

  it("sees the photo Camila sends, opens her video, and makes a montage and a short video with them", async () => {
    const at = new Date("2026-11-26T13:59:00Z").getTime();
    const photo = (id: string, text = "") => ({ ...pm(id, text), message: { ...pm(id, text).message, mediaType: "image", type: "media", messageTimestamp: at } });
    await sec.receiveSecretary("chave", photo("IMG1", "Jess, o que você acha dessa foto?"));
    await sec.receiveSecretary("chave", photo("IMG2"));
    await sec.receiveSecretary("chave", { ...pm("VID1", "olha o vídeo"), message: { ...pm("VID1", "olha o vídeo").message, mediaType: "video", type: "media", messageTimestamp: at } });
    // Her turn waits for the pictures to download
    expect(await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:00Z"))).toContain("Esperando");
    for (const id of ["IMG1", "IMG2", "VID1"]) await sec.receiveSecretary("chave", { EventType: "media", message: { chatid: `${CAMILA}@s.whatsapp.net`, messageid: id }, media: { saved: true } });
    const [img1, img2, vid] = await db.secretaryMessage.findMany({ where: { externalId: { in: ["IMG1", "IMG2", "VID1"] } }, orderBy: { externalId: "asc" } }).then((r) => [r[0], r[1], r[2]]);
    expect([img1.kind, img1.mediaStatus, vid.kind]).toEqual(["image", "salvo", "video"]);
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "ver_midia", input: { midia_id: vid.id } }] },
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t2", name: "juntar_imagens", input: { imagens: [img1.id, img2.id, "foto_fachada"], titulo: "Loja nova", legenda: "Montagem" } },
          {
            type: "tool_use",
            id: "t3",
            name: "criar_video",
            input: { cenas: [{ imagem: img1.id }, { titulo: "Loja nova do Banneg", texto: "Venha conhecer", imagem: img2.id }], segundos: 4, legenda: "Vídeo da loja" },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Ficou linda! Mandei a montagem e o vídeo." }] },
    );
    await ai.runSecretaryTurn(`${CAMILA}@s.whatsapp.net`, new Date("2026-11-26T14:00:30Z"));
    // The two photos come with the messages, each with its id
    const first = seen[0].messages[0].content as { type: string; text?: string }[];
    expect(first.filter((b) => b.type === "image")).toHaveLength(2);
    expect(first[0].text).toContain(`(midia_id ${img1.id})`);
    expect(first[1].text).toBe(`Imagem que Camila mandou (midia_id ${img1.id}):`);
    // The video: what is said in it and its scenes
    const video = (seen[1].messages.at(-1)!.content as { content: { type: string; text?: string }[] }[])[0].content;
    expect(video[0].text).toContain("Fala: Olha a fachada da loja nova");
    expect(video.some((b) => b.type === "image")).toBe(true);
    const [montage, clip] = seen[2].messages.at(-1)!.content as { content: string; is_error?: boolean }[];
    expect(montage.content).toBe("Montagem com 3 fotos enviada aqui.");
    expect(clip.content).toBe("Vídeo de 2 cenas (8 s, story) enviado aqui.");
    expect(slides[0]).toMatchObject({ width: 1080, height: 1920, seconds: 4 });
    expect(slides[0].images).toHaveLength(2);
    // The second scene is an art in the story size, the first the photo as it came
    expect(Buffer.from(slides[0].images[0], "base64").equals(readFileSync("public/materiais/fachada-loja.jpg"))).toBe(true);
    expect(Buffer.from(slides[0].images[1], "base64").readUInt32BE(20)).toBe(1920);
    expect(media.map((m) => [m.type, m.mimetype, m.text])).toEqual([
      ["image", "image/png", "Montagem"],
      ["video", "video/mp4", "Vídeo da loja"],
    ]);
  });

  it("someone else's picture stays in their chat", async () => {
    const other = await db.secretaryMessage.create({ data: { chatId: "5517900000000@s.whatsapp.net", isGroup: false, externalId: "PDF1", body: "[Documento] boleto", kind: "document", mediaStatus: "salvo", senderName: "Laiane" } });
    const ctx = { s: await sec.getSecretary(), chatId: `${CAMILA}@s.whatsapp.net`, isGroup: false, member: { name: "Camila", phone: "17992223333", email: "", role: "colaborador" as const }, contact: { phone: CAMILA, name: "Camila" }, actor: "Camila", now: new Date() };
    await expect(ai.runTool("ver_midia", { midia_id: other.id }, ctx)).rejects.toThrow("outra conversa");
    const wellington = { ...ctx, chatId: "5517981600088@s.whatsapp.net", member: { name: "Wellington", phone: "17981600088", email: "", role: "socio" as const }, actor: "Wellington" };
    const out = (await ai.runTool("ver_midia", { midia_id: other.id }, wellington)) as { type: string }[];
    expect(out.map((b) => b.type)).toEqual(["text", "document"]);
  });
});
