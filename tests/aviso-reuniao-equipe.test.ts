// Every booked meeting is posted in the team's WhatsApp group through Uazapi (Wellington, 2026-11-12/13): client, time,
// Meet link and the lead's page. Google and Uazapi (fetch) are stubbed. The database part runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";
import { teamAlertText } from "@/lib/team-alert";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.GOOGLE_CLIENT_ID = "client";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_REFRESH_TOKEN = "legacy";
process.env.UAZAPI_URL = "https://banneg.uazapi.com/";
process.env.UAZAPI_TOKEN = "tok";

const GROUP = { id: "120363001234567890@g.us", name: "Reuniões Banneg" };

describe("the group's meeting notice", () => {
  it("says who, when, the Meet link, the lead's page and the summary", () => {
    const text = teamAlertText(
      { id: "lead1", name: "Ana Souza", phone: "5541999990000", email: "ana@x.com", aiSummary: "Quer abrir loja em Curitiba." },
      { startsAt: new Date("2026-11-13T13:00:00Z"), meetLink: "https://meet.google.com/abc-defg-hij" },
      { pipeline: "Vendas de Franquias", actor: "Duda" },
    );
    expect(text).toBe(
      [
        "*Nova reunião marcada*",
        "",
        "*Cliente:* Ana Souza (Vendas de Franquias)",
        "*WhatsApp:* (41) 99999-0000 · https://wa.me/5541999990000",
        "*E-mail:* ana@x.com",
        "*Quando:* sexta-feira, 13/11, às 10:00 (horário de Brasília)",
        "*Link da reunião:* https://meet.google.com/abc-defg-hij",
        "*Ficha no CRM:* https://crm-banneg-banneg.vercel.app/leads/lead1",
        "",
        "*Resumo:* Quer abrir loja em Curitiba.",
        "",
        "Marcada por Duda.",
      ].join("\n"),
    );
  });

  it("a rescheduled meeting says so, with the old time; without Meet or WhatsApp it still reads well", () => {
    const text = teamAlertText(
      { id: "lead1", name: null, phone: null },
      { startsAt: new Date("2026-11-14T17:00:00Z"), meetLink: null },
      { actor: "Wellington", previous: new Date("2026-11-13T13:00:00Z") },
    );
    expect(text).toContain("*Reunião remarcada*");
    expect(text).toContain("*Cliente:* sem nome\n*Quando:* sábado, 14/11, às 14:00 (horário de Brasília)\n*Antes era:* sexta-feira, 13/11, às 10:00");
    expect(text).toContain("*Link da reunião:* sem link (veja o Google Agenda)");
    expect(text).not.toContain("WhatsApp:");
    expect(text).toMatch(/Remarcada por Wellington\.$/);
  });
});

