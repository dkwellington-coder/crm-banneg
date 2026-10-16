// The four funnels: old leads released from a queue a few per day, the AI handing qualified
// leads to the franchise funnel, and site forms (Clube Sincomércio) landing in their own funnel.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdrDecision } from "@/lib/sdr";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";
import { isSendingWindow, localClock } from "@/lib/batches";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";
process.env.SITE_LEADS_TOKEN = "site-token";

const nextDecision = vi.hoisted(() => ({ value: null as SdrDecision | null }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));

// Wednesday 14 Oct 2026, 12:00 in São Paulo
const NOON = new Date("2026-10-14T15:00:00Z");

describe("sending window", () => {
  it("uses São Paulo time, business days from 9h to 18h", () => {
    expect(localClock(NOON)).toMatchObject({ day: "2026-10-14", weekday: "Wed", hour: 12 });
    expect(isSendingWindow(NOON)).toBe(true);
    expect(isSendingWindow(new Date("2026-10-14T11:30:00Z"))).toBe(false); // 8h30
    expect(isSendingWindow(new Date("2026-10-14T21:00:00Z"))).toBe(false); // 18h
    expect(isSendingWindow(new Date("2026-10-17T15:00:00Z"))).toBe(false); // Saturday
  });
});

describe.skipIf(!dbUrl)("funnels", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let batches: typeof import("@/lib/batches");
  let api: typeof import("@/app/api/leads/route");
  const sent: { to: string; type: string; body: unknown }[] = [];
  let franchise: { id: string };

  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await jobs.runDueJobs()).length === 0) break;
  };

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    batches = await import("@/lib/batches");
    api = await import("@/app/api/leads/route");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({ to: body.to, type: body.type, body: body.text?.body ?? body.template?.name });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}.${Date.now()}` }] }), { status: 200 });
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    franchise = await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
    await db.whatsAppTemplate.create({ data: { name: "banneg_reativacao", body: "Oi, {{1}}! Ainda faz sentido?", purpose: "followup" } });
  });

  async function oldLeadsFunnel(perDay = 150) {
    const p = await db.pipeline.create({ data: { name: "Leads antigos (Franquias)", slug: "antigos", nextPipelineId: franchise.id, position: 1 } });
    const fila = await db.stage.create({ data: { pipelineId: p.id, key: "fila", name: "Na fila", position: 0 } });
    const reativ = await db.stage.create({ data: { pipelineId: p.id, key: "reativacao", name: "Reativação enviada", position: 1 } });
    const conversa = await db.stage.create({ data: { pipelineId: p.id, key: "qualificando", name: "IA conversando", position: 2 } });
    await db.automationRule.create({ data: { stageId: fila.id, trigger: "daily", action: "move", config: { toStageId: reativ.id, perDay } } });
    await db.automationRule.create({
      data: { stageId: reativ.id, action: "whatsapp", config: { text: "Oi, {{nome}}! Ainda faz sentido?", templateName: "banneg_reativacao" } },
    });
    return { p, fila, reativ, conversa };
  }

  async function importOld(stageId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await leads.createLead(
        { name: `Antigo ${i}`, phone: `119000000${String(i).padStart(2, "0")}`, source: "Kommo", stageId, reactivation: true, createdAt: new Date(2025, 0, i + 1) },
        "importação",
      );
    }
  }

  it("old leads wait in the queue and leave a few per tick, newest first, up to the daily limit", async () => {
    const { fila, reativ } = await oldLeadsFunnel(7);
    await importOld(fila.id, 12);
    // Importing sends nothing
    expect(await db.job.count()).toBe(0);

    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 5 });
    const first = await db.lead.findMany({ where: { stageId: reativ.id }, orderBy: { createdAt: "desc" } });
    expect(first.map((l) => l.name)).toEqual(["Antigo 11", "Antigo 10", "Antigo 9", "Antigo 8", "Antigo 7"]);
    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 2 });
    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 0 });
    // The next day the queue moves again; never at night
    expect(await batches.runDailyBatches(new Date("2026-10-15T23:00:00Z"))).toEqual({ released: 0 });
    expect(await batches.runDailyBatches(new Date("2026-10-15T15:00:00Z"))).toEqual({ released: 5 });

    // Entering "Reativação enviada" sends the Meta template (window closed for old leads)
    await drain();
    expect(sent.filter((s) => s.type === "template")).toHaveLength(12);
  });

  it("leads the old CRM already messaged, and e-mail-only leads, wait at the back of the queue", async () => {
    const { fila, reativ } = await oldLeadsFunnel(4);
    await importOld(fila.id, 4);
    await db.lead.updateMany({ where: { name: { in: ["Antigo 3", "Antigo 2"] } }, data: { lastContactAt: new Date("2026-10-12T12:00:00Z") } });
    await db.lead.update({ where: { phone: "5511900000003" }, data: { lastContactAt: new Date("2026-10-15T12:00:00Z") } });
    await leads.createLead({ name: "Só e-mail", email: "so@email.com", source: "Kommo", stageId: fila.id, reactivation: true }, "importação");

    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 4 });
    const out = await db.lead.findMany({ where: { stageId: reativ.id }, select: { name: true } });
    expect(out.map((l) => l.name).sort()).toEqual(["Antigo 0", "Antigo 1", "Antigo 2", "Antigo 3"]);
    // Next day: only the e-mail-only lead is left
    expect(await batches.runDailyBatches(new Date("2026-10-15T15:00:00Z"))).toEqual({ released: 1 });
  });

  it("releases never-contacted leads first, then the ones contacted longest ago", async () => {
    const { fila, reativ } = await oldLeadsFunnel(2);
    await importOld(fila.id, 4);
    await db.lead.update({ where: { phone: "5511900000003" }, data: { lastContactAt: new Date("2026-10-15T12:00:00Z") } });
    await db.lead.update({ where: { phone: "5511900000002" }, data: { lastContactAt: new Date("2026-10-12T12:00:00Z") } });
    await db.lead.update({ where: { phone: "5511900000001" }, data: { lastContactAt: new Date("2026-10-13T12:00:00Z") } });
    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 2 });
    const out = await db.lead.findMany({ where: { stageId: reativ.id }, select: { name: true } });
    expect(out.map((l) => l.name).sort()).toEqual(["Antigo 0", "Antigo 2"]);
  });

  it("in test mode only test contacts leave the queue, and a Meta block holds everyone", async () => {
    const { fila, reativ } = await oldLeadsFunnel();
    await importOld(fila.id, 6);
    await db.setting.update({ where: { key: "crm" }, data: { value: { testMode: true, testContacts: ["11 90000-0003"] } } });
    expect(await batches.runDailyBatches(NOON)).toEqual({ released: 1 });
    expect((await db.lead.findFirstOrThrow({ where: { stageId: reativ.id } })).name).toBe("Antigo 3");

    await db.setting.update({ where: { key: "crm" }, data: { value: { testMode: false } } });
    await db.setting.create({ data: { key: "whatsapp_health", value: { code: 131042, message: "Pagamento pendente", at: NOON.toISOString() } } });
    expect(await batches.runDailyBatches(NOON)).toMatchObject({ released: 0, paused: "Pagamento pendente" });
    // Two hours later a few go out as a probe
    expect(await batches.runDailyBatches(new Date(NOON.getTime() + 2.5 * 3600_000))).toEqual({ released: 5 });
  });

  it("an old lead that qualifies goes on to the franchise funnel", async () => {
    const { reativ } = await oldLeadsFunnel();
    const { lead } = await leads.createLead({ name: "Bia", phone: "11955554444", source: "Kommo", stageId: reativ.id, reactivation: true }, "importação");
    await leads.handleInbound({ phone: "11955554444", body: "Quero conversar", externalId: "a1", at: new Date() });
    nextDecision.value = {
      reply: "Que bom! Me conta: em qual cidade você pensa em abrir?",
      extracted: { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null },
      score: 30,
      temperature: "morno",
      decision: "continue",
      slotIndex: null,
      reason: "retomou interesse",
      summary: "Bia retomou.",
    };
    await drain();
    let l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.stage.name).toBe("IA conversando");

    // The old-leads funnel has no "Com o gerente": the lead moves to Vendas de Franquias
    await leads.handleInbound({ phone: "11955554444", body: "Quero falar com alguém", externalId: "a2", at: new Date() });
    nextDecision.value = { ...nextDecision.value, decision: "handoff", reply: "Vou chamar o gerente." };
    await drain();
    l = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { stage: true } });
    expect(l.pipelineId).toBe(franchise.id);
    expect(l.stage.key).toBe("com_gerente");
  });

  it("daily rules are not scheduled per lead", async () => {
    const { fila } = await oldLeadsFunnel();
    const { lead } = await leads.createLead({ name: "C", phone: "11911112222", source: "x", stageId: fila.id }, "teste");
    expect(lead.stageId).toBe(fila.id);
    expect(await db.job.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("the Clube Sincomércio form lands in Sindicatos with the product, and the referral too", async () => {
    const sind = await db.pipeline.create({ data: { name: "Sindicatos", slug: "sindicatos", position: 3 } });
    await db.stage.create({ data: { pipelineId: sind.id, key: "novo", name: "Novo pedido", position: 0 } });
    const post = (body: unknown, token = "site-token") =>
      api.POST(new Request("http://x/api/leads", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));

    expect((await post({ nome: "X", whatsapp: "11999990000" }, "errado")).status).toBe(401);
    const res = await post({
      nome: "Carla Lima",
      whatsapp: "5511987654321",
      email: "carla@x.com",
      empresa: "Loja da Carla",
      produto: "Plano odontológico",
      indicado_nome: "Rui",
      indicado_whatsapp: "11912345678",
      origem: "direto",
      campanha: "sincomercio",
      funil: "Sincomercio",
      associado_sindicato: true,
      recebido_em: new Date().toISOString(),
    });
    expect(res.status).toBe(201);
    const { id, referral } = await res.json();
    const carla = await db.lead.findUniqueOrThrow({ where: { id }, include: { stage: true } });
    expect(carla).toMatchObject({ pipelineId: sind.id, name: "Carla Lima", phone: "5511987654321", source: "direto", campaign: "sincomercio" });
    expect(carla.stage.name).toBe("Novo pedido");
    expect(carla.qualification).toMatchObject({ produto: "Plano odontológico", empresa: "Loja da Carla" });
    const rui = await db.lead.findUniqueOrThrow({ where: { id: referral } });
    expect(rui).toMatchObject({ pipelineId: sind.id, phone: "5511912345678", source: "Indicação de Carla Lima" });

    // Same person again: no duplicate, 200
    expect((await post({ nome: "Carla", whatsapp: "11987654321", produto: "Seguro auto", campanha: "sincomercio" })).status).toBe(200);
    // Without a funnel the lead goes to the default one
    const plain = await (await post({ name: "Davi", phone: "11933332222" })).json();
    expect((await db.lead.findUniqueOrThrow({ where: { id: plain.id } })).pipelineId).toBe(franchise.id);
  });
});
