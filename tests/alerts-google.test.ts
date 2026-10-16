// Red alerts (new leads, leads waiting for a person), the Google agenda connection and meetings booked by the team.
// Google and Meta (fetch) are stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.GOOGLE_CLIENT_ID = "client";
process.env.GOOGLE_CLIENT_SECRET = "secret";

describe("sealed Google token", () => {
  it("opens only with the same client secret", async () => {
    const { openToken, sealToken } = await import("@/lib/google");
    const sealed = sealToken("1//refresh");
    expect(sealed).not.toContain("refresh");
    expect(openToken(sealed)).toBe("1//refresh");
    process.env.GOOGLE_CLIENT_SECRET = "other";
    expect(() => openToken(sealed)).toThrow();
    process.env.GOOGLE_CLIENT_SECRET = "secret";
  });
});

describe.skipIf(!dbUrl)("alerts, Google agenda and meetings booked by the team", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let alerts: typeof import("@/lib/alerts");
  let google: typeof import("@/lib/google");
  let jobs: typeof import("@/lib/jobs");
  const meta: Record<string, unknown>[] = [];
  const googleCalls: { url: string; body: Record<string, unknown> | string }[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    alerts = await import("@/lib/alerts");
    google = await import("@/lib/google");
    jobs = await import("@/lib/jobs");
    vi.stubGlobal("fetch", async (url: string, init: { body: string | URLSearchParams }) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const form = new URLSearchParams(String(init.body));
        googleCalls.push({ url, body: Object.fromEntries(form) });
        if (form.get("grant_type") === "authorization_code") {
          const idToken = `x.${Buffer.from(JSON.stringify({ email: "wellington@banneg.com.br" })).toString("base64url")}.y`;
          return Response.json({ access_token: "a1", refresh_token: "r1", id_token: idToken });
        }
        return Response.json({ access_token: `access-for-${form.get("refresh_token")}` });
      }
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
        googleCalls.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
      }
      const body = JSON.parse(String(init.body));
      meta.push(body);
      return Response.json({ messages: [{ id: `wamid.${meta.length}` }] });
    });
  });

  beforeEach(async () => {
    meta.length = 0;
    googleCalls.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.whatsAppTemplate.create({
      data: {
        name: "banneg_reuniao_confirmada_v1",
        body: "Olá, {{1}}. Sua reunião com o BANNEG está confirmada para {{2}}, às {{3}}, horário de Brasília. Acesso: {{4}}. Para remarcar, responda esta mensagem.",
        purpose: "importado",
        category: "UTILITY",
      },
    });
  });

  it("lights up for a new lead until someone opens it, and for a lead waiting for an answer", async () => {
    const { lead } = await leads.createLead({ name: "Ana", phone: "41999990000", source: "Meta Ads" }, "Formulário");
    const { lead: mine } = await leads.createLead({ name: "Bia", phone: "41999990001", source: "manual", seen: true }, "Wellington");
    let a = await alerts.teamAlerts();
    expect(a.newLeads).toBe(1);
    expect(a.items).toMatchObject([{ kind: "new", leadId: lead.id, name: "Ana", text: "Lead novo (Meta Ads)" }]);

    // Opened by the team: no longer new
    await alerts.markSeen(lead.id);
    expect((await alerts.teamAlerts()).items).toEqual([]);

    // Bia writes and no AI is on her conversation: waiting for a person; each new message is a new alert
    await db.lead.update({ where: { id: mine.id }, data: { aiPaused: true } });
    await db.message.create({ data: { leadId: mine.id, channel: "WHATSAPP", direction: "IN", body: "Quero saber o valor", author: "Bia" } });
    a = await alerts.teamAlerts();
    expect(a.waiting).toBe(1);
    expect(a.items[0]).toMatchObject({ kind: "waiting", leadId: mine.id, text: "Quero saber o valor" });
    const firstKey = a.items[0].key;
    await db.message.create({ data: { leadId: mine.id, channel: "WHATSAPP", direction: "IN", body: "Oi?", author: "Bia", createdAt: new Date(Date.now() + 1000) } });
    expect((await alerts.teamAlerts()).items[0].key).not.toBe(firstKey);

    // Someone answers: it stops waiting
    await db.message.create({ data: { leadId: mine.id, channel: "WHATSAPP", direction: "OUT", body: "Já te passo", author: "Wellington", createdAt: new Date(Date.now() + 2000) } });
    expect((await alerts.teamAlerts()).waiting).toBe(0);

    // A due task the AI left (handoff) also waits for a person
    await leads.ensureTask(lead.id, null, "Assumir conversa: quer falar com uma pessoa");
    expect((await alerts.teamAlerts()).items).toMatchObject([{ kind: "waiting", leadId: lead.id, text: "Assumir conversa: quer falar com uma pessoa" }]);
  });

  it("does not light up for imported leads waiting in a queue", async () => {
    const { importLeads } = await import("@/lib/import");
    const pipeline = await leads.defaultPipeline();
    await importLeads("nome;telefone\nCarla;41999990002\n", { pipelineId: pipeline.id, startAi: false, actor: "Wellington" });
    expect(await db.lead.count()).toBe(1);
    expect((await alerts.teamAlerts()).items).toEqual([]);
  });

  it("books on the connected Google with Meet, invites the manager, and sends the link to the lead", async () => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    const manager = await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
    expect(await google.googleAgendaFor(manager)).toBeNull();

    // Wellington connects his Google: the refresh token is stored sealed
    const link = await google.connectGoogle(owner.id, "code123", "https://crm/api/google/callback");
    expect(link.email).toBe("wellington@banneg.com.br");
    expect(googleCalls[0].body).toMatchObject({ code: "code123", grant_type: "authorization_code", redirect_uri: "https://crm/api/google/callback" });
    const stored = await db.setting.findUniqueOrThrow({ where: { key: `google:${owner.id}` } });
    expect(JSON.stringify(stored.value)).not.toContain("r1");

    // The manager did not connect: the meeting goes on Wellington's agenda with the manager invited
    expect(await google.googleAgendaFor(manager)).toMatchObject({ calendarId: "primary", account: "wellington@banneg.com.br", invite: "g@banneg.com.br" });

    const { lead } = await leads.createLead({ name: "Ana Souza", phone: "41999990000", email: "ana@x.com", source: "site" }, "teste");
    // Ana wrote a minute ago: the 24-hour window is open, so the confirmation goes as free text
    await db.lead.update({ where: { id: lead.id }, data: { lastInboundAt: new Date(Date.now() - 60_000) } });
    const startsAt = new Date("2026-10-19T13:00:00Z");
    const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const { meeting, sent } = await jobs.scheduleMeeting(fresh, {
      userId: manager.id,
      slot: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) },
      actor: "Wellington",
      notify: true,
    });
    expect(meeting.meetLink).toBe("https://meet.google.com/abc-defg-hij");
    const event = googleCalls.find((c) => c.url.includes("/calendars/primary/events"))!;
    expect(event.url).toContain("conferenceDataVersion=1");
    expect(event.url).toContain("sendUpdates=all");
    expect(event.body).toMatchObject({ attendees: [{ email: "ana@x.com" }, { email: "g@banneg.com.br" }] });
    expect(sent).toBe("Link da reunião enviado.");
    expect(meta.at(-1)).toMatchObject({ type: "text" });
    expect(JSON.stringify(meta.at(-1))).toContain("https://meet.google.com/abc-defg-hij");
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(after.stage.key).toBe("reuniao");
    expect(after.status).toBe("MEETING_BOOKED");
    expect(after.ownerId).toBe(manager.id);
  });

  it("outside the 24-hour window the link goes in the approved template with day, time and link", async () => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    await google.connectGoogle(owner.id, "code123", "https://crm/api/google/callback");
    const { lead } = await leads.createLead({ name: "Ana Souza", phone: "41999990000", source: "site" }, "teste");
    const startsAt = new Date("2026-10-19T13:00:00Z");
    const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    const { sent } = await jobs.scheduleMeeting(fresh, {
      userId: owner.id,
      slot: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) },
      actor: "Wellington",
      notify: true,
    });
    expect(sent).toBe("Link da reunião enviado pelo modelo da Meta (janela de 24 h fechada).");
    expect(meta.at(-1)).toMatchObject({
      type: "template",
      template: {
        name: "banneg_reuniao_confirmada_v1",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ana" },
              { type: "text", text: "segunda-feira, 19/10" },
              { type: "text", text: "10:00" },
              { type: "text", text: "https://meet.google.com/abc-defg-hij" },
            ],
          },
        ],
      },
    });
    const msg = await db.message.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUT" }, orderBy: { createdAt: "desc" } });
    expect(msg.body).toBe(
      "Olá, Ana. Sua reunião com o BANNEG está confirmada para segunda-feira, 19/10, às 10:00, horário de Brasília. Acesso: https://meet.google.com/abc-defg-hij. Para remarcar, responda esta mensagem.",
    );
  });

  it("without Google the meeting stays in the CRM and nothing unrelated goes to a closed window", async () => {
    const owner = await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    const { lead } = await leads.createLead({ name: "Ana", phone: "41999990000", source: "site" }, "teste");
    const startsAt = new Date("2026-10-19T13:00:00Z");
    const { meeting, sent } = await jobs.scheduleMeeting(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), {
      userId: owner.id,
      slot: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) },
      actor: "Wellington",
      notify: true,
    });
    expect(meeting.meetLink).toBeNull();
    expect(sent).toMatch(/janela de 24 h fechada/);
    expect(meta).toEqual([]);
  });
});
