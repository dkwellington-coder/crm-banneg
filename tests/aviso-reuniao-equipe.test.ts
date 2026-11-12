// Every booked meeting goes to the team's WhatsApp (Wellington, 2026-11-12): client, time, Meet link and the lead's page.
// Google and Meta (fetch) are stubbed. The database part runs only when TEST_DATABASE_URL is set.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";
import { isTeamPhone, TEAM_ALERT_TEMPLATE, teamAlertParams, teamAlertPhones, teamAlertText } from "@/lib/team-alert";
import { templateComponents } from "@/lib/whatsapp";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.GOOGLE_CLIENT_ID = "client";
process.env.GOOGLE_CLIENT_SECRET = "secret";
process.env.GOOGLE_REFRESH_TOKEN = "legacy";

describe("the team's meeting notice", () => {
  it("reads the phones in any format, and knows them with or without the 9", () => {
    const settings = { meetingAlertPhones: ["(17) 98160-0088", "5517981600088", "abc", "11 92013-8123"] };
    expect(teamAlertPhones(settings)).toEqual(["5517981600088", "5511920138123"]);
    expect(isTeamPhone(settings, "551781600088")).toBe(true);
    expect(isTeamPhone(settings, "5541999990000")).toBe(false);
    expect(isTeamPhone({ meetingAlertPhones: [] }, "5517981600088")).toBe(false);
  });

  it("fills the six variables on one line each, never empty", () => {
    const params = teamAlertParams(
      { id: "lead1", name: "Ana\nSouza", phone: "5541999990000" },
      { startsAt: new Date("2026-11-13T13:00:00Z"), meetLink: null },
      { pipeline: "Vendas de Franquias", actor: "Duda" },
    );
    expect(params).toEqual([
      "Ana Souza (Vendas de Franquias)",
      "(41) 99999-0000",
      "sexta-feira, 13/11, às 10:00",
      "sem link (veja o Google Agenda)",
      "https://crm-banneg-banneg.vercel.app/leads/lead1",
      "Duda",
    ]);
    const text = teamAlertText(params);
    expect(text).toContain("Cliente: Ana Souza (Vendas de Franquias)");
    expect(text).toContain("Ficha no CRM: https://crm-banneg-banneg.vercel.app/leads/lead1");
    expect(text).not.toMatch(/\{\{\d\}\}/);
  });

  it("goes to Meta's review with examples that fit it, and the migration carries the same text", () => {
    const body = templateComponents({ name: TEAM_ALERT_TEMPLATE.name, body: TEAM_ALERT_TEMPLATE.body, buttons: [] })[0] as { example: { body_text: string[][] } };
    expect(body.example.body_text[0]).toHaveLength(6);
    expect(body.example.body_text[0][3]).toMatch(/^https:\/\/meet\.google\.com\//);
    const sql = readFileSync(path.resolve(import.meta.dirname, "../prisma/migrations/20261112190000_aviso_reuniao_equipe/migration.sql"), "utf8");
    const saved = /E'([^']*)'/.exec(sql)![1].replaceAll("\\n", "\n");
    expect(saved).toBe(TEAM_ALERT_TEMPLATE.body);
    expect(sql).toContain(`'${TEAM_ALERT_TEMPLATE.name}'`);
    expect(sql).toContain(`'${TEAM_ALERT_TEMPLATE.purpose}'`);
  });
});