describe.skipIf(!dbUrl)("meeting notice in the team's WhatsApp group", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let settings: typeof import("@/lib/settings");
  let team: typeof import("@/lib/team-alert");
  const uazapi: { url: string; token: string | null; body: Record<string, unknown> | null }[] = [];
  let uazapiDown = false;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    settings = await import("@/lib/settings");
    team = await import("@/lib/team-alert");
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "a1" });
      if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
        if ((init.method ?? "GET") === "GET") return Response.json({ items: [] });
        return Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
      }
      if (url.startsWith("https://banneg.uazapi.com")) {
        uazapi.push({ url, token: init.headers?.token ?? null, body: init.body ? JSON.parse(init.body) : null });
        if (uazapiDown) return Response.json({ error: "instance disconnected" }, { status: 503 });
        if (url.endsWith("/group/list"))
          return Response.json([
            { JID: GROUP.id, Name: GROUP.name },
            { JID: "120363009999999999@g.us", Name: "Família" },
            { JID: "5517999990000@s.whatsapp.net", Name: "not a group" },
          ]);
        return Response.json({ messageid: "m1", status: "sent" });
      }
      return Response.json({ messages: [{ id: "wamid.1" }] });
    });
  });

  beforeEach(async () => {
    uazapi.length = 0;
    uazapiDown = false;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
  });

  const book = async (actor = "Duda") => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    const { lead } = await leads.createLead({ name: "Michel Souza", phone: "41999990003", source: "Meta Ads" }, "Formulário");
    const startsAt = new Date("2026-11-13T13:00:00Z");
    const meeting = await jobs.bookMeeting(lead, owner.id, { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }, actor);
    return { lead, meeting };
  };
  const posts = () => uazapi.filter((c) => c.url.endsWith("/send/text"));

  it("lists only groups, and saves the one chosen", async () => {
    expect(await team.listTeamGroups()).toEqual([{ id: "120363009999999999@g.us", name: "Família" }, GROUP]);
    expect(uazapi[0]).toMatchObject({ url: "https://banneg.uazapi.com/group/list", token: "tok" });
    await team.setTeamGroup(GROUP.id);
    expect((await settings.getSettings()).meetingAlertGroup).toEqual(GROUP);
    await expect(team.setTeamGroup("120363000000000000@g.us")).rejects.toThrow("não aparece mais");
    await team.setTeamGroup(null);
    expect((await settings.getSettings()).meetingAlertGroup).toBeNull();
  });

  it("posts each booked meeting in the group, with the lead's page", async () => {
    await settings.saveSettings({ meetingAlertGroup: GROUP });
    const { lead, meeting } = await book();
    expect(await db.job.count({ where: { type: "meeting.team_alert", dedupeKey: `team_alert:${meeting.id}` } })).toBe(1);
    await jobs.runDueJobs();
    expect(posts()).toHaveLength(1);
    const [post] = posts();
    expect(post).toMatchObject({ token: "tok", body: { number: GROUP.id, linkPreview: false } });
    const text = String(post.body!.text);
    expect(text).toContain("*Cliente:* Michel Souza (Expansão)");
    expect(text).toContain("https://meet.google.com/abc-defg-hij");
    expect(text).toContain(`/leads/${lead.id}`);
    expect(text).toContain("Marcada por Duda.");
    const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "meeting.team_alert" } });
    expect(event.summary).toBe("Aviso da reunião postado no grupo Reuniões Banneg do WhatsApp.");
  });

  it("a rescheduled meeting is posted again with the new time and the old one", async () => {
    await settings.saveSettings({ meetingAlertGroup: GROUP });
    const { meeting } = await book();
    await jobs.runDueJobs();
    uazapi.length = 0;
    const startsAt = new Date("2026-11-14T17:00:00Z");
    await jobs.rescheduleMeeting(meeting.id, { slot: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }, actor: "Wellington", notify: false });
    await jobs.runDueJobs();
    expect(posts()).toHaveLength(1);
    const text = String(posts()[0].body!.text);
    expect(text).toContain("*Reunião remarcada*");
    expect(text).toContain("*Quando:* sábado, 14/11, às 14:00");
    expect(text).toContain("*Antes era:* sexta-feira, 13/11, às 10:00");
    expect(text).toContain("Remarcada por Wellington.");
  });

  it("nothing without a group or without Uazapi, nor for a meeting canceled before the notice went", async () => {
    await book();
    expect(await db.job.count({ where: { type: "meeting.team_alert" } })).toBe(0);

    await db.user.deleteMany();
    await db.lead.deleteMany();
    await settings.saveSettings({ meetingAlertGroup: GROUP });
    const token = process.env.UAZAPI_TOKEN;
    delete process.env.UAZAPI_TOKEN;
    await book();
    expect(await db.job.count({ where: { type: "meeting.team_alert" } })).toBe(0);
    process.env.UAZAPI_TOKEN = token;

    await db.user.deleteMany();
    await db.lead.deleteMany();
    const { meeting } = await book();
    await jobs.cancelMeeting(meeting.id, "Wellington");
    await jobs.runDueJobs();
    expect(posts()).toEqual([]);
    const job = await db.job.findFirstOrThrow({ where: { type: "meeting.team_alert" } });
    expect(job.result).toBe("Ignorado: a reunião não está mais marcada.");
  });

  it("Uazapi down: the history says so and the job tries again later", async () => {
    await settings.saveSettings({ meetingAlertGroup: GROUP });
    uazapiDown = true;
    const { lead, meeting } = await book();
    await jobs.runDueJobs();
    const job = await db.job.findFirstOrThrow({ where: { type: "meeting.team_alert", leadId: lead.id } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(job.lastError).toContain("Uazapi respondeu 503: instance disconnected");
    const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "meeting.team_alert" } });
    expect(event.summary).toMatch(/^Aviso da reunião não chegou ao grupo Reuniões Banneg/);
    expect(meeting.status).toBe("scheduled");
  });

  it("the test button posts in the chosen group, and says what is missing", async () => {
    expect(await team.testTeamGroup()).toEqual({ ok: false, message: "Escolha o grupo e salve antes de testar." });
    await settings.saveSettings({ meetingAlertGroup: GROUP });
    expect(await team.testTeamGroup()).toMatchObject({ ok: true });
    expect(posts()[0].body).toMatchObject({ number: GROUP.id });
    const url = process.env.UAZAPI_URL;
    delete process.env.UAZAPI_URL;
    expect(await team.testTeamGroup()).toEqual({ ok: false, message: "Falta configurar no Vercel: UAZAPI_URL." });
    process.env.UAZAPI_URL = url;
  });
});
