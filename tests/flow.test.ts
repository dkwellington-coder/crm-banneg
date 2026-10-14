// End-to-end flow against a real Postgres: new lead → AI first contact → lead replies → AI qualifies → meeting booked.
// WhatsApp (fetch) and Claude (runSdrTurn) are stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdrDecision } from "@/lib/sdr";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";

const nextDecision = vi.hoisted(() => ({ value: null as SdrDecision | null }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));

const empty = { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null };

describe.skipIf(!dbUrl)("lead flow", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  // Runs jobs until nothing is due (a job can schedule another one for right now)
  const drain = async () => {
    const all = [];
    for (let i = 0; i < 5; i++) {
      const r = await jobs.runDueJobs();
      if (r.length === 0) break;
      all.push(...r);
    }
    return all;
  };
  const pendingRules = (leadId: string, idle?: boolean) =>
    db.job.count({
      where: { leadId, type: "rule.run", status: "PENDING", ...(idle !== undefined && { payload: { path: ["idle"], equals: idle } }) },
    });
  const sent: { to: string; type: string; body: unknown }[] = [];
  let failNext: { code: number; message: string } | null = null;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (failNext) {
        const error = failNext;
        failNext = null;
        return new Response(JSON.stringify({ error }), { status: 400 });
      }
      sent.push({ to: body.to, type: body.type, body: body.text?.body ?? body.template?.name });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}.${Date.now()}` }] }), { status: 200 });
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
    await db.whatsAppTemplate.create({ data: { name: "boas_vindas", body: "Olá {{1}}, aqui é da Banneg!", purpose: "first_contact" } });
    await db.emailTemplate.create({ data: { key: "boas_vindas_0", name: "b", subject: "s", body: "b", sequenceDay: 0 } });
  });

  it("qualifies a new lead and books a meeting without a human", async () => {
    const { lead } = await leads.createLead({ name: "Ana Souza", phone: "(41) 99999-0000", email: "ana@x.com", source: "site" }, "teste");
    expect(lead.phone).toBe("5541999990000");
    expect(lead.pipelineId).toBeTruthy();
    // Novo: turn the AI on + three welcome emails
    expect(await pendingRules(lead.id)).toBe(4);

    // 1. AI first contact: window closed, so it goes as the approved template
    await drain();
    expect(sent).toEqual([{ to: "5541999990000", type: "template", body: "boas_vindas" }]);
    let l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("qualificando");
    // "IA qualificando" has four no-answer rules (1, 3, 7 days, then nutrição)
    expect(await pendingRules(lead.id, true)).toBe(4);

    // 2. Lead answers; the no-answer clock restarts and the AI qualifies
    const before = await db.job.findMany({ where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["idle"], equals: true } } });
    await leads.handleInbound({ phone: "5541999990000", body: "Oi! Tenho 300 mil e quero abrir em Curitiba", externalId: "in1", at: new Date() });
    expect(await db.job.count({ where: { id: { in: before.map((j) => j.id) }, status: "CANCELLED" } })).toBe(4);
    expect(await pendingRules(lead.id, true)).toBe(4);
    nextDecision.value = {
      reply: "Ótimo! Tenho estes horários: 0) amanhã 10h, 1) amanhã 11h. Qual prefere?",
      extracted: { ...empty, city: "Curitiba", state: "PR", capital: "R$ 300 mil" },
      score: 82,
      temperature: "quente",
      decision: "offer_meeting",
      slotIndex: null,
      reason: "capital e região ok",
      summary: "Ana, Curitiba, R$ 300 mil.",
    };
    await drain();
    l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("qualificado");
    // Leaving "IA qualificando" drops its no-answer rules; the welcome emails keep going
    expect(await pendingRules(lead.id, true)).toBe(0);
    expect(await pendingRules(lead.id)).toBe(4);
    expect(l.city).toBe("Curitiba");
    expect(l.qualification).toMatchObject({ capital: "R$ 300 mil" });
    expect(sent.at(-1)).toMatchObject({ type: "text" });

    // 3. Lead picks a slot; meeting is booked, reminders scheduled and the AI steps back
    await leads.handleInbound({ phone: "5541999990000", body: "Pode ser o 0", externalId: "in2", at: new Date() });
    nextDecision.value = { ...nextDecision.value, decision: "book_meeting", slotIndex: 0, reply: "Combinado, reunião marcada!" };
    await drain();
    const booked = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true, meetings: true, owner: true } });
    expect(booked.stage.key).toBe("reuniao");
    expect(booked.meetings).toHaveLength(1);
    expect(booked.owner?.name).toBe("Gerente");
    expect(booked.aiPaused).toBe(true);
    expect(await db.job.count({ where: { leadId: lead.id, type: "meeting.reminder" } })).toBeGreaterThan(0);
    const timeline = await db.leadEvent.findMany({ where: { leadId: lead.id, type: "ai.decision" } });
    expect(timeline.map((e) => e.summary)).toEqual([expect.stringContaining("Ofereceu reunião"), expect.stringContaining("Marcou reunião")]);
  });

  it("shows the Meta payment error as an account problem and retries the job", async () => {
    const { lead } = await leads.createLead({ name: "Bia", phone: "11988887777", source: "site" }, "teste");
    await jobs.runDueJobs(); // turns the AI on, which queues the first contact
    failNext = { code: 131042, message: "Message failed to send because of payment" };
    const [r] = await jobs.runDueJobs();
    expect(r).toMatchObject({ type: "sdr.first_contact", ok: false });
    const health = await db.setting.findUnique({ where: { key: "whatsapp_health" } });
    expect(health?.value).toMatchObject({ code: 131042 });
    const job = await db.job.findFirstOrThrow({ where: { leadId: lead.id, type: "sdr.first_contact" } });
    expect(job.status).toBe("PENDING");
    expect(job.lastError).toMatch(/Pagamento pendente/);
    const msg = await db.message.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(msg.status).toBe("FAILED");
  });

  it("does not duplicate a lead that comes back from another source", async () => {
    await leads.createLead({ name: "Caio", phone: "11977776666", source: "site" }, "teste");
    const again = await leads.createLead({ name: "Caio", phone: "+55 11 97777-6666", source: "instagram" }, "teste");
    expect(again.created).toBe(false);
    expect(await db.lead.count()).toBe(1);
  });

  it("runs the no-answer rules the team set on the stage", async () => {
    const { lead } = await leads.createLead({ name: "Davi Lima", phone: "11966665555", source: "site" }, "teste");
    await drain();
    // Make the "1 day without answer" rule due now
    const first = await db.job.findFirstOrThrow({
      where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["idle"], equals: true } },
      orderBy: { runAt: "asc" },
    });
    await db.job.update({ where: { id: first.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await leads.handleInbound({ phone: "11966665555", body: "oi", externalId: "x1", at: new Date(Date.now() - 60_000) });
    // The lead wrote, so that run was cancelled and the clock restarted
    expect((await db.job.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("CANCELLED");

    // Lead goes silent: fire the restarted 1-day rule
    await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
    await db.job.updateMany({ where: { leadId: lead.id, type: "sdr.reply" }, data: { status: "CANCELLED" } });
    const next = await db.job.findFirstOrThrow({
      where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["idle"], equals: true } },
      orderBy: { runAt: "asc" },
    });
    await db.job.update({ where: { id: next.id }, data: { runAt: new Date(Date.now() - 1000) } });
    sent.length = 0;
    await drain();
    expect(sent).toHaveLength(1);
    const out = await db.message.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUT" }, orderBy: { createdAt: "desc" } });
    expect(out.body).toMatch(/^Oi, Davi! Conseguiu ver minha mensagem/);
    expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "automation.ran" } })).toBeGreaterThan(0);
  });

  it("winning a deal stops automations, stamps the date and counts for the goal", async () => {
    const { lead } = await leads.createLead({ name: "Eva", phone: "11955554444", source: "site" }, "teste");
    const owner = await db.user.findFirstOrThrow();
    await db.lead.update({ where: { id: lead.id }, data: { value: 150000, ownerId: owner.id } });
    const won = await db.stage.findFirstOrThrow({ where: { key: "ganho" } });
    await leads.moveLead(lead.id, won.id, "teste");
    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(l.status).toBe("WON");
    expect(l.wonAt).toBeInstanceOf(Date);
    // Only the "Ganho" rule (onboarding task) is left
    expect(await pendingRules(lead.id)).toBe(1);
    await drain();
    expect(await db.task.count({ where: { leadId: lead.id, title: { contains: "onboarding" } } })).toBe(1);

    const { actuals, currentPeriod } = await import("@/lib/goals");
    const get = await actuals(currentPeriod());
    expect(get("vendas", null)).toBe(1);
    expect(get("receita", owner.id)).toBe(150000);
  });

  it("a custom funnel without AI stages still works", async () => {
    const pipeline = await db.pipeline.create({
      data: { name: "Revenda", stages: { create: [{ name: "Entrada", position: 0 }, { name: "Fechado", position: 1, kind: "WON" }] } },
      include: { stages: true },
    });
    const [entrada] = pipeline.stages.sort((a, b) => a.position - b.position);
    await db.automationRule.create({
      data: { stageId: entrada.id, action: "task", config: { title: "Ligar para o revendedor" }, delayMinutes: 0 },
    });
    const { lead } = await leads.createLead({ name: "Fábio", phone: "11944443333", source: "site", pipelineId: pipeline.id }, "teste");
    expect(lead.stageId).toBe(entrada.id);
    await drain();
    expect(await db.task.count({ where: { leadId: lead.id, title: "Ligar para o revendedor" } })).toBe(1);
  });

  it("test mode records messages to other leads as simulated and only sends to test contacts", async () => {
    await db.setting.update({ where: { key: "crm" }, data: { value: { testMode: true, testContacts: ["(41) 98888-1111"] } } });
    const other = (await leads.createLead({ name: "Gil", phone: "11933332222", source: "site" }, "teste")).lead;
    const mine = (await leads.createLead({ name: "Eu", phone: "41988881111", source: "site" }, "teste")).lead;
    await drain();
    expect(sent.map((s) => s.to)).toEqual(["5541988881111"]);
    const simulated = await db.message.findFirstOrThrow({ where: { leadId: other.id, direction: "OUT" } });
    expect(simulated.status).toBe("SIMULATED");
    // The funnel still moves as if it had been sent
    expect((await db.lead.findUniqueOrThrow({ where: { id: other.id }, include: { stage: true } })).stage.key).toBe("qualificando");
    expect((await db.message.findFirstOrThrow({ where: { leadId: mine.id, direction: "OUT" } })).status).toBe("SENT");
  });
});