describe.skipIf(!dbUrl)("meeting notice to the team's WhatsApp", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let settings: typeof import("@/lib/settings");
  const meta: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    settings = await import("@/lib/settings");
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string | URLSearchParams }) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "a1" });
      if (url.startsWith("https://www.googleapis.com/calendar/v3/")) {
        if ((init.method ?? "GET") === "GET") return Response.json({ items: [] });
        return Response.json({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" });
      }
      const body = JSON.parse(String(init.body));
      meta.push(body);
      return Response.json({ messages: [{ id: `wamid.${meta.length}` }] });
    });
  });

  beforeEach(async () => {
    meta.length = 0;
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
  const toTeam = () => meta.filter((m) => m.to !== "5541999990003");

  it("sends each team phone the client, the time, the Meet link and the lead's page", async () => {
    await settings.saveSettings({ meetingAlertPhones: ["(17) 98160-0088", "(11) 92013-8123"] });
    const { lead, meeting } = await book();
    expect(await db.job.count({ where: { type: "meeting.team_alert", dedupeKey: `team_alert:${meeting.id}` } })).toBe(1);
    await jobs.runDueJobs();
    // No approved template yet: the plain text (it reaches whoever wrote to the number in the last 24 h)
    expect(toTeam().map((m) => m.to)).toEqual(["5517981600088", "5511920138123"]);
    const text = JSON.stringify(toTeam()[0]);
    expect(toTeam()[0]).toMatchObject({ type: "text" });
    expect(text).toContain("Michel Souza (Expansão)");
    expect(text).toContain("(41) 99999-0003");
    expect(text).toContain("https://meet.google.com/abc-defg-hij");
    expect(text).toContain(`/leads/${lead.id}`);
    expect(text).toContain("Marcada por Duda");
    const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "meeting.team_alert" } });
    expect(event.summary).toBe("Aviso da reunião no WhatsApp da equipe: (17) 98160-0088, (11) 92013-8123.");
  });

  it("uses the approved template once Meta approves it", async () => {
    await settings.saveSettings({ meetingAlertPhones: ["17981600088"] });
    await db.whatsAppTemplate.create({
      data: { name: TEAM_ALERT_TEMPLATE.name, body: TEAM_ALERT_TEMPLATE.body, purpose: TEAM_ALERT_TEMPLATE.purpose, category: "UTILITY", status: "APPROVED", active: true },
    });
    const { lead } = await book("Wellington");
    await jobs.runDueJobs();
    const [sent] = toTeam();
    expect(sent).toMatchObject({ to: "5517981600088", type: "template", template: { name: TEAM_ALERT_TEMPLATE.name, language: { code: "pt_BR" } } });
    const params = (sent.template as { components: { parameters: { text: string }[] }[] }).components[0].parameters.map((p) => p.text);
    expect(params).toHaveLength(6);
    expect(params[3]).toBe("https://meet.google.com/abc-defg-hij");
    expect(params[4]).toMatch(new RegExp(`/leads/${lead.id}$`));
    expect(params[5]).toBe("Wellington");
    expect(params.every((p) => p && !/\n/.test(p))).toBe(true);
  });

  it("a rescheduled meeting goes to the team again, with the new time and the old one", async () => {
    await settings.saveSettings({ meetingAlertPhones: ["17981600088"] });
    const { meeting } = await book();
    await jobs.runDueJobs();
    meta.length = 0;
    const startsAt = new Date("2026-11-14T17:00:00Z");
    await jobs.rescheduleMeeting(meeting.id, { slot: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }, actor: "Wellington", notify: false });
    await jobs.runDueJobs();
    const text = JSON.stringify(toTeam());
    expect(toTeam()).toHaveLength(1);
    expect(text).toContain("Quando: sábado, 14/11, às 14:00");
    expect(text).toContain("Marcada por Wellington, remarcada de sexta-feira, 13/11, às 10:00.");
  });

  it("sends nothing without phones, nor for a meeting canceled before the notice went", async () => {
    await book();
    expect(await db.job.count({ where: { type: "meeting.team_alert" } })).toBe(0);

    await db.user.deleteMany();
    await db.lead.deleteMany();
    await settings.saveSettings({ meetingAlertPhones: ["17981600088"] });
    const { meeting } = await book();
    await jobs.cancelMeeting(meeting.id, "Wellington");
    meta.length = 0;
    await jobs.runDueJobs();
    expect(toTeam()).toEqual([]);
    const job = await db.job.findFirstOrThrow({ where: { type: "meeting.team_alert" } });
    expect(job.result).toBe("Ignorado: a reunião não está mais marcada.");
  });

  it("a team phone answering the notice does not become a lead; a lead with that phone still talks", async () => {
    await settings.saveSettings({ meetingAlertPhones: ["(17) 98160-0088"] });
    // WhatsApp sends this number without the 9
    expect(await leads.handleInbound({ phone: "551781600088", body: "ok, obrigado", externalId: "w1", at: new Date() })).toBeNull();
    expect(await db.lead.count()).toBe(0);

    // Wellington's own test lead keeps working
    await leads.createLead({ name: "Wellington", phone: "17981600088", source: "manual" }, "Wellington");
    expect(await leads.handleInbound({ phone: "551781600088", body: "teste", externalId: "w2", at: new Date() })).not.toBeNull();
    expect(await db.message.count({ where: { direction: "IN" } })).toBe(1);
  });
});
