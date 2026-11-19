// "Sempre que desconectar me avise na hora" (Wellington, 2026-11-19): the Uazapi number behind the meetings group is checked
// every minute; after 2 bad answers in a row the owner gets an e-mail and a WhatsApp from the official number, the CRM shows a
// banner, and a "voltou" follows when it reconnects. Uazapi and Meta (fetch) and the e-mail are stubbed.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readStatus } from "@/lib/uazapi-health";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.UAZAPI_URL = "https://banneg.uazapi.com/";
process.env.UAZAPI_TOKEN = "tok";

const mails = vi.hoisted(() => [] as { to: string; subject: string; body: string }[]);
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (to: string, subject: string, body: string) => {
    mails.push({ to, subject, body });
    return "id1";
  }),
}));

describe("Uazapi's status answer", () => {
  it("connected, with the number", () => {
    expect(readStatus({ instance: { status: "connected", owner: "5517981600088" }, status: { connected: true, loggedIn: true, jid: "5517981600088:12@s.whatsapp.net" } })).toEqual({
      connected: true,
      status: "connected",
      phone: "5517981600088",
    });
    expect(readStatus({ instance: { status: "open" }, status: { connected: true, jid: "5517981600088:3@s.whatsapp.net" } }).phone).toBe("5517981600088");
  });
  it("disconnected, connecting, or logged out while the socket is up", () => {
    expect(readStatus({ instance: { status: "disconnected", lastDisconnectReason: "logged out" } })).toMatchObject({ connected: false, reason: "logged out" });
    expect(readStatus({ instance: { status: "connecting" } }).connected).toBe(false);
    expect(readStatus({ instance: { status: "connected" }, status: { connected: true, loggedIn: false } }).connected).toBe(false);
  });
});

describe.skipIf(!dbUrl)("Uazapi disconnection warning", () => {
  let db: typeof import("@/lib/db").db;
  let health: typeof import("@/lib/uazapi-health");
  let state: "connected" | "disconnected" | "down" = "connected";
  let windowOpen = true;
  const whatsapp: Record<string, unknown>[] = [];
  const min = (n: number) => new Date(Date.UTC(2026, 10, 19, 15, n));

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    health = await import("@/lib/uazapi-health");
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
      if (url.startsWith("https://banneg.uazapi.com")) {
        if (state === "down") return Response.json({ error: "bad gateway" }, { status: 502 });
        return Response.json({ instance: { status: state, owner: "5517981600088" }, status: { connected: state === "connected" } });
      }
      const body = JSON.parse(init.body ?? "{}");
      whatsapp.push(body);
      if (body.type === "text" && !windowOpen) return Response.json({ error: { code: 131047, message: "Re-engagement message" } }, { status: 400 });
      return Response.json({ messages: [{ id: "wamid.1" }] });
    });
  });

  beforeEach(async () => {
    state = "connected";
    windowOpen = true;
    whatsapp.length = 0;
    mails.length = 0;
    await db.$executeRawUnsafe('TRUNCATE "User","WhatsAppTemplate","Setting" CASCADE');
    await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
  });

  it("stays quiet while connected, and keeps the number", async () => {
    const h = await health.checkUazapi(min(0));
    expect(h).toMatchObject({ ok: true, status: "connected", phone: "5517981600088" });
    expect(await health.uazapiDown()).toBeNull();
    expect(mails).toEqual([]);
    expect(whatsapp).toEqual([]);
    // The template for out-of-window warnings is in the CRM, waiting to go to Meta's review
    expect(await db.whatsAppTemplate.findUnique({ where: { name: health.UAZAPI_TEMPLATE.name } })).toMatchObject({ status: "draft", category: "UTILITY" });
  });

  it("one bad answer is not enough; the second warns by e-mail and WhatsApp, once, with the banner on", async () => {
    await health.checkUazapi(min(0));
    state = "disconnected";
    expect(await health.checkUazapi(min(1))).toMatchObject({ ok: false, bad: 1 });
    expect(await health.uazapiDown()).toBeNull();
    expect(mails).toEqual([]);

    const h = await health.checkUazapi(min(2));
    expect(h).toMatchObject({ ok: false, bad: 2, since: min(1).toISOString(), alertedAt: min(2).toISOString() });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "wellington@banneg.com.br", subject: "WhatsApp da Uazapi desconectado" });
    expect(mails[0].body).toContain("o WhatsApp (17) 98160-0088 desconectou da Uazapi às 12:01");
    expect(mails[0].body).toContain("leia o QR code");
    expect(whatsapp).toEqual([expect.objectContaining({ to: "5517981600088", type: "text" })]);
    expect(h?.alert).toEqual(["e-mail para wellington@banneg.com.br", "WhatsApp para (17) 98160-0088"]);
    expect(await health.uazapiDown()).toMatchObject({ phone: "5517981600088" });

    // Still down: no new warning
    await health.checkUazapi(min(3));
    await health.checkUazapi(min(4));
    expect(mails).toHaveLength(1);
    expect(whatsapp).toHaveLength(1);
  });

  it("when it comes back: banner off and a 'voltou' by e-mail and WhatsApp", async () => {
    await health.checkUazapi(min(0));
    state = "disconnected";
    await health.checkUazapi(min(1));
    await health.checkUazapi(min(2));
    state = "connected";
    const h = await health.checkUazapi(min(9));
    expect(h).toMatchObject({ ok: true, since: min(9).toISOString() });
    expect(await health.uazapiDown()).toBeNull();
    expect(mails.map((m) => m.subject)).toEqual(["WhatsApp da Uazapi desconectado", "WhatsApp da Uazapi conectado de novo"]);
    expect(mails[1].body).toContain("voltou a ficar conectado na Uazapi às 12:09");
    expect(whatsapp).toHaveLength(2);
    // A blip that never reached the warning comes back silently
    state = "disconnected";
    await health.checkUazapi(min(10));
    state = "connected";
    await health.checkUazapi(min(11));
    expect(mails).toHaveLength(2);
  });

  it("Uazapi not answering (or a token that no longer works) also warns", async () => {
    state = "down";
    await health.checkUazapi(min(0));
    const h = await health.checkUazapi(min(1));
    expect(h).toMatchObject({ ok: false, status: "sem resposta", alertedAt: min(1).toISOString() });
    expect(h?.message).toContain("Uazapi respondeu 502");
    expect(mails[0].body).toContain("A Uazapi não respondeu");
  });

  it("out of the 24 h window the WhatsApp goes as the approved template", async () => {
    await health.checkUazapi(min(0));
    await db.whatsAppTemplate.update({ where: { name: health.UAZAPI_TEMPLATE.name }, data: { status: "APPROVED", active: true } });
    windowOpen = false;
    state = "disconnected";
    await health.checkUazapi(min(1));
    const h = await health.checkUazapi(min(2));
    expect(whatsapp.at(-1)).toMatchObject({
      to: "5517981600088",
      type: "template",
      template: { name: "banneg_aviso_uazapi_desconectado", components: [{ type: "body", parameters: [{ text: "(17) 98160-0088" }, { text: "12:01" }] }] },
    });
    expect(h?.alert).toContain("WhatsApp (modelo) para (17) 98160-0088");
  });

  it("does nothing without Uazapi set up", async () => {
    const token = process.env.UAZAPI_TOKEN;
    delete process.env.UAZAPI_TOKEN;
    expect(await health.checkUazapi(min(0))).toBeNull();
    process.env.UAZAPI_TOKEN = token;
  });
});
