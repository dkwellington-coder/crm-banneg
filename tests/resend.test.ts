// Messages lost while the WhatsApp account was blocked (Meta 131031): who gets them again, how, and that the
// block no longer restarts the not-delivered flow every minute. WhatsApp (fetch) and Claude are stubbed.
// Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdrDecision } from "@/lib/sdr";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";
import { templateParams } from "@/lib/resend";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";

const nextDecision = vi.hoisted(() => ({ value: null as SdrDecision | null }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));

const empty = { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null };

it("reads back the values a template carried", () => {
  expect(templateParams("Oi, {{1}}! Reunião {{2}} às {{3}}.", "Oi, Ana Paula! Reunião quinta às 14:30.")).toEqual(["Ana Paula", "quinta", "14:30"]);
  expect(templateParams("Oi, {{1}}! (proposta)", "Oi, Lucas! (proposta)")).toEqual(["Lucas"]);
  expect(templateParams("Oi, {{1}}!", "Outro texto")).toBeUndefined();
});

describe.skipIf(!dbUrl)("resend after an account block", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let resend: typeof import("@/lib/resend");
  let messaging: typeof import("@/lib/messaging");
  const raw: Record<string, unknown>[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    resend = await import("@/lib/resend");
    messaging = await import("@/lib/messaging");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      raw.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${raw.length}.${Date.now()}` }] }), { status: 200 });
    });
  });

  beforeEach(async () => {
    raw.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","User","WhatsAppTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
  });

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const lead = async (name: string, phone: string, data: Record<string, unknown> = {}) => {
    const { lead } = await leads.createLead({ name, phone, source: "site" }, "teste");
    return db.lead.update({ where: { id: lead.id }, data: { stageEnteredAt: hoursAgo(48 * 2), ...data } });
  };
  const out = (leadId: string, body: string, at: Date, data: Record<string, unknown> = {}) =>
    db.message.create({
      data: { leadId, channel: "WHATSAPP", direction: "OUT", body, author: "Duda", status: "FAILED", errorCode: 131031, error: "bloqueada", createdAt: at, ...data },
    });

  it("answers again who was waiting, resends the rest once and leaves out the closed, the paused queue and the ones reached since", async () => {
    const duda = await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    await db.whatsAppTemplate.create({ data: { name: "banneg_proposta", body: "Oi, {{1}}! Conseguiu olhar a proposta?" } });

    // Wrote, and the AI's answer (with a time that has passed) was lost
    const felipe = await lead("Felipe Souza", "11955550001", { sdrId: duda.id, status: "AI_QUALIFYING", lastInboundAt: hoursAgo(9) });
    await db.message.create({ data: { leadId: felipe.id, channel: "WHATSAPP", direction: "IN", body: "Quero conversar", author: "Felipe", status: "RECEIVED", createdAt: hoursAgo(9) } });
    await out(felipe.id, "Qual horário? 1) Hoje às 14:00", hoursAgo(8.9));
    // An automation's template, window closed; the same one failed three times
    const lucas = await lead("Lucas Lima", "11955550002", { aiPaused: true, lastInboundAt: hoursAgo(120) });
    for (const h of [3, 2.9, 2.8]) await out(lucas.id, "Oi, Lucas! Conseguiu olhar a proposta?", hoursAgo(h), { template: "banneg_proposta", author: "Alice" });

    // A meeting reminder is not sent again: "amanhã" may be today by now, and the one an hour before goes anyway
    const andre = await lead("André", "11955550007", { aiPaused: true, lastInboundAt: hoursAgo(20) });
    await out(andre.id, "Lembrete: nossa reunião é amanhã, quinta-feira, 22/10, 14:30. Até lá!", hoursAgo(18), { author: "Automação" });

    // Left out: the contact's own failure, a closed lead, a lead reached since, and the paused queue of the old base
    const paola = await lead("Paola", "11955550003");
    await out(paola.id, "Oi, Paola!", hoursAgo(3), { errorCode: 131049 });
    const lost = await lead("Perdido", "11955550004", { status: "LOST" });
    await out(lost.id, "Oi!", hoursAgo(3));
    const reached = await lead("Respondido", "11955550005");
    await out(reached.id, "Oi!", hoursAgo(3));
    await out(reached.id, "Oi de novo!", hoursAgo(1), { status: "DELIVERED", errorCode: null });
    const other = await db.stage.findFirstOrThrow({ where: { pipelineId: felipe.pipelineId, id: { not: felipe.stageId } } });
    const queued = await lead("Base antiga", "11955550006", { stageId: other.id });
    await db.automationRule.create({ data: { stageId: felipe.stageId, trigger: "daily", action: "move", active: false, config: { perDay: 150, toStageId: other.id } } });
    await out(queued.id, "Oi, faz tempo!", hoursAgo(3));

    const since = hoursAgo(resend.RESEND_HOURS);
    const found = await resend.blockedByAccount(since);
    expect(found.map((b) => [b.lead.name, b.waitingForAi, b.messages.map((m) => m.body)])).toEqual([
      ["Felipe Souza", true, ["Qual horário? 1) Hoje às 14:00"]],
      ["Lucas Lima", false, ["Oi, Lucas! Conseguiu olhar a proposta?"]],
    ]);

    // One job per lead, spaced; a double click keeps them
    expect(await resend.scheduleResends()).toBe(2);
    expect(await resend.scheduleResends()).toBe(2);
    const scheduled = await db.job.findMany({ where: { type: "whatsapp.resend" }, orderBy: { runAt: "asc" } });
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].runAt.getTime() - scheduled[0].runAt.getTime()).toBe(20_000);
    await db.job.updateMany({ where: { type: "whatsapp.resend" }, data: { runAt: new Date() } });

    nextDecision.value = {
      reply: "Felipe, amanhã às 10h fica bom?",
      extracted: empty,
      score: 60,
      temperature: "morno",
      decision: "continue",
      slotIndex: null,
      handoffTo: null,
      sendCof: false,
      reason: "quer conversar",
      summary: "Felipe quer conversar.",
    };
    const results = await jobs.runDueJobs();
    expect(results.every((r) => r.ok)).toBe(true);

    // The AI wrote a fresh answer, without the lost message in what it read
    const { runSdrTurn } = await import("@/lib/sdr");
    const ctx = vi.mocked(runSdrTurn).mock.calls.at(-1)![0];
    expect(ctx.transcript.map((m) => m.body)).toEqual(["Quero conversar"]);
    expect(raw.find((r) => r.to === "5511955550001")).toMatchObject({ type: "text", text: { body: "Felipe, amanhã às 10h fica bom?" } });
    // Lucas got the same template with the same name, once
    const toLucas = raw.filter((r) => r.to === "5511955550002");
    expect(toLucas).toHaveLength(1);
    expect(toLucas[0]).toMatchObject({ type: "template", template: { name: "banneg_proposta", components: [{ parameters: [{ text: "Lucas" }] }] } });
    expect(raw).toHaveLength(2);
    expect(await db.leadEvent.count({ where: { type: "whatsapp.resent" } })).toBe(2);

    // Done: nothing left to resend
    expect(await resend.blockedByAccount(since)).toEqual([]);
  });

  it("an account block does not restart the not-delivered flow (it ran every minute during the block)", async () => {
    const paola = await lead("Paola", "11955550003");
    await out(paola.id, "Oi, faz tempo!", hoursAgo(3), { errorCode: 131049 });
    // The other category's try failed because the account was blocked: nothing new
    await messaging.afterUndelivered(paola.id, "A conta do WhatsApp Business foi bloqueada pela Meta.", 131031);
    const flow = { leadId: paola.id, type: { in: ["whatsapp.other_category", "whatsapp.undelivered_emails"] } };
    expect(await db.job.count({ where: flow })).toBe(0);
    // The lead's own failure still starts it
    await messaging.afterUndelivered(paola.id, "held", 131049);
    expect(await db.job.count({ where: { leadId: paola.id, type: "whatsapp.other_category" } })).toBe(1);
  });
});
