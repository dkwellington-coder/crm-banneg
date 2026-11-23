// Suporte (Wellington, 2026-11-19): support numbers on Uazapi and how fast and how much each attendant works.
// The counting runs always; receiving and answering run against a real Postgres when TEST_DATABASE_URL is set.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessMs, dayWork, duration, replies, stretches, summarize, type MetricMessage } from "@/lib/support-metrics";
import { parsePayload, readStatus } from "@/lib/support";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.CRON_SECRET ||= "segredo-de-teste";

let session: string | undefined;
vi.mock("next/headers", () => ({ cookies: async () => ({ set() {}, delete() {}, get: () => (session ? { value: session } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

// Brasília time, written as people read it
const br = (s: string) => new Date(`${s}-03:00`);
const hours = { workDays: [1, 2, 3, 4, 5], workStart: "08:00", workEnd: "18:00" };

describe("waiting time inside working hours", () => {
  it("counts only the agreed hours", () => {
    // Thursday 2026-11-19
    expect(businessMs(br("2026-11-19T10:00"), br("2026-11-19T10:07"), hours)).toBe(7 * 60_000);
    // Written at 23h, answered at 8h05 next day: 5 minutes
    expect(businessMs(br("2026-11-19T23:00"), br("2026-11-20T08:05"), hours)).toBe(5 * 60_000);
    // Friday 17h50 to Monday 8h10: 10 + 10 minutes, the weekend does not count
    expect(businessMs(br("2026-11-20T17:50"), br("2026-11-23T08:10"), hours)).toBe(20 * 60_000);
    expect(businessMs(br("2026-11-21T10:00"), br("2026-11-21T12:00"), hours)).toBe(0);
  });
});

const msg = (chatId: string, at: string, direction: "IN" | "OUT", who: string | null = "ana", via = "phone"): MetricMessage => ({
  chatId,
  at: br(at),
  direction,
  via,
  attendantId: direction === "OUT" ? who : null,
  author: null,
});

describe("replies", () => {
  it("measures from the first unanswered client message to a person's answer; bots do not answer", () => {
    const { done, waiting } = replies([
      msg("c1", "2026-11-19T09:00", "IN"),
      msg("c1", "2026-11-19T09:01", "IN"),
      msg("c1", "2026-11-19T09:02", "OUT", null, "api"), // automatic "já vamos atender"
      msg("c1", "2026-11-19T09:12", "OUT", "ana"),
      msg("c1", "2026-11-19T09:20", "IN"),
      msg("c1", "2026-11-19T09:23", "OUT", "bia"),
      msg("c2", "2026-11-19T11:00", "IN"),
    ]);
    expect(done.map((r) => [r.who, r.ms / 60_000, r.first])).toEqual([
      ["ana", 12, true],
      ["bia", 3, false],
    ]);
    expect(waiting).toEqual([{ chatId: "c2", since: br("2026-11-19T11:00") }]);
  });

  it("a client writing after 6 hours of silence opens a new subject (first response again)", () => {
    const { done } = replies([
      msg("c1", "2026-11-19T08:00", "IN"),
      msg("c1", "2026-11-19T08:02", "OUT"),
      msg("c1", "2026-11-19T15:00", "IN"),
      msg("c1", "2026-11-19T15:30", "OUT"),
    ]);
    expect(done.map((r) => r.first)).toEqual([true, true]);
  });
});

describe("hours worked", () => {
  it("joins messages up to 15 minutes apart, with 5 minutes to read and type the first", () => {
    const s = stretches([br("2026-11-19T09:00"), br("2026-11-19T09:10"), br("2026-11-19T09:20"), br("2026-11-19T11:00")]);
    expect(s.map((x) => [(x.end - x.start) / 60_000, x.messages])).toEqual([
      [25, 3],
      [5, 1],
    ]);
  });

  it("compares the day with the agreed hours: late start, early stop and the longest gap", () => {
    const times = ["09:00", "09:10", "12:00", "15:00"].map((t) => br(`2026-11-19T${t}`));
    const w = dayWork(br("2026-11-19T12:00"), times, hours, +br("2026-11-19T20:00"));
    expect(w.day).toBe("2026-11-19");
    expect(w.lateMs / 60_000).toBe(60);
    expect(w.earlyMs / 60_000).toBe(180);
    expect(w.longestGapMs / 60_000).toBe(180); // 15h to 18h
    expect(w.activeMs / 60_000).toBe(15 + 5 + 5);
    // Before the end of the shift, stopping early is not counted yet
    expect(dayWork(br("2026-11-19T12:00"), times, hours, +br("2026-11-19T16:00")).earlyMs).toBe(0);
    // Saturday: no shift
    expect(dayWork(br("2026-11-21T12:00"), [br("2026-11-21T10:00")], hours).shift).toBeNull();
  });

  it("puts each person's numbers together", () => {
    const [ana] = summarize(
      [
        msg("c1", "2026-11-18T17:00", "IN"),
        msg("c1", "2026-11-19T08:04", "OUT"), // answered next morning: 1 hour of shift + 4 min
        msg("c2", "2026-11-19T10:00", "IN"),
        msg("c2", "2026-11-19T10:03", "OUT"),
      ],
      () => hours,
      br("2026-11-19T00:00"),
    );
    expect(ana).toMatchObject({ who: "ana", replies: 2, sent: 2, chats: 2, daysWorked: 1, within5: 0.5 });
    expect(ana.avgMs! / 60_000).toBe((64 + 3) / 2);
    expect(duration(ana.avgMs)).toBe("34 min");
  });
});

describe("what Uazapi posts", () => {
  const base = {
    EventType: "messages",
    chat: { phone: "+55 17 99999-0000", wa_contactName: "Carla Franqueada" },
    message: {
      chatid: "5517999990000@s.whatsapp.net",
      messageid: "3EB0ABC",
      fromMe: false,
      isGroup: false,
      messageTimestamp: +br("2026-11-19T10:00"),
      text: "Bom dia, o sistema caiu",
      type: "text",
    },
  };

  it("reads a client's message", () => {
    expect(parsePayload(base)).toMatchObject({
      kind: "message",
      waChatId: "5517999990000@s.whatsapp.net",
      phone: "5517999990000",
      name: "Carla Franqueada",
      fromMe: false,
      externalId: "3EB0ABC",
      at: br("2026-11-19T10:00"),
      body: "Bom dia, o sistema caiu",
    });
  });

  it("labels media, accepts seconds, and leaves groups and reactions out", () => {
    const audio = parsePayload({ ...base, message: { ...base.message, text: "", mediaType: "ptt", type: "media", messageTimestamp: 1_763_557_200 } });
    expect(audio).toMatchObject({ body: "[Áudio]", mediaKind: "ptt", at: new Date(1_763_557_200_000) });
    expect(parsePayload({ ...base, message: { ...base.message, isGroup: true } })).toMatchObject({ kind: "ignore", reason: "grupo" });
    expect(parsePayload({ ...base, message: { ...base.message, type: "reaction", reaction: "👍" } })).toMatchObject({ kind: "ignore" });
    expect(parsePayload({ EventType: "connection", instance: { status: "disconnected" } })).toEqual({ kind: "connection", status: "disconnected" });
  });

  it("reads the instance's status", () => {
    expect(readStatus({ instance: { status: "connected", owner: "5517988887777" } })).toMatchObject({ connected: true, phone: "5517988887777" });
    expect(readStatus({ status: { connected: false } })).toMatchObject({ connected: false });
    // Our gateway says why it is not connected; it is kept with the status
    expect(readStatus({ instance: { status: "connecting", reason: "a sessão salva estragou: leia o QR code de novo" } })).toMatchObject({
      connected: false,
      saved: "connecting: a sessão salva estragou: leia o QR code de novo",
    });
  });
});

describe.skipIf(!dbUrl)("receiving and answering", () => {
  let db: typeof import("@/lib/db").db;
  let support: typeof import("@/lib/support");
  let actions: typeof import("@/app/(app)/suporte/actions");

  beforeEach(async () => {
    db = (await import("@/lib/db")).db;
    support = await import("@/lib/support");
    actions = await import("@/app/(app)/suporte/actions");
    session = undefined;
    await db.$executeRawUnsafe('TRUNCATE "SupportMessage","SupportChat","SupportNumber","SupportAttendant","Session","User" CASCADE');
  });

  it("keeps the client's message, the attendant's answer typed on the phone, and the queue", async () => {
    const ana = await db.supportAttendant.create({ data: { name: "Ana" } });
    const number = await db.supportNumber.create({
      data: { name: "Suporte", token: support.sealToken("tok-1"), webhookKey: "k1", attendants: { connect: { id: ana.id } } },
    });
    const post = (m: Record<string, unknown>) =>
      support.receiveSupport("k1", { EventType: "messages", token: "tok-1", chat: { wa_contactName: "Carla" }, message: { chatid: "5517999990000@s.whatsapp.net", ...m } });

    expect(await post({ messageid: "a1", fromMe: false, text: "Oi", messageTimestamp: +br("2026-11-19T10:00") })).toMatchObject({ ok: true });
    let chat = await db.supportChat.findFirstOrThrow({ where: { numberId: number.id } });
    expect(chat).toMatchObject({ name: "Carla", phone: "5517999990000", waitingSince: br("2026-11-19T10:00") });

    // Posted twice: kept once
    expect(await post({ messageid: "a1", fromMe: false, text: "Oi", messageTimestamp: +br("2026-11-19T10:00") })).toMatchObject({ duplicate: true });
    // An automatic reply does not end the wait
    await post({ messageid: "a2", fromMe: true, wasSentByApi: true, text: "Já vamos atender", messageTimestamp: +br("2026-11-19T10:01") });
    chat = await db.supportChat.findFirstOrThrow({ where: { id: chat.id } });
    expect(chat.waitingSince).toEqual(br("2026-11-19T10:00"));
    // Ana answers on the phone: hers, and the wait ends
    await post({ messageid: "a3", fromMe: true, text: "Bom dia, Carla!", messageTimestamp: +br("2026-11-19T10:06") });
    chat = await db.supportChat.findFirstOrThrow({ where: { id: chat.id } });
    expect(chat).toMatchObject({ waitingSince: null, lastBody: "Bom dia, Carla!", lastFromMe: true });
    const answer = await db.supportMessage.findFirstOrThrow({ where: { externalId: "a3" } });
    expect(answer).toMatchObject({ direction: "OUT", via: "phone", attendantId: ana.id, author: "Ana" });

    // Wrong token or unknown address: refused
    expect(await support.receiveSupport("k1", { EventType: "messages", token: "outro", message: { chatid: "x@s.whatsapp.net", text: "x" } })).toMatchObject({ ok: false, status: 401 });
    expect(await support.receiveSupport("nada", { EventType: "messages" })).toMatchObject({ ok: false, status: 404 });
  });

  it("an answer from the CRM goes out by the chat's number with the name of who sent it", async () => {
    const user = await db.user.create({ data: { name: "Bia", email: "bia@exemplo.com", role: "SELLER", passwordHash: "x", areas: ["suporte"] } });
    const bia = await db.supportAttendant.create({ data: { name: "Bia", userId: user.id } });
    const number = await db.supportNumber.create({ data: { name: "Suporte", token: support.sealToken("tok-2"), webhookKey: "k2", server: "https://teste.uazapi.com" } });
    const chat = await db.supportChat.create({ data: { numberId: number.id, waChatId: "5517911112222@s.whatsapp.net", phone: "5517911112222", waitingSince: new Date() } });
    session = "s-bia";
    await db.session.create({ data: { id: session, userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) } });

    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ messageid: "out-1" }), { status: 200 });
    });
    const form = new FormData();
    form.set("body", "Resolvido, pode testar?");
    expect(await actions.sendSupportAction(chat.id, form)).toEqual({ ok: true });
    vi.unstubAllGlobals();

    expect(calls).toEqual([
      { url: "https://teste.uazapi.com/send/text", headers: expect.objectContaining({ token: "tok-2" }), body: { number: "5517911112222", text: "Resolvido, pode testar?" } },
    ]);
    expect(await db.supportMessage.findFirstOrThrow({ where: { chatId: chat.id } })).toMatchObject({ via: "crm", author: "Bia", attendantId: bia.id, externalId: "out-1" });
    expect((await db.supportChat.findUniqueOrThrow({ where: { id: chat.id } })).waitingSince).toBeNull();
    // Uazapi posts the same message back: not counted twice
    expect(await support.receiveSupport("k2", { EventType: "messages", message: { chatid: chat.waChatId, messageid: "out-1", fromMe: true, wasSentByApi: true, text: "Resolvido, pode testar?" } })).toMatchObject({ duplicate: true });
  });
});

