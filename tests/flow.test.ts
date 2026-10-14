// End-to-end flow against a real Postgres: new lead → AI first contact → lead replies → AI qualifies → meeting booked.
// WhatsApp (fetch) and Claude (runSdrTurn) are stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdrDecision } from "@/lib/sdr";

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
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","Stage","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    const keys = ["novo", "qualificando", "qualificado", "reuniao", "com_gerente", "proposta", "nutricao", "ganho", "perdido", "descartado"];
    for (const [position, key] of keys.entries()) {
      await db.stage.create({
        data: { key, name: key, position, kind: key === "ganho" ? "WON" : ["perdido", "descartado"].includes(key) ? "LOST" : "OPEN" },
      });
    }
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
    await db.whatsAppTemplate.create({ data: { name: "boas_vindas", body: "Olá {{1}}, aqui é da Banneg!", purpose: "first_contact" } });
    await db.emailTemplate.create({ data: { key: "boas_vindas_0", name: "b", subject: "s", body: "b", sequenceDay: 0 } });
  });

  it("qualifies a new lead and books a meeting without a human", async () => {
    const { lead } = await leads.createLead({ name: "Ana Souza", phone: "(41) 99999-0000", email: "ana@x.com", source: "site" }, "teste");
    expect(lead.phone).toBe("5541999990000");
    expect(await db.job.count({ where: { leadId: lead.id, type: "email.send" } })).toBe(1);

    // 1. AI first contact: window closed, so it goes as the approved template
    await jobs.runDueJobs();
    expect(sent).toEqual([{ to: "5541999990000", type: "template", body: "boas_vindas" }]);
    let l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("qualificando");
    expect(await db.job.count({ where: { leadId: lead.id, type: "followup.check", status: "PENDING" } })).toBe(1);

    // 2. Lead answers; follow-up is cancelled and the AI qualifies
    await leads.handleInbound({ phone: "5541999990000", body: "Oi! Tenho 300 mil e quero abrir em Curitiba", externalId: "in1", at: new Date() });
    expect(await db.job.count({ where: { leadId: lead.id, type: "followup.check", status: "PENDING" } })).toBe(0);
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
    await jobs.runDueJobs();
    l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("qualificado");
    expect(l.city).toBe("Curitiba");
    expect(l.qualification).toMatchObject({ capital: "R$ 300 mil" });
    expect(sent.at(-1)).toMatchObject({ type: "text" });

    // 3. Lead picks a slot; meeting is booked, reminders scheduled and the AI steps back
    await leads.handleInbound({ phone: "5541999990000", body: "Pode ser o 0", externalId: "in2", at: new Date() });
    nextDecision.value = { ...nextDecision.value, decision: "book_meeting", slotIndex: 0, reply: "Combinado, reunião marcada!" };
    await jobs.runDueJobs();
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
    failNext = { code: 131042, message: "Message failed to send because of payment" };
    const [r] = await jobs.runDueJobs();
    expect(r.ok).toBe(false);
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
});
