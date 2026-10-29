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

const sentEmails = vi.hoisted(() => [] as { to: string; subject: string; body: string; html?: string }[]);
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (to: string, subject: string, body: string, _a: unknown, html?: string) => {
    sentEmails.push({ to, subject, body, html });
    return "id";
  }),
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
  // Every payload as Meta receives it
  const raw: Record<string, unknown>[] = [];
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
      raw.push(body);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}.${Date.now()}` }] }), { status: 200 });
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    raw.length = 0;
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
      handoffTo: null,
      sendCof: false,
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
    // The confirmation carries the booked time itself, whatever the AI wrote
    expect(sent.map((m) => m.body)).toContainEqual(expect.stringMatching(/^Combinado, reunião marcada!\n\nReunião: .+ \(horário de Brasília\)/));
    expect(await db.job.count({ where: { leadId: lead.id, type: "meeting.reminder" } })).toBeGreaterThan(0);
    const timeline = await db.leadEvent.findMany({ where: { leadId: lead.id, type: "ai.decision" } });
    expect(timeline.map((e) => e.summary)).toEqual([expect.stringContaining("Ofereceu reunião"), expect.stringContaining("Marcou reunião")]);

    // 4. The team cancels it: reminders stop and it no longer counts as booked
    expect(await jobs.cancelMeeting(booked.meetings[0].id, "Gerente")).toBe("Reunião desmarcada.");
    expect(await db.meeting.findUniqueOrThrow({ where: { id: booked.meetings[0].id } })).toMatchObject({ status: "canceled" });
    expect(await db.job.count({ where: { leadId: lead.id, type: "meeting.reminder", status: "PENDING" } })).toBe(0);
    expect(await jobs.cancelMeeting(booked.meetings[0].id, "Gerente")).toBe("Essa reunião já não estava marcada.");
  });

  it("asks a lead who missed the meeting to book again, then nurtures it", async () => {
    const { NO_SHOW_TEMPLATE } = await import("@/lib/pipeline-defaults");
    await db.whatsAppTemplate.create({ data: { ...NO_SHOW_TEMPLATE, buttons: [...NO_SHOW_TEMPLATE.buttons] } });
    const { lead } = await leads.createLead({ name: "Caio Lima", phone: "11977776666", source: "site" }, "teste");
    const stage = (key: string) => db.stage.findFirstOrThrow({ where: { pipelineId: lead.pipelineId, key } });
    const manager = await db.user.findFirstOrThrow();
    // Booked days ago, talked to the AI before that: Meta's window is closed
    await leads.moveLead(lead.id, (await stage("reuniao")).id, "Duda", { aiPaused: true, lastInboundAt: new Date(Date.now() - 3 * 86_400_000) });
    await db.job.updateMany({ where: { leadId: lead.id, status: "PENDING" }, data: { status: "CANCELLED", dedupeKey: null } });
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    const missed = await db.meeting.create({ data: { leadId: lead.id, userId: manager.id, startsAt: at(-60), endsAt: at(-30) } });
    const next = await db.meeting.create({ data: { leadId: lead.id, userId: manager.id, startsAt: at(60 * 24), endsAt: at(60 * 24 + 30) } });

    // Not before it begins
    expect(await jobs.setMeetingOutcome(next.id, "no_show", "Gerente")).toBe("A reunião ainda não começou.");
    expect(await jobs.setMeetingOutcome(missed.id, "no_show", "Gerente")).toMatch(/^Lead em Não compareceu/);
    expect(await jobs.setMeetingOutcome(missed.id, "done", "Gerente")).toBe("Essa reunião já tinha um resultado.");
    let l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("nao_compareceu");
    expect(l.status).toBe("QUALIFIED");
    expect(await db.meeting.findUniqueOrThrow({ where: { id: missed.id } })).toMatchObject({ status: "no_show" });
    expect(await db.meeting.findUniqueOrThrow({ where: { id: next.id } })).toMatchObject({ status: "scheduled" });

    // The AI comes back on; two minutes later the approved message goes, with its buttons
    await drain();
    l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.aiPaused).toBe(false);
    const message = await db.job.findFirstOrThrow({ where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["idle"], equals: false } } });
    await db.job.update({ where: { id: message.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await drain();
    expect(sent).toEqual([{ to: "5511977776666", type: "template", body: NO_SHOW_TEMPLATE.name }]);
    expect(JSON.stringify(raw[0])).toContain('"text":"Caio"');

    // "Agora não": a thank-you, then nurture; the AI stays quiet on the button
    await leads.handleInbound({ phone: "5511977776666", body: "Agora não", externalId: "ns1", at: new Date() });
    // Each rule waits a second per position, so they run in order
    await db.job.updateMany({ where: { leadId: lead.id, type: "rule.run", status: "PENDING", runAt: { lt: at(0.5) } }, data: { runAt: new Date(Date.now() - 1000) } });
    await drain();
    expect(await db.job.count({ where: { leadId: lead.id, type: "sdr.reply" } })).toBe(0);
    expect(sent.at(-1)).toMatchObject({ type: "text", body: expect.stringContaining("Obrigado por avisar") });
    const move = await db.job.findFirstOrThrow({ where: { leadId: lead.id, type: "rule.run", status: "PENDING", runAt: { lt: at(5) } } });
    await db.job.update({ where: { id: move.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await drain();
    l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.key).toBe("nutricao");

    // Dragged there instead of the button: the last meeting that began is the one missed
    const { lead: other } = await leads.createLead({ name: "Rita", phone: "11966665555", source: "site" }, "teste");
    const older = await db.meeting.create({ data: { leadId: other.id, userId: manager.id, startsAt: at(-3 * 24 * 60), endsAt: at(-3 * 24 * 60 + 30), status: "done" } });
    const last = await db.meeting.create({ data: { leadId: other.id, userId: manager.id, startsAt: at(-90), endsAt: at(-60) } });
    await leads.moveLead(other.id, (await db.stage.findFirstOrThrow({ where: { pipelineId: other.pipelineId, key: "nao_compareceu" } })).id, "Gerente");
    expect(await db.meeting.findUniqueOrThrow({ where: { id: last.id } })).toMatchObject({ status: "no_show" });
    expect(await db.meeting.findUniqueOrThrow({ where: { id: older.id } })).toMatchObject({ status: "done" });
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

  it("when WhatsApp doesn't reach a lead: e-mails, the other category, then the error column, and the lead can come back", async () => {
    const messaging = await import("@/lib/messaging");
    await db.whatsAppTemplate.createMany({
      data: [
        { name: "banneg_cadastro_recebido", body: "Olá, {{1}}! Aqui é a {{2}}, do Banneg.", purpose: "first_contact", category: "UTILITY" },
        { name: "banneg_primeiro_contato", body: "Olá, {{1}}! Aqui é a {{2}}.", purpose: "first_contact" },
      ],
    });
    await db.emailTemplate.create({
      data: { key: "whatsapp_nao_chegou", name: "c", subject: "Tentamos falar com você no WhatsApp", body: "Olá, {{nome}}!\n\n{{link_whatsapp}}\n\n{{numero_whatsapp}}" },
    });
    await db.setting.create({ data: { key: "whatsapp_number", value: { number: "+55 11 92013-8123" } } });
    const { lead } = await leads.createLead({ name: "Edu", phone: "11955554444", email: "edu@x.com", source: "site" }, "teste");
    // Only what this test sends: the stage's own automations stay out of the way
    await db.job.updateMany({ where: { leadId: lead.id }, data: { status: "CANCELLED" } });
    const stageKey = async () => (await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } })).stage.key;

    // Meta holds back the marketing message
    failNext = { code: 131049, message: "This message was not delivered to maintain healthy ecosystem engagement." };
    const first = await messaging.sendWhatsApp(lead, "Oi", "Duda", { automatic: true, templateName: "banneg_primeiro_contato" });
    expect(first.ok).toBe(false);
    expect(await stageKey()).not.toBe("erro_envio");

    // The e-mails go and the same message is tried as utility, which doesn't reach either
    sentEmails.length = 0;
    sent.length = 0;
    failNext = { code: 131026, message: "Message undeliverable" };
    await drain();
    expect(sentEmails.map((e) => e.subject)).toEqual(["s", "Tentamos falar com você no WhatsApp"]);
    const contact = sentEmails[1];
    const code = lead.id.slice(-6).toUpperCase();
    expect(contact.body).toContain(`https://wa.me/5511920138123?text=`);
    expect(decodeURIComponent(contact.body)).toContain(`(código ${code})`);
    expect(contact.html).toContain("Chamar no WhatsApp");
    const tries = await db.message.findMany({ where: { leadId: lead.id, channel: "WHATSAPP" }, orderBy: { createdAt: "asc" } });
    expect(tries.map((m) => m.template)).toEqual(["banneg_primeiro_contato", "banneg_cadastro_recebido"]);

    // Marketing and utility denied: out of the cadence, into the error column
    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage).toMatchObject({ key: "erro_envio", name: "Erro no WhatsApp", kind: "LOST" });
    expect(l.aiPaused).toBe(true);
    expect(l.lostReason).toMatch(/WhatsApp não chega/);

    // A retry that was already on its way writes nothing, and the e-mails never go twice
    const before = sent.length;
    expect(await messaging.sendWhatsApp(l, "Oi", "Duda", { automatic: true, purpose: "first_contact" })).toMatchObject({
      ok: true,
      skipped: expect.stringContaining("coluna de erro"),
    });
    expect(sent.length).toBe(before);
    await drain();
    expect(sentEmails).toHaveLength(2);

    // The lead taps the e-mail's button and writes from another number: same lead, number fixed, back in the conversation
    await leads.handleInbound({ phone: "11911112222", body: `Oi! Recebi o e-mail do Banneg e quero conversar. (código ${code})`, externalId: "in-code", at: new Date() });
    const back = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(back).toMatchObject({ phone: "5511911112222", status: "AI_QUALIFYING", lostReason: null });
    expect(back.stage.key).toBe("qualificando");
    expect(await db.lead.count()).toBe(1);
  });

  it("leaves a lead the team closed where it is when WhatsApp doesn't reach it", async () => {
    const messaging = await import("@/lib/messaging");
    await db.whatsAppTemplate.create({ data: { name: "banneg_cadastro_recebido", body: "Olá, {{1}}!", purpose: "first_contact", category: "UTILITY" } });
    const { lead } = await leads.createLead({ name: "Gil", phone: "11955553333", email: "gil@x.com", source: "site" }, "teste");
    const won = await db.stage.findFirstOrThrow({ where: { pipelineId: lead.pipelineId, key: "ganho" } });
    await leads.moveLead(lead.id, won.id, "Wellington");
    await db.job.updateMany({ where: { leadId: lead.id }, data: { status: "CANCELLED" } });
    sentEmails.length = 0;
    sent.length = 0;

    failNext = { code: 131026, message: "Message undeliverable" };
    const closed = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect((await messaging.sendWhatsApp(closed, "Parabéns!", "Wellington")).ok).toBe(false);
    await drain();
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(after.stage.key).toBe("ganho");
    expect(after.status).toBe("WON");
    // Only the team's own message was tried: no utility try, no e-mails
    expect(await db.message.count({ where: { leadId: lead.id, channel: "WHATSAPP" } })).toBe(1);
    expect(sentEmails).toHaveLength(0);
    // A try queued before the team closed the lead doesn't go either
    await db.job.create({ data: { type: "whatsapp.other_category", leadId: lead.id, payload: { category: "UTILITY" }, runAt: new Date() } });
    await drain();
    expect(sent).toHaveLength(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } })).stage.key).toBe("ganho");
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

  it("a lead whose WhatsApp comes without the 9 lands on the lead the form created", async () => {
    const { lead } = await leads.createLead({ name: "Lucas", phone: "61 98765-4321", source: "Instagram" }, "teste");
    await leads.handleInbound({ phone: "556187654321", body: "Confirmo", externalId: "nine1", at: new Date() });
    expect(await db.lead.count({ where: { phone: { in: ["5561987654321", "556187654321"] } } })).toBe(1);
    expect(await db.message.findFirstOrThrow({ where: { externalId: "nine1" } })).toMatchObject({ leadId: lead.id });
    const again = await leads.createLead({ name: "Lucas", phone: "556187654321", source: "site" }, "teste");
    expect(again).toMatchObject({ created: false, lead: { id: lead.id } });
  });

  it("first contact prefers a utility template, which Meta does not hold back from people who never wrote", async () => {
    await db.whatsAppTemplate.deleteMany();
    await db.whatsAppTemplate.create({ data: { name: "a_primeiro_contato", body: "Olá, {{1}}! Posso te enviar?", purpose: "first_contact", category: "MARKETING" } });
    await db.whatsAppTemplate.create({ data: { name: "z_cadastro_recebido", body: "Olá, {{1}}! Recebemos o seu cadastro.", purpose: "first_contact", category: "UTILITY" } });
    await leads.createLead({ name: "Iara Melo", phone: "11922223333", source: "site" }, "teste");
    await drain();
    expect(raw.at(-1)).toMatchObject({ type: "template", template: { name: "z_cadastro_recebido" } });
  });

  it("a message typed by the team with the window closed goes as the CRM's own template, never an imported one", async () => {
    await db.whatsAppTemplate.deleteMany();
    await db.whatsAppTemplate.create({ data: { name: "banneg_reuniao_confirmada_v1", body: "Olá, {{1}}. Sua reunião está confirmada para {{2}}.", purpose: "importado", category: "UTILITY" } });
    await db.whatsAppTemplate.create({ data: { name: "banneg_retomada", body: "Oi, {{1}}! Ficou alguma dúvida?", purpose: "reengagement" } });
    await db.whatsAppTemplate.create({ data: { name: "banneg_cadastro_recebido", body: "Olá, {{1}}! Aqui é a {{2}}. Recebemos o seu cadastro.", purpose: "first_contact", category: "UTILITY" } });
    const { sendWhatsApp } = await import("@/lib/messaging");
    const { lead } = await leads.createLead({ name: "Lucas Dias", phone: "61993330000", source: "Instagram" }, "teste");
    // Never wrote: the first contact, signed by the lead's SDR
    await sendWhatsApp(lead, "Oi Lucas, tudo bem?", "Wellington");
    expect(raw.at(-1)).toMatchObject({ type: "template", template: { name: "banneg_cadastro_recebido", components: [{ parameters: [{ text: "Lucas" }, { text: "Duda" }] }] } });
    // Wrote two days ago: the CRM's own "any questions?"
    const wrote = await db.lead.update({ where: { id: lead.id }, data: { lastInboundAt: new Date(Date.now() - 2 * 86_400_000) } });
    await sendWhatsApp(wrote, "Oi Lucas, tudo bem?", "Wellington");
    expect(raw.at(-1)).toMatchObject({ type: "template", template: { name: "banneg_retomada" } });
  });

  it("sends the kit: template signed by the lead's SDR, materials as video, and stops on request", async () => {
    await db.whatsAppTemplate.deleteMany();
    await db.whatsAppTemplate.create({
      data: { name: "banneg_primeiro_contato", body: "Olá, {{1}}! Aqui é a {{2}}, do time de expansão do Banneg. Posso te enviar?", purpose: "first_contact" },
    });
    const qualificando = await db.stage.findFirstOrThrow({ where: { key: "qualificando" } });
    const rule = await db.automationRule.create({
      data: { stageId: qualificando.id, trigger: "idle", delayMinutes: 120, action: "whatsapp", config: { text: "Aqui está, {{nome}}: {{video_ganhos}}\n\nMe conta: você já vende?" } },
    });
    const { lead } = await leads.createLead({ name: "Hugo Reis", phone: "11922221111", source: "site" }, "teste");
    await drain();

    // 1. First contact by the template, signed by the lead's SDR
    expect(raw.at(-1)).toMatchObject({
      type: "template",
      template: { name: "banneg_primeiro_contato", components: [{ parameters: [{ text: "Hugo" }, { text: "Duda" }] }] },
    });
    expect((await db.message.findFirstOrThrow({ where: { leadId: lead.id, direction: "OUT" } })).body).toContain("Aqui é a Duda,");

    // 2. Lead taps "Pode enviar"; with the window open, the rule's video link goes as a real video with the text as caption
    await leads.handleInbound({ phone: "11922221111", body: "Pode enviar", externalId: "k1", at: new Date() });
    await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
    await db.job.updateMany({ where: { leadId: lead.id, type: "sdr.reply" }, data: { status: "CANCELLED" } });
    // Duda answered and then the lead went quiet: the no-answer rule goes
    await db.message.create({ data: { leadId: lead.id, channel: "WHATSAPP", direction: "OUT", body: "Claro!", author: "Duda", status: "SENT" } });
    const job = await db.job.findFirstOrThrow({ where: { leadId: lead.id, status: "PENDING", payload: { path: ["ruleId"], equals: rule.id } } });
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    raw.length = 0;
    await drain();
    expect(raw).toEqual([
      expect.objectContaining({
        type: "video",
        video: { link: expect.stringMatching(/\/materiais\/como-ganhar-dinheiro\.mp4$/), caption: "Aqui está, Hugo.\n\nMe conta: você já vende?" },
      }),
    ]);

    // 3. Lead taps "Parar mensagens": automations, e-mails and AI stop, and one confirmation goes out
    raw.length = 0;
    await leads.handleInbound({ phone: "11922221111", body: "Parar mensagens", externalId: "k2", at: new Date() });
    const stopped = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(stopped).toMatchObject({ whatsappOptOut: true, emailOptOut: true, aiPaused: true });
    expect(await pendingRules(lead.id)).toBe(0);
    expect(raw).toEqual([expect.objectContaining({ type: "text" })]);
    expect(await jobs.runAction(stopped, "whatsapp", { text: "Oi" })).toMatch(/parar as mensagens/);

    // 4. Window closed and the rule has no Meta template: nothing goes out
    const quiet = await db.lead.update({ where: { id: lead.id }, data: { whatsappOptOut: false, lastInboundAt: new Date(Date.now() - 2 * 86400_000) } });
    raw.length = 0;
    expect(await jobs.runAction(quiet, "whatsapp", { text: "Oi" })).toMatch(/não tem modelo da Meta/);
    expect(await jobs.runAction(quiet, "whatsapp", { text: "Oi", templateName: "banneg_inexistente" })).toMatch(/não está cadastrado/);
    expect(raw).toHaveLength(0);
  });
  it("a no-answer message never talks over the conversation: not while the lead waits, nor once a person took over", async () => {
    const qualificando = await db.stage.findFirstOrThrow({ where: { key: "qualificando" } });
    await db.automationRule.deleteMany({ where: { stageId: qualificando.id } });
    await db.automationRule.create({ data: { stageId: qualificando.id, trigger: "idle", delayMinutes: 120, action: "whatsapp", config: { text: "Oi, {{nome}}! Ainda por aí?" } } });
    const { lead } = await leads.createLead({ name: "Rafa Leite", phone: "11933330000", source: "site" }, "teste");
    await drain();
    const { sendWhatsApp } = await import("@/lib/messaging");
    const nudge = async () => {
      await db.job.updateMany({
        where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["idle"], equals: true } },
        data: { runAt: new Date(Date.now() - 1000) },
      });
      await drain();
      const job = await db.job.findFirstOrThrow({ where: { leadId: lead.id, type: "rule.run", status: "DONE" }, orderBy: { finishedAt: "desc" } });
      return job.result;
    };
    const nudges = () => db.message.count({ where: { leadId: lead.id, body: "Oi, Rafa! Ainda por aí?" } });

    // 1. The AI answered and the lead went quiet: the reminder goes
    nextDecision.value = { reply: "Que bom, Rafa! De qual cidade você fala?", extracted: empty, score: 30, temperature: "morno", decision: "continue", slotIndex: null, handoffTo: null, sendCof: false, reason: "", summary: "" };
    await leads.handleInbound({ phone: "11933330000", body: "Oi", externalId: "n1", at: new Date() });
    await drain();
    await nudge();
    expect(await nudges()).toBe(1);

    // 2. The lead wrote and nobody answered yet: no reminder over its message
    await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
    await leads.handleInbound({ phone: "11933330000", body: "Pode ser na segunda", externalId: "n2", at: new Date() });
    expect(await nudge()).toMatch(/escreveu por último/);
    expect(await nudges()).toBe(1);

    // 3. A person of the team answered: the stage's automatic messages stay quiet
    await leads.handleInbound({ phone: "11933330000", body: "Às 10h", externalId: "n3", at: new Date() });
    await sendWhatsApp(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), "Combinado, Rafa! Segunda às 10h.", "Gerente");
    expect(await nudge()).toBe("Ignorado: Gerente está atendendo este lead.");
    expect(await nudges()).toBe(1);
  });

  it("a lead who got the times and went quiet gets fresh times later, never at night", async () => {
    const qualificado = await db.stage.findFirstOrThrow({ where: { key: "qualificado" } });
    await db.automationRule.deleteMany({ where: { stageId: qualificado.id } });
    const retry = await db.automationRule.create({
      data: {
        stageId: qualificado.id,
        trigger: "idle",
        delayMinutes: 240,
        action: "whatsapp",
        config: { text: "{{nome}}, conseguiu ver os horários? Ainda tenho estes:\n{{horarios}}\nQual fica melhor para você?" },
      },
    });
    const { lead } = await leads.createLead({ name: "Mauro Dias", phone: "11944440000", source: "site" }, "teste");
    await drain();
    nextDecision.value = { reply: "Que bom, Mauro! Qual destes horários fica melhor?", extracted: empty, score: 40, temperature: "quente", decision: "offer_meeting", slotIndex: null, handoffTo: null, sendCof: false, reason: "", summary: "" };
    await leads.handleInbound({ phone: "11944440000", body: "Quero conhecer", externalId: "h1", at: new Date() });
    await drain();
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).stageId).toBe(qualificado.id);

    // Due 4 h later, but never between 21h and 8h in Brasília
    const job = await db.job.findFirstOrThrow({ where: { leadId: lead.id, type: "rule.run", status: "PENDING", payload: { path: ["ruleId"], equals: retry.id } } });
    const hour = (job.runAt.getUTCHours() + 21) % 24;
    expect(hour).toBeGreaterThanOrEqual(8);
    expect(hour).toBeLessThan(21);

    sent.length = 0;
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^Mauro, conseguiu ver os horários\? Ainda tenho estes:\n1\) \S+, \d\d\/\d\d, às \d\d:\d\d\n2\) .+\n3\) .+\nQual fica melhor para você\?$/);
  });

  it("a lead from a click-to-WhatsApp ad keeps the ad as its campaign", async () => {
    nextDecision.value = null;
    const ad = { campaign: "Anúncio: Franquia Banneg", adId: "1203", url: "https://fb.me/x", clickId: "clid" };
    const lead = await leads.handleInbound({ phone: "11955550000", body: "Olá! Quero saber mais", externalId: "ad1", at: new Date(), ad });
    expect(lead).toMatchObject({ source: "whatsapp", campaign: "Anúncio: Franquia Banneg" });
    const event = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead!.id, type: "whatsapp.ad" } });
    expect(event.summary).toBe("Escreveu pelo anúncio do WhatsApp (Franquia Banneg).");
    expect(event.data).toEqual({ adId: "1203", url: "https://fb.me/x", clickId: "clid" });
  });

  it("an automatic e-mail with {{link_whatsapp}} carries the Falar no WhatsApp button, and the tap lands in the lead's conversation", async () => {
    nextDecision.value = null;
    await db.emailTemplate.create({ data: { key: "reativacao_0", name: "r", subject: "Ainda pensa?", body: "Olá, {{nome}}!\n\nToque no botão:\n\n{{link_whatsapp}}\n\nAbraço" } });
    await db.setting.create({ data: { key: "whatsapp_number", value: { number: "+55 11 92013-8123" } } });
    const { lead } = await leads.createLead({ name: "Rui", phone: "11944443333", email: "rui@x.com", source: "importado" }, "teste");
    await db.job.updateMany({ where: { leadId: lead.id }, data: { status: "CANCELLED" } });
    sentEmails.length = 0;
    expect(await jobs.runAction(lead, "email", { templateKey: "reativacao_0" })).toMatch(/enviado/);
    const [mail] = sentEmails;
    const code = lead.id.slice(-6).toUpperCase();
    expect(mail.body).toContain("https://wa.me/5511920138123?text=");
    expect(decodeURIComponent(mail.body)).toContain(`(código ${code})`);
    expect(mail.html).toContain("Falar no WhatsApp");
    // An e-mail without the variable stays as it was
    await db.emailTemplate.create({ data: { key: "nutricao_7", name: "n", subject: "Por quê", body: "Olá, {{nome}}! Responda." } });
    await jobs.runAction(lead, "email", { templateKey: "nutricao_7" });
    expect(sentEmails[1].html).toBeUndefined();

    await leads.handleInbound({ phone: "11944443333", body: `Oi! Recebi o e-mail do Banneg e quero conversar. (código ${code})`, externalId: "tap1", at: new Date() });
    expect(await db.lead.count()).toBe(1);
    expect(await db.job.count({ where: { leadId: lead.id, type: "sdr.reply", status: "PENDING" } })).toBe(1);
  });

  it("a returning lead fills only what was missing, and a lead without a phone is matched by e-mail", async () => {
    const { lead } = await leads.createLead({ name: "Rui", phone: "(061) 98765-0000", source: "site" }, "teste");
    // The leading 0 is the long-distance prefix
    expect(lead.phone).toBe("5561987650000");
    const again = await leads.createLead({ name: "Rui Lima", phone: "61 98765-0000", email: "Rui@X.com", city: "Brasília", source: "Facebook" }, "teste");
    expect(again.created).toBe(false);
    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ name: "Rui", email: "rui@x.com", city: "Brasília" });

    // "-" as the phone is no phone: two such leads never collide on the unique column
    const a = await leads.createLead({ name: "Sem fone", phone: "-", email: "semfone@x.com", source: "Facebook" }, "teste");
    const other = await leads.createLead({ name: "Outro", phone: "-", email: "outro@x.com", source: "Facebook" }, "teste");
    const b = await leads.createLead({ name: "Sem fone", email: " SemFone@x.com ", source: "Facebook" }, "teste");
    expect([a.created, other.created, b.created]).toEqual([true, true, false]);
    expect(a.lead.phone).toBeNull();
    expect(b.lead.id).toBe(a.lead.id);
  });

  it("drops the AI's answer when someone took the lead over while it was thinking", async () => {
    const { lead } = await leads.createLead({ name: "Bia", phone: "41999990005", source: "site" }, "teste");
    await drain();
    sent.length = 0;
    await leads.handleInbound({ phone: "5541999990005", body: "Oi, quero saber mais", externalId: "stale1", at: new Date() });
    const sdr = await import("@/lib/sdr");
    vi.mocked(sdr.runSdrTurn).mockImplementationOnce(async () => {
      await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
      return { reply: "Resposta que não deve sair", extracted: empty, score: 50, temperature: "morno", decision: "continue", slotIndex: null, handoffTo: null, sendCof: false, reason: "", summary: "" };
    });
    const results = await drain();
    expect(sent).toEqual([]);
    expect(results.find((r) => r.type === "sdr.reply")?.result).toMatch(/mudou enquanto a IA respondia/);
  });

  it("a job cut off midway fails once, with a task for the team, instead of hanging", async () => {
    const { lead } = await leads.createLead({ name: "Caio", phone: "41999990006", source: "site" }, "teste");
    const job = await db.job.create({ data: { type: "rule.run", leadId: lead.id, status: "RUNNING", runAt: new Date(Date.now() - 20 * 60_000), dedupeKey: "cut" } });
    await jobs.runDueJobs();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "FAILED", dedupeKey: null });
    expect(await db.task.count({ where: { leadId: lead.id, title: { contains: "Automação interrompida" } } })).toBe(1);
  });

  it("no credit at Anthropic: every screen says the AI stopped, and once it answers again it replies to who waited", async () => {
    const health = await import("@/lib/ai-health");
    const sdr = await import("@/lib/sdr");
    const a = (await leads.createLead({ name: "Dani", phone: "41999990007", source: "site" }, "teste")).lead;
    const b = (await leads.createLead({ name: "Edu", phone: "41999990008", source: "site" }, "teste")).lead;
    await drain();
    sent.length = 0;
    await leads.handleInbound({ phone: "5541999990007", body: "Oi, quero saber da franquia", externalId: "nocredit1", at: new Date() });
    await leads.handleInbound({ phone: "5541999990008", body: "Tenho interesse", externalId: "nocredit2", at: new Date() });
    const noCredit = Object.assign(
      new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'),
      { status: 400 },
    );
    vi.mocked(sdr.runSdrTurn).mockRejectedValue(noCredit);
    try {
      await drain();
      expect(await health.getAiHealth()).toMatchObject({ message: expect.stringContaining("sem crédito") });
      // The retries run out: each lead gets the usual task for the team
      await db.job.updateMany({ where: { type: "sdr.reply", status: "PENDING" }, data: { attempts: 4, runAt: new Date() } });
      await drain();
      expect(await db.job.count({ where: { type: "sdr.reply", status: "FAILED" } })).toBe(2);
      expect(await db.task.count({ where: { title: "Automação falhou (sdr.reply): verificar", doneAt: null } })).toBe(2);
      expect(sent).toEqual([]);
    } finally {
      // Back to the stub's own answer (nextDecision)
      vi.mocked(sdr.runSdrTurn).mockReset();
    }
    // Meanwhile someone took Edu's conversation over
    await db.lead.update({ where: { id: b.id }, data: { aiPaused: true } });

    // Credit is back (the check every 10 minutes got an answer): the banner goes and Dani gets her answer
    expect(await health.aiAnswered()).toBe(1);
    expect(await health.getAiHealth()).toBeNull();
    nextDecision.value = { reply: "Oi Dani! Desculpe a demora.", extracted: empty, score: 40, temperature: "morno", decision: "continue", slotIndex: null, handoffTo: null, sendCof: false, reason: "", summary: "" };
    await drain();
    expect(sent).toEqual([{ to: "5541999990007", type: "text", body: "Oi Dani! Desculpe a demora." }]);
    expect(await db.task.findMany({ where: { title: "Automação falhou (sdr.reply): verificar", doneAt: null }, select: { leadId: true } })).toEqual([{ leadId: b.id }]);
    expect(await db.leadEvent.count({ where: { leadId: a.id, type: "ai.resumed" } })).toBe(1);

    // Next time, the first lead the AI answers clears the banner itself
    await health.setAiHealth("a conta da Anthropic está sem crédito.");
    await leads.handleInbound({ phone: "5541999990007", body: "E quanto custa?", externalId: "nocredit3", at: new Date() });
    await drain();
    expect(await health.getAiHealth()).toBeNull();
  });
});