describe.skipIf(!dbUrl)("history and files", () => {
  let db: typeof import("@/lib/db").db;
  let support: typeof import("@/lib/support");
  let drive: typeof import("@/lib/support-drive");

  beforeEach(async () => {
    db = (await import("@/lib/db")).db;
    support = await import("@/lib/support");
    drive = await import("@/lib/support-drive");
    await db.$executeRawUnsafe('TRUNCATE "SupportMessage","SupportChat","SupportNumber","SupportAttendant","Setting" CASCADE');
  });

  it("history arriving out of order: an old question answered later does not wait; the last unanswered one does", async () => {
    const ana = await db.supportAttendant.create({ data: { name: "Ana" } });
    await db.supportNumber.create({ data: { name: "Seguros", token: support.sealToken("tok-h"), webhookKey: "kh", attendants: { connect: { id: ana.id } } } });
    const item = (id: string, fromMe: boolean, text: string, at: string) => ({
      EventType: "messages",
      token: "tok-h",
      chat: { wa_contactName: "Joana" },
      message: { chatid: "5517933334444@s.whatsapp.net", messageid: id, fromMe, text, messageTimestamp: +br(at), history: true },
    });
    // Newest first, as the history comes
    for (const p of [item("h3", false, "E o boleto?", "2026-11-12T15:00"), item("h2", true, "Já resolvi", "2026-11-10T10:20"), item("h1", false, "Problema no app", "2026-11-10T10:00")])
      await support.receiveSupport("kh", p);
    const chat = await db.supportChat.findFirstOrThrow({});
    expect(chat).toMatchObject({ name: "Joana", lastBody: "E o boleto?", lastFromMe: false, waitingSince: br("2026-11-12T15:00") });
    expect(await db.supportMessage.findFirstOrThrow({ where: { externalId: "h2" } })).toMatchObject({ attendantId: ana.id, createdAt: br("2026-11-10T10:20") });
  });

  it("a file: downloading, saved on the server, copied to the Drive in pieces, and shown by name", async () => {
    await db.supportNumber.create({ data: { name: "Seguros", token: support.sealToken("tok-f"), webhookKey: "kf", server: "https://wa.teste" } });
    await support.receiveSupport("kf", {
      EventType: "messages",
      token: "tok-f",
      chat: { wa_contactName: "Joana" },
      message: { chatid: "5517933334444@s.whatsapp.net", messageid: "f1", fromMe: false, text: "segue", mediaType: "document", type: "media", messageTimestamp: +br("2026-11-19T14:05"), media: { mimetype: "application/pdf", fileName: "boleto.pdf", size: 10 } },
    });
    let m = await db.supportMessage.findFirstOrThrow({ where: { externalId: "f1" } });
    expect(m).toMatchObject({ body: "[Documento] segue", mediaMime: "application/pdf", mediaName: "boleto.pdf", mediaStatus: "baixando" });
    // The server says it saved the file
    await support.receiveSupport("kf", { EventType: "media", token: "tok-f", message: { chatid: "5517933334444@s.whatsapp.net", messageid: "f1" }, media: { saved: true, size: 12 } });
    m = await db.supportMessage.findFirstOrThrow({ where: { externalId: "f1" } });
    expect(m).toMatchObject({ mediaStatus: "salvo", mediaSize: 12 });
    expect(drive.driveFileName(m, "Joana")).toBe("2026-11-19 14h05 - Joana - boleto.pdf");

    // Without the Drive connected nothing is copied
    expect(await drive.copySupportMedia()).toEqual({ skipped: "Google Drive não conectado" });
    const { sealToken } = await import("@/lib/google");
    process.env.GOOGLE_CLIENT_SECRET ||= "s";
    process.env.GOOGLE_CLIENT_ID ||= "c";
    await db.setting.create({ data: { key: "suporte_drive", value: { email: "w@banneg.com.br", connectedAt: "x", token: sealToken("refresh"), folders: {} } } });

    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    let folders = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      calls.push({ url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : undefined });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "acc" });
      if (url.startsWith("https://wa.teste/media")) return new Response("PDF-CONTENT!", { status: 206, headers: { "content-range": "bytes 0-11/12", "content-type": "application/pdf" } });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files")) return Response.json({ id: `pasta${++folders}` });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) return new Response(null, { status: 200, headers: { location: "https://upload.teste/sessao" } });
      if (url === "https://upload.teste/sessao") return Response.json({ id: "arquivo-no-drive" });
      return new Response("?", { status: 500 });
    });
    expect(await drive.copySupportMedia()).toMatchObject({ copied: 1 });
    vi.unstubAllGlobals();

    expect((await db.supportMessage.findFirstOrThrow({ where: { externalId: "f1" } })).driveFileId).toBe("arquivo-no-drive");
    // Banneg Suporte / Seguros / 2026-11
    const made = calls.filter((c) => c.url.startsWith("https://www.googleapis.com/drive/v3/files")).map((c) => JSON.parse(c.body!));
    expect(made).toEqual([
      { name: "Banneg Suporte", mimeType: "application/vnd.google-apps.folder" },
      { name: "Seguros", mimeType: "application/vnd.google-apps.folder", parents: ["pasta1"] },
      { name: "2026-11", mimeType: "application/vnd.google-apps.folder", parents: ["pasta2"] },
    ]);
    const start = calls.find((c) => c.url.startsWith("https://www.googleapis.com/upload"))!;
    expect(start.headers).toMatchObject({ "x-upload-content-type": "application/pdf", "x-upload-content-length": "12" });
    expect(JSON.parse(start.body!)).toMatchObject({ name: "2026-11-19 14h05 - Joana - boleto.pdf", parents: ["pasta3"] });
    expect(calls.find((c) => c.url === "https://upload.teste/sessao")!.headers).toMatchObject({ "content-range": "bytes 0-11/12" });
    // Next round: nothing left, the folders are remembered
    expect(await drive.copySupportMedia()).toEqual({ copied: 0 });
  });

  it("the check every 5 minutes: a connected number gets its webhook set again; one that stopped answering shows the error", async () => {
    const on = await db.supportNumber.create({ data: { name: "Seguros", token: support.sealToken("tok-on"), webhookKey: "kon", server: "https://a.teste" } });
    const off = await db.supportNumber.create({ data: { name: "Solar", token: support.sealToken("tok-off"), webhookKey: "koff", server: "https://b.teste" } });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push(`${init.method} ${url}`);
      if (url.startsWith("https://b.teste")) throw new Error("ECONNREFUSED");
      if (url.endsWith("/instance/status")) return new Response(JSON.stringify({ instance: { status: "connected", owner: "5517900001111" } }));
      return new Response("{}");
    });
    const results = await support.checkSupportNumbers();
    vi.unstubAllGlobals();

    expect(calls).toEqual(["GET https://a.teste/instance/status", "POST https://a.teste/webhook", "GET https://b.teste/instance/status"]);
    expect(results).toEqual([{ name: "Seguros", status: "connected" }, { name: "Solar", error: expect.stringContaining("ECONNREFUSED") }]);
    expect(await db.supportNumber.findUniqueOrThrow({ where: { id: on.id } })).toMatchObject({ status: "connected", phone: "5517900001111" });
    expect((await db.supportNumber.findUniqueOrThrow({ where: { id: off.id } })).status).toMatch(/^erro: Sem resposta/);
    expect(await db.setting.findUnique({ where: { key: "suporte_check" } })).toBeTruthy();
  });

  it("a file WhatsApp no longer had is marked, and the chat moves on", async () => {
    await db.supportNumber.create({ data: { name: "Seguros", token: support.sealToken("tok-e"), webhookKey: "ke" } });
    await support.receiveSupport("ke", { EventType: "messages", message: { chatid: "5517@s.whatsapp.net", messageid: "e1", mediaType: "image", type: "media", media: { mimetype: "image/jpeg" } } });
    await support.receiveSupport("ke", { EventType: "media", message: { chatid: "5517@s.whatsapp.net", messageid: "e1" }, media: { saved: false, error: "404" } });
    expect(await db.supportMessage.findFirstOrThrow({})).toMatchObject({ body: "[Imagem]", mediaStatus: "erro", mediaError: "404" });
  });
});
