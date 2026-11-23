// "vamos fazer pela nova aba nossa do suporte, vou conectar meu numero ali também (apenas para enviar as msg), não é para
// aparecer as conversas minhas nem monitorar" (Wellington, 2026-11-23): the meetings group is posted by his number connected
// by QR on Banneg's own WhatsApp server, as a send-only instance; Uazapi stays only while it is not connected.
// The server (fetch) is stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.CRON_SECRET = "segredo-de-teste";
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.UAZAPI_URL = "https://banneg.uazapi.com/";
process.env.UAZAPI_TOKEN = "tok-uazapi";
process.env.SUPPORT_WA_URL = "https://wa.banneg.app/";
process.env.SUPPORT_WA_ADMIN_TOKEN = "admin";

vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => "id1") }));

const GROUP = { id: "120363001234567890@g.us", name: "Leads expansao" };

describe.skipIf(!dbUrl)("the group's sender on Banneg's own WhatsApp server", () => {
  let db: typeof import("@/lib/db").db;
  let team: typeof import("@/lib/team-alert");
  let settings: typeof import("@/lib/settings");
  let health: typeof import("@/lib/uazapi-health");
  const calls: { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  let connected = false;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    team = await import("@/lib/team-alert");
    settings = await import("@/lib/settings");
    health = await import("@/lib/uazapi-health");
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body });
      const path = new URL(url).pathname;
      if (url.startsWith("https://graph.facebook.com")) return Response.json({ messages: [{ id: "wamid.1" }] });
      if (path === "/instance/init") return Response.json({ instance: { token: "tok-proprio", status: "disconnected" } });
      if (path === "/instance/connect") return Response.json({ instance: { status: "connecting", qrcode: "data:image/png;base64,QR" } });
      if (path === "/instance/status")
        return Response.json(
          connected
            ? { instance: { status: "connected", owner: "5517981600088" }, status: { connected: true, jid: "5517981600088:4@s.whatsapp.net" } }
            : { instance: { status: "connecting" }, status: { connected: false } },
        );
      if (path === "/group/list") return Response.json([{ JID: GROUP.id, Name: GROUP.name }, { JID: "5511@s.whatsapp.net", Name: "não é grupo" }]);
      return Response.json({ ok: true });
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    connected = false;
    await db.$executeRawUnsafe('TRUNCATE "User","WhatsAppTemplate","Setting" CASCADE');
    await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
  });

  it("creates the number once, only to send, keeps its token sealed and shows the QR code", async () => {
    const step = await team.connectTeamSender();
    expect(step).toEqual({ connected: false, phone: null, qr: "data:image/png;base64,QR" });
    const init = calls.find((c) => c.url.endsWith("/instance/init"));
    expect(init).toMatchObject({ url: "https://wa.banneg.app/instance/init", headers: { admintoken: "admin" }, body: { name: "grupo-reunioes", sendOnly: true } });
    // Never a webhook: nothing of his conversations comes to the CRM
    expect(calls.some((c) => c.url.endsWith("/webhook"))).toBe(false);
    const saved = (await settings.getSettings()).meetingSender;
    expect(saved?.token).toBeTruthy();
    expect(saved?.token).not.toContain("tok-proprio");
    expect(calls.find((c) => c.url.endsWith("/instance/connect"))?.headers.token).toBe("tok-proprio");

    // Clicking again (or "Ler o QR code" after a drop) reuses the same number
    calls.length = 0;
    await team.connectTeamSender(true);
    expect(calls.some((c) => c.url.endsWith("/instance/init"))).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/instance/connect"))?.body).toEqual({ fresh: true });
  });

  it("once read, it keeps the phone, and the group and the notices go through it instead of Uazapi", async () => {
    await team.connectTeamSender();
    connected = true;
    expect(await team.teamSenderQr()).toMatchObject({ connected: true, phone: "5517981600088" });
    const s = await settings.getSettings();
    expect(s.meetingSender?.phone).toBe("5517981600088");
    expect(team.teamSender(s)).toMatchObject({ kind: "suporte", base: "https://wa.banneg.app", token: "tok-proprio" });

    calls.length = 0;
    expect(await team.listTeamGroups()).toEqual([GROUP]);
    await team.setTeamGroup(GROUP.id);
    await team.sendToGroup(GROUP.id, "teste");
    expect(calls.map((c) => c.url)).toEqual(["https://wa.banneg.app/group/list", "https://wa.banneg.app/group/list", "https://wa.banneg.app/send/text"]);
    expect(calls.every((c) => c.headers.token === "tok-proprio")).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ number: GROUP.id, text: "teste", linkPreview: false });
    expect(team.teamGroupOn(await settings.getSettings())).toBe(true);
  });

  it("while he is still reading the QR code there is no warning; a switch of sender starts a new record", async () => {
    // On Uazapi and down for a while: warned
    await health.checkUazapi(new Date("2026-11-23T13:00:00Z"));
    expect((await health.getUazapiHealth())?.sender).toBe("uazapi");

    await team.connectTeamSender();
    calls.length = 0;
    await health.checkUazapi(new Date("2026-11-23T13:01:00Z"));
    const h = await health.checkUazapi(new Date("2026-11-23T13:02:00Z"));
    expect(h).toMatchObject({ ok: false, sender: "suporte", waiting: true, bad: 2 });
    expect(h?.alertedAt).toBeUndefined();
    expect(await health.uazapiDown()).toBeNull();
    expect(calls.filter((c) => c.url.startsWith("https://graph.facebook.com"))).toEqual([]);

    // Connected, then dropped: now it warns, with the CRM's own reconnect steps
    connected = true;
    await team.teamSenderQr();
    await health.checkUazapi(new Date("2026-11-23T13:03:00Z"));
    connected = false;
    await health.checkUazapi(new Date("2026-11-23T13:04:00Z"));
    const down = await health.checkUazapi(new Date("2026-11-23T13:05:00Z"));
    expect(down).toMatchObject({ ok: false, sender: "suporte", bad: 2, alertedAt: "2026-11-23T13:05:00.000Z" });
    expect(down?.waiting).toBeUndefined();
    expect(await health.uazapiDown()).toMatchObject({ sender: "suporte" });
  });

  it("disconnecting the number logs it out and goes back to Uazapi", async () => {
    await team.connectTeamSender();
    calls.length = 0;
    await team.removeTeamSender();
    expect(calls.map((c) => [c.url, c.headers.token])).toEqual([["https://wa.banneg.app/instance/logout", "tok-proprio"]]);
    const s = await settings.getSettings();
    expect(s.meetingSender).toBeNull();
    expect(team.teamSender(s)).toMatchObject({ kind: "uazapi", base: "https://banneg.uazapi.com" });
  });
});
