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
process.env.PORTAL_LEADS_TOKEN = "portal-token";

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
  const sent: { to: string; type: string; body: unknown; params?: string[] }[] = [];
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
      const params = body.template?.components?.find((c: { type: string }) => c.type === "body")?.parameters.map((p: { text: string }) => p.text);
      sent.push({ to: body.to, type: body.type, body: body.text?.body ?? body.template?.name, params });
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

  it("imports the old CRM's export: queues per funnel, opt-outs kept apart, nothing duplicated or sent", async () => {
    const { p, fila } = await oldLeadsFunnel();
    const desc = await db.stage.create({ data: { pipelineId: p.id, key: "descartado", name: "Descartado", position: 5, kind: "LOST" } });
    const prod = await db.pipeline.create({ data: { name: "Aquecimento de Produtos", slug: "produtos", position: 2 } });
    const prodFila = await db.stage.create({ data: { pipelineId: prod.id, key: "fila", name: "Na fila", position: 0 } });
    const prodNovo = await db.stage.create({ data: { pipelineId: prod.id, key: "novo", name: "Novo pedido", position: 2 } });
    await db.automationRule.create({ data: { stageId: prodNovo.id, action: "whatsapp", config: { text: "Recebi seu pedido" } } });
    const prodPerdido = await db.stage.create({ data: { pipelineId: prod.id, key: "perdido", name: "Perdido", position: 11, kind: "LOST" } });
    // Already in the CRM through WhatsApp, without the 9
    await leads.createLead({ name: "Lucas", phone: "556193258573", source: "whatsapp", reactivation: true }, "teste");

    const csv = [
      "﻿id;nome;telefone;email;cidade;estado;origem;campanha;criado_em;ultimo_contato_em;etapa;status;nao_contatar;funil",
      "a1;Lucas David;5561993258573;;;;Meta Ads;;2026-10-15 18:53;;Reunião agendada;open;não;antigos",
      "a2;JOÃO DA SILVA;11988887777;Joao@X.com;Curitiba;PR;Base antiga;Reativação BANNEG;2026-10-02 17:11;;Pronto para contato;open;não;antigos",
      "a3;Ana;5511977776666;;;;Base antiga · consórcio;Aquecimento Consórcios;2026-10-05 10:00;2026-10-12 09:00;Alice aquecendo;open;não;produtos",
      "a4;Zé;11966665555;;;;Base antiga;;2026-10-02 17:11;2026-10-09 10:00;Sem interesse / não contatar;lost;sim;antigos",
      "a5;Bia;11955554444;;;;Base antiga · consórcio;;2026-10-05 10:00;;Sem resposta;lost;não;produtos",
      "a6;Zé de novo;551166665555;;;;Base antiga;;2026-10-02 17:11;;Pronto para contato;open;não;antigos",
      "a7;Franqueado;11944443333;;;;Base antiga;;2026-10-02 17:11;;Fechado;won;não;antigos",
      "a8;Sem nome (Kommo #12);;so@email.com;;;Base antiga;;2026-10-02 17:11;;Base para revisar;open;não;",
      "a9;Ninguém;;;;;Base antiga;;;;;open;não;",
    ].join("\r\n");
    const { importLeads, importSummary } = await import("@/lib/import");
    const count = await importLeads(csv, { pipelineId: p.id, startAi: false, actor: "Teste" });
    expect(count).toEqual({ created: 5, queued: 3, optOut: 1, lost: 1, existing: 1, repeated: 1, won: 1, empty: 1 });
    expect(importSummary(count)).toContain("5 leads importados");

    const joao = await db.lead.findUniqueOrThrow({ where: { phone: "5511988887777" } });
    expect(joao).toMatchObject({ name: "João Da Silva", email: "joao@x.com", stageId: fila.id, status: "NEW", externalId: "a2", whatsappOptOut: false });
    expect(joao.createdAt.toISOString()).toBe("2026-10-02T20:11:00.000Z");
    const ana = await db.lead.findUniqueOrThrow({ where: { phone: "5511977776666" } });
    expect(ana).toMatchObject({ pipelineId: prod.id, stageId: prodFila.id });
    expect(ana.lastContactAt?.toISOString()).toBe("2026-10-12T12:00:00.000Z");
    expect(await db.lead.findUniqueOrThrow({ where: { phone: "5511966665555" } })).toMatchObject({
      stageId: desc.id,
      status: "DISQUALIFIED",
      whatsappOptOut: true,
      emailOptOut: true,
    });
    expect(await db.lead.findUniqueOrThrow({ where: { phone: "5511955554444" } })).toMatchObject({ stageId: prodPerdido.id, status: "LOST" });
    expect(await db.lead.findFirstOrThrow({ where: { email: "so@email.com" } })).toMatchObject({ name: null, stageId: fila.id });
    expect(await db.lead.count({ where: { phone: "5511944443333" } })).toBe(0);

    const events = await db.leadEvent.findMany({ where: { leadId: ana.id } });
    expect(events[0].summary).toContain('antes estava em etapa "Alice aquecendo"');
    // Importing sends nothing; the queues release them on business days
    expect(await db.job.count()).toBe(0);
    // Importing the same file again creates nothing
    expect((await importLeads(csv, { pipelineId: p.id, startAi: false, actor: "Teste" })).created).toBe(0);
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

  it("the Portal de indicações drops the client in Cotações with the partner store for {{parceiro}}", async () => {
    const cot = await db.pipeline.create({ data: { name: "Cotações/ Seguros e Consórcios", slug: "parceiro-veiculos", position: 6 } });
    const novo = await db.stage.create({ data: { pipelineId: cot.id, key: "novo", name: "Novo", position: 0 } });
    // The client never wrote, so the greeting goes as the Meta template, with the store and the product in it
    await db.whatsAppTemplate.create({
      data: {
        name: "banneg_cotacao_parceiro",
        body: "Oi, {{1}}! Aqui é a {{2}}, do Banneg, somos a corretora oficial da {{3}}. Recebi seu contato para uma cotação de {{4}}, pode ser?",
        purpose: "importado",
        status: "APPROVED",
        active: true,
      },
    });
    await db.automationRule.create({
      data: {
        stageId: novo.id,
        action: "whatsapp",
        config: {
          text: "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}, somos a corretora oficial da {{parceiro}}. Recebi seu contato para uma cotação de {{produto}}, pode ser?",
          templateName: "banneg_cotacao_parceiro",
          templateParams: ["nome", "sdr", "parceiro", "produto"],
        },
      },
    });
    const post = (body: unknown, token = "portal-token") =>
      api.POST(new Request("http://x/api/leads", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    const ficha = "Seguro · Renovação indicado pela Lotus Veículos. Pedido ABC123.\n\nFicha completa no portal do Banneg: https://portal/admin/indicacoes/x";

    const res = await post({
      name: "Maria Souza",
      phone: "5541999998888",
      email: "maria@x.com",
      source: "Parceiro Lotus Veículos",
      campaign: "Portal de indicações",
      funil: "parceiro-veiculos",
      produto: "seguro auto",
      parceiro: "Lotus Veículos",
      observacao: ficha,
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const maria = await db.lead.findUniqueOrThrow({ where: { id }, include: { events: true } });
    expect(maria).toMatchObject({ pipelineId: cot.id, stageId: novo.id, source: "Parceiro Lotus Veículos", campaign: "Portal de indicações" });
    expect(maria.qualification).toMatchObject({ produto: "seguro auto", parceiro: "Lotus Veículos" });
    expect(maria.events.find((e) => e.type === "lead.form")).toMatchObject({ actor: "Parceiro Lotus Veículos", summary: ficha });

    // The stage's greeting names the partner store
    await drain();
    expect(sent.find((m) => m.to === "5541999998888")).toMatchObject({
      type: "template",
      body: "banneg_cotacao_parceiro",
      params: ["Maria", "Duda", "Lotus Veículos", "seguro auto"],
    });
    const greeting = await db.message.findFirstOrThrow({ where: { leadId: id, direction: "OUT" } });
    expect(greeting.body).toBe("Oi, Maria! Aqui é a Duda, do Banneg, somos a corretora oficial da Lotus Veículos. Recebi seu contato para uma cotação de seguro auto, pode ser?");

    // A lead in the funnel without a store: the template is not sent half empty
    const { lead: semLoja } = await leads.createLead({ name: "Zé", phone: "11955554444", source: "manual", pipelineId: cot.id }, "teste");
    await drain();
    expect(sent.some((m) => m.to === "5511955554444")).toBe(false);
    const job = await db.job.findFirstOrThrow({ where: { leadId: semLoja.id } });
    expect(job.result).toContain("usa {{parceiro}}, {{produto}} e este lead não tem");

    // Inside the 24 h window the free text goes, and it is not sent half empty either
    const ze = await db.lead.update({ where: { id: semLoja.id }, data: { lastInboundAt: new Date() } });
    expect(await jobs.runAction(ze, "whatsapp", { text: "Somos a corretora oficial da {{parceiro}}, {{nome}}." })).toBe(
      "Ignorado: a mensagem usa {{parceiro}} e este lead não tem.",
    );

    // A template edited after the rule was saved is never sent with the wrong number of variables
    await db.whatsAppTemplate.update({ where: { name: "banneg_cotacao_parceiro" }, data: { body: "Oi, {{1}}! Aqui é a {{2}}." } });
    const rule = { text: "Oi", templateName: "banneg_cotacao_parceiro", templateParams: ["nome", "sdr", "parceiro", "produto"] };
    const mariaNow = await db.lead.findUniqueOrThrow({ where: { id } });
    expect(await jobs.runAction(mariaNow, "whatsapp", rule)).toMatch(/^WhatsApp/);
    expect(sent.at(-1)).toMatchObject({ type: "template", params: ["Maria", "Duda"] });
    expect(await jobs.runAction(mariaNow, "whatsapp", { ...rule, templateParams: ["nome"] })).toBe(
      "Ignorado: o modelo banneg_cotacao_parceiro pede 2 variáveis e a automação preenche 1. Abra a automação e salve de novo.",
    );
    await db.whatsAppTemplate.update({
      where: { name: "banneg_cotacao_parceiro" },
      data: { body: "Oi, {{1}}! Aqui é a {{2}}, do Banneg, somos a corretora oficial da {{3}}. Recebi seu contato para uma cotação de {{4}}, pode ser?" },
    });

    // A client the CRM already had, open in another funnel: stays there, learns the store and the product it lacked, and the team gets a task
    const old = (await leads.createLead({ name: "Rui", phone: "11977776666", source: "site" }, "teste")).lead;
    const referral = { name: "Rui", phone: "11977776666", funil: "parceiro-veiculos", parceiro: "Garagem Sul", produto: "consórcio", observacao: "Ficha do Rui", ref: "portal:rui" };
    const first = await post(referral);
    expect(first.status).toBe(200);
    const franchiseName = (await db.pipeline.findUniqueOrThrow({ where: { id: franchise.id } })).name;
    expect(await first.json()).toMatchObject({ id: old.id, created: false, moved: false, task: true, pipeline: franchiseName });
    const rui = await db.lead.findUniqueOrThrow({ where: { id: old.id }, include: { tasks: true } });
    expect(rui.pipelineId).toBe(franchise.id);
    expect(rui.qualification).toMatchObject({ parceiro: "Garagem Sul", produto: "consórcio" });
    expect(rui.tasks.map((t) => t.title)).toEqual(["Nova indicação da Garagem Sul: cotar consórcio"]);
    // The portal sending the same referral again (it gave up waiting) changes nothing
    expect(await (await post(referral)).json()).toMatchObject({ id: old.id, created: false, repeated: true });
    expect(await db.task.count({ where: { leadId: old.id } })).toBe(1);
    expect(await db.leadEvent.count({ where: { leadId: old.id, summary: "Ficha do Rui" } })).toBe(1);
    // A second store referring him later does not rename the store his conversation is about
    await post({ ...referral, parceiro: "Auto Norte", ref: "portal:rui-2" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: old.id } })).qualification).toMatchObject({ parceiro: "Garagem Sul" });
    // The same store again after the team saw the first one: the open task rings again
    const seenAt = new Date();
    await db.lead.update({ where: { id: old.id }, data: { alertsClearedAt: seenAt } });
    await post({ ...referral, ref: "portal:rui-3" });
    const rings = await db.task.findFirstOrThrow({ where: { leadId: old.id, title: "Nova indicação da Garagem Sul: cotar consórcio" } });
    expect(rings.dueAt.getTime()).toBeGreaterThan(seenAt.getTime());

    // A client the CRM had lost starts over in Cotações with this store and product, and gets the greeting
    const perdido = await db.stage.findFirstOrThrow({ where: { pipelineId: franchise.id, key: "perdido" } });
    const ana = (await leads.createLead({ name: "Ana Lima", phone: "11966665555", source: "site", qualification: { produto: "franquia" } }, "teste")).lead;
    // Marked lost the way the team does it: AI paused, with a reason
    await leads.moveLead(ana.id, perdido.id, "teste", { aiPaused: true, lostReason: "Sem interesse", sdrId: null });
    const back = await post({ name: "Ana Lima", phone: "11966665555", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "consórcio", ref: "portal:ana" });
    expect(await back.json()).toMatchObject({ created: false, moved: true, task: true, pipeline: "Cotações/ Seguros e Consórcios", stage: "Novo" });
    const anaNow = await db.lead.findUniqueOrThrow({ where: { id: ana.id } });
    expect(anaNow).toMatchObject({ status: "NEW", aiPaused: false, lostReason: null, stageId: novo.id });
    expect(anaNow.sdrId).toBeTruthy();
    expect(anaNow.qualification).toEqual({ parceiro: "Lotus Veículos", produto: "consórcio" });
    await drain();
    expect(sent.find((m) => m.to === "5511966665555")).toMatchObject({ type: "template", params: ["Ana", "Duda", "Lotus Veículos", "consórcio"] });

    // A restart never greets with the product of an old form
    const lia = (await leads.createLead({ name: "Lia", phone: "11922221111", source: "site", qualification: { produto: "franquia" } }, "teste")).lead;
    await leads.moveLead(lia.id, perdido.id, "teste");
    await post({ name: "Lia", phone: "11922221111", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", ref: "portal:lia" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lia.id } })).qualification).toEqual({ parceiro: "Lotus Veículos" });

    // One whose WhatsApp does not arrive stays in "Erro no WhatsApp": the team fixes the number first
    const erro = await db.stage.create({ data: { pipelineId: franchise.id, key: "erro_envio", name: "Erro no WhatsApp", kind: "LOST", position: 99 } });
    const bia = (await leads.createLead({ name: "Bia", phone: "11944443333", source: "site" }, "teste")).lead;
    await leads.moveLead(bia.id, erro.id, "teste");
    expect(await (await post({ name: "Bia", phone: "11944443333", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "seguro auto" })).json()).toMatchObject({
      moved: false,
      task: true,
      stage: "Erro no WhatsApp",
    });

    // The same new number posted twice at the same moment: one lead, and neither post fails
    const twice = await Promise.all(
      ["portal:caio-1", "portal:caio-2"].map((ref) => post({ name: "Caio", phone: "11933332222", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", ref })),
    );
    expect(twice.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await db.lead.count({ where: { phone: { contains: "33332222" } } })).toBe(1);

    // Only the portal's own token, not any token
    expect((await post({ name: "X", phone: "11900001111" }, "outro")).status).toBe(401);
  });
});
