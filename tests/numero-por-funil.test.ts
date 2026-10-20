// One WhatsApp number per funnel: the referral funnel talks from Alice's number while every other funnel keeps the
// main one, and a conversation never switches number midway. Meta (fetch) and Claude are stubbed; the DB part runs
// only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { SdrDecision } from "@/lib/sdr";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";
import { buildUserTurn, type SdrContext } from "@/lib/sdr";
import { DEFAULT_SETTINGS } from "@/lib/settings";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";
process.env.PORTAL_LEADS_TOKEN = "portal-token";
// The webhook checks Meta's signature only when the app secret is set
delete process.env.WHATSAPP_APP_SECRET;

// Alice's number (017) in the same WhatsApp Business account as the main one (123)
const ALICE_NUMBER = "456";
const DAY = 86_400_000;

const nextDecision = vi.hoisted(() => ({ value: null as SdrDecision | null }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));
// The webhook hands the copy for the old CRM to after(), which only exists inside a request
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));

const reply = (text: string): SdrDecision => ({
  reply: text,
  extracted: { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null },
  score: 40,
  temperature: "morno",
  decision: "continue",
  slotIndex: null,
  reason: "respondeu",
  summary: "Pediu cotação.",
});

describe("the AI with a referral", () => {
  const turn = (qualification: Record<string, unknown>) =>
    buildUserTurn({
      agentName: "Alice",
      persona: "x",
      settings: DEFAULT_SETTINGS,
      knowledge: [],
      lead: { name: "Maria", phone: null, email: null, city: null, state: null, source: "Portal", qualification, summary: null },
      transcript: [],
      slots: [],
      now: new Date("2026-10-20T15:00:00Z"),
    } satisfies SdrContext);

  it("knows the store that referred the client and the quote it came for", () => {
    expect(turn({ parceiro: "Lotus Veículos", produto: "seguro auto" })).toContain(
      'Indicação: o lead veio pela loja parceira "Lotus Veículos" para uma cotação de seguro auto. O Banneg é a corretora oficial dessa loja',
    );
    expect(turn({ parceiro: "Lotus Veículos" })).toContain("diga que você é do Banneg, a corretora oficial da Lotus Veículos");
    // Other funnels' leads (a franchise form with a product) get nothing new
    expect(turn({ produto: "franquia" })).not.toContain("Indicação");
  });
});

describe.skipIf(!dbUrl)("WhatsApp number per funnel", () => {
  let db: typeof import("@/lib/db").db;
  let whatsapp: typeof import("@/lib/whatsapp");
  let messaging: typeof import("@/lib/messaging");
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let api: typeof import("@/app/api/leads/route");
  let webhook: typeof import("@/app/api/whatsapp/webhook/route");
  // Every call to Meta: the URL says which number it went from
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const sentFrom = () => calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.url.split("/").at(-2));
  const sends = () => calls.filter((c) => c.url.endsWith("/messages"));

  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await jobs.runDueJobs()).length === 0) break;
  };
  const post = (body: unknown) =>
    api.POST(new Request("http://x/api/leads", { method: "POST", headers: { authorization: "Bearer portal-token" }, body: JSON.stringify(body) }));
  // A message as Meta's webhook delivers it, to one of our numbers
  const inbound = (to: string, from: string, text: string, id: string, name = "Caio", at = new Date()) =>
    webhook.POST(
      new Request("http://x/api/whatsapp/webhook", {
        method: "POST",
        body: JSON.stringify({
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { phone_number_id: to, display_phone_number: to === ALICE_NUMBER ? "5517996790187" : "5511920138123" },
                    contacts: [{ profile: { name }, wa_id: from }],
                    messages: [{ from, id, timestamp: String(Math.floor(at.getTime() / 1000)), type: "text", text: { body: text } }],
                  },
                },
              ],
            },
          ],
        }),
      }),
    );

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    whatsapp = await import("@/lib/whatsapp");
    messaging = await import("@/lib/messaging");
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    api = await import("@/app/api/leads/route");
    webhook = await import("@/app/api/whatsapp/webhook/route");
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: unknown }) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/media")) return Response.json({ id: `up-${calls.length}` });
      if (url.endsWith("/messages")) return Response.json({ messages: [{ id: `wamid.${calls.length}.${Date.now()}` }] });
      throw new Error(`unexpected ${url}`);
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    await db.user.create({ data: { name: "Gerente", email: "g@banneg.com.br", role: "MANAGER", passwordHash: "x" } });
    nextDecision.value = reply("Oi! Aqui é a Alice, do Banneg. Me conta: qual é o carro?");
  });

  const newLead = async (data: Partial<Prisma.LeadUncheckedCreateInput> = {}) => {
    const pipeline = await db.pipeline.findFirstOrThrow({ where: { isDefault: true }, include: { stages: true } });
    return db.lead.create({ data: { name: "Maria Souza", phone: "5541999998888", pipelineId: pipeline.id, stageId: pipeline.stages[0].id, ...data } });
  };

  // The portal's funnel ("Cotações") on Alice's number with Alice as its SDR; Novo greets the client with the Meta template
  async function referralFunnel(opts: { delayMinutes?: number } = {}) {
    const alice = await db.sdrAgent.create({ data: { name: "Alice", persona: "x" } });
    const cot = await db.pipeline.create({
      data: { name: "Cotações/ Seguros e Consórcios", slug: "parceiro-veiculos", position: 6, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id },
    });
    const novo = await db.stage.create({ data: { pipelineId: cot.id, key: "novo", name: "Novo", position: 0 } });
    await db.whatsAppTemplate.create({
      data: {
        name: "banneg_cotacao_parceiro",
        body: "Oi, {{1}}! Aqui é a {{2}}, do Banneg, somos a corretora oficial da {{3}}. Recebi seu contato para uma cotação de {{4}}, pode ser?",
        purpose: "importado",
      },
    });
    await db.automationRule.create({
      data: {
        stageId: novo.id,
        action: "whatsapp",
        delayMinutes: opts.delayMinutes ?? 0,
        config: {
          text: "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}, somos a corretora oficial da {{parceiro}}. Recebi seu contato para uma cotação de {{produto}}, pode ser?",
          templateName: "banneg_cotacao_parceiro",
          templateParams: ["nome", "sdr", "parceiro", "produto"],
        },
      },
    });
    const duda = await db.sdrAgent.findUniqueOrThrow({ where: { name: "Duda" } });
    return { alice, duda, cot, novo };
  }

  it("sends from the lead's number, and from the main one when the lead has none", async () => {
    const onMain = await newLead({ lastInboundAt: new Date() });
    const onAlice = await newLead({ phone: "5541999997777", whatsappNumberId: ALICE_NUMBER, lastInboundAt: new Date() });
    await messaging.sendWhatsApp(onMain, "Oi!", "Duda");
    await messaging.sendWhatsApp(onAlice, "Oi!", "Alice");
    await messaging.sendWhatsApp(onAlice, "Escolha", "Alice", { buttons: ["Sim", "Não"] });
    expect(sentFrom()).toEqual(["123", ALICE_NUMBER, ALICE_NUMBER]);

    // Outside the 24 h window the template goes from the lead's number too
    calls.length = 0;
    await db.whatsAppTemplate.create({ data: { name: "retomada", body: "Oi, {{1}}!", purpose: "reengagement" } });
    await messaging.sendWhatsApp({ ...onAlice, lastInboundAt: null }, "Oi!", "Alice", "reengagement");
    expect(calls).toMatchObject([{ url: `https://graph.facebook.com/v21.0/${ALICE_NUMBER}/messages`, body: { type: "template" } }]);

    // The helpers without a number keep the main one (the integration test message)
    calls.length = 0;
    await whatsapp.sendText("5541999998888", "teste");
    await whatsapp.sendTemplate("5541999998888", "retomada", "pt_BR", ["teste"], null, ALICE_NUMBER);
    expect(sentFrom()).toEqual(["123", ALICE_NUMBER]);
  });

  it("uploads an audio on the number that sends it", async () => {
    const lead = await newLead({ whatsappNumberId: ALICE_NUMBER, lastInboundAt: new Date() });
    const res = await messaging.sendAudioMessage(lead, new Uint8Array([1, 2, 3]), "audio/ogg", "Alice");
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.url.split("/").slice(-2).join("/"))).toEqual([`${ALICE_NUMBER}/media`, `${ALICE_NUMBER}/messages`]);
    expect(calls[1].body).toMatchObject({ type: "audio", audio: { id: "up-1" } });
  });

  it("a lead created in a funnel starts on its number with its SDR; the other funnels keep the main number and the round robin", async () => {
    const { alice, duda, cot } = await referralFunnel();
    const { lead: maria } = await leads.createLead({ name: "Maria", phone: "41999998888", source: "Portal", pipelineId: cot.id }, "teste");
    expect(maria).toMatchObject({ whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    await leads.createLead({ name: "Rui", phone: "41999997777", source: "Portal", pipelineId: cot.id }, "teste");

    const { lead: ze } = await leads.createLead({ name: "Zé", phone: "11955554444", source: "site" }, "teste");
    expect(ze.whatsappNumberId).toBeNull();
    await db.lead.update({ where: { id: ze.id }, data: { sdrId: duda.id } });
    // Alice's referral leads do not count in the round robin: the next lead elsewhere is hers
    const { lead: lia } = await leads.createLead({ name: "Lia", phone: "11922221111", source: "site" }, "teste");
    expect(lia).toMatchObject({ whatsappNumberId: null, sdrId: alice.id });

    // With the funnel's SDR switched off, the round robin takes over; the number stays the funnel's
    await db.sdrAgent.update({ where: { id: alice.id }, data: { active: false } });
    const { lead: bia } = await leads.createLead({ name: "Bia", phone: "41999996666", source: "Portal", pipelineId: cot.id }, "teste");
    expect(bia).toMatchObject({ whatsappNumberId: ALICE_NUMBER, sdrId: duda.id });
  });

  it("the store's referral is greeted from Alice's number, signed by Alice", async () => {
    const { alice, cot } = await referralFunnel();
    const res = await post({
      name: "Maria Souza",
      phone: "5541999998888",
      source: "Parceiro Lotus Veículos",
      funil: "parceiro-veiculos",
      produto: "seguro auto",
      parceiro: "Lotus Veículos",
      ref: "portal:maria",
    });
    expect(res.status).toBe(201);
    const maria = await db.lead.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(maria).toMatchObject({ pipelineId: cot.id, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    await drain();
    expect(sends()).toHaveLength(1);
    expect(sends()[0].url).toBe(`https://graph.facebook.com/v21.0/${ALICE_NUMBER}/messages`);
    expect(sends()[0].body).toMatchObject({
      to: "5541999998888",
      type: "template",
      template: {
        name: "banneg_cotacao_parceiro",
        components: [{ type: "body", parameters: [{ text: "Maria" }, { text: "Alice" }, { text: "Lotus Veículos" }, { text: "seguro auto" }] }],
      },
    });
  });

  it("a lost client the store refers again starts over on the funnel's number, unless it is talking on the main one", async () => {
    const { alice, duda, cot } = await referralFunnel();
    const perdido = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "perdido" } });
    // Talked to Duda on the main number last month, then was lost
    const ana = await newLead({ name: "Ana Lima", phone: "5511966665555", stageId: perdido.id, status: "LOST", sdrId: duda.id, lastInboundAt: new Date(Date.now() - 30 * DAY) });
    await db.message.create({ data: { leadId: ana.id, channel: "WHATSAPP", direction: "IN", body: "Agora não", author: "Ana", status: "RECEIVED" } });
    const back = await post({ name: "Ana Lima", phone: "11966665555", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "consórcio", ref: "portal:ana" });
    expect(await back.json()).toMatchObject({ moved: true });
    expect(await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).toMatchObject({ pipelineId: cot.id, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "template"]]);

    // Wrote to the main number an hour ago: only that number can answer it for free, so the conversation stays there with Duda
    calls.length = 0;
    const bia = await newLead({ name: "Bia", phone: "5511944443333", stageId: perdido.id, status: "LOST", sdrId: duda.id, lastInboundAt: new Date(Date.now() - 3600_000) });
    await db.message.create({ data: { leadId: bia.id, channel: "WHATSAPP", direction: "IN", body: "Oi", author: "Bia", status: "RECEIVED" } });
    await post({ name: "Bia", phone: "11944443333", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "seguro auto", ref: "portal:bia" });
    expect(await db.lead.findUniqueOrThrow({ where: { id: bia.id } })).toMatchObject({ pipelineId: cot.id, whatsappNumberId: null, sdrId: duda.id });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([["123", "text"]]);
  });

  it("a lead moved into the funnel takes its number only if nobody wrote on WhatsApp yet", async () => {
    const { alice, duda, novo } = await referralFunnel();
    const expansao = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "novo" } });
    const fresh = await newLead({ phone: "5511900000001" });
    const talking = await newLead({ phone: "5511900000002", sdrId: duda.id });
    await db.message.create({ data: { leadId: talking.id, channel: "WHATSAPP", direction: "IN", body: "Oi", author: "Lead", status: "RECEIVED" } });

    expect(await leads.moveLead(fresh.id, novo.id, "teste")).toMatchObject({ whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    expect(await leads.moveLead(talking.id, novo.id, "teste")).toMatchObject({ whatsappNumberId: null, sdrId: duda.id });
    // Still no message: back in a funnel without its own number, it goes back to the main one
    expect(await leads.moveLead(fresh.id, expansao.id, "teste")).toMatchObject({ whatsappNumberId: null, sdrId: alice.id });
    // A move inside the funnel changes nothing
    const other = await db.stage.create({ data: { pipelineId: novo.pipelineId, key: "qualificando", name: "Em conversa", position: 1 } });
    await db.lead.update({ where: { id: talking.id }, data: { whatsappNumberId: ALICE_NUMBER } });
    expect(await leads.moveLead(talking.id, other.id, "teste")).toMatchObject({ whatsappNumberId: ALICE_NUMBER });
  });

  it("we answer where the person writes: a lead writing to the other number moves its conversation there", async () => {
    const { duda } = await referralFunnel();
    const lead = await newLead({ phone: "5511933332222", whatsappNumberId: ALICE_NUMBER, sdrId: duda.id, status: "AI_QUALIFYING" });

    expect((await inbound("123", "5511933332222", "Oi", "wamid.in1")).status).toBe(200);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).whatsappNumberId).toBeNull();
    expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "whatsapp.number_changed" } })).toMatchObject({
      summary: "O lead escreveu para o número principal: a conversa segue por ele.",
    });
    await drain();
    expect(sentFrom()).toEqual(["123"]);

    // Back to Alice's number, named as the account lists it
    await db.setting.create({
      data: { key: "whatsapp_numbers", value: { at: new Date().toISOString(), numbers: [{ id: ALICE_NUMBER, display: "+55 17 99679-0187", name: "Alice Banneg", quality: "GREEN" }] } },
    });
    calls.length = 0;
    await inbound(ALICE_NUMBER, "5511933332222", "Oi de novo", "wamid.in2");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).whatsappNumberId).toBe(ALICE_NUMBER);
    expect(await db.leadEvent.count({ where: { leadId: lead.id, summary: { contains: "+55 17 99679-0187" } } })).toBe(1);
    await drain();
    expect(sentFrom()).toEqual([ALICE_NUMBER]);

    // A caller that does not say the number keeps the one the lead is on
    await leads.handleInbound({ phone: "5511933332222", body: "Ainda aí?", externalId: "wamid.in3", at: new Date() });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).whatsappNumberId).toBe(ALICE_NUMBER);
  });

  it("someone writing to a funnel's number for the first time starts in that funnel, with its SDR", async () => {
    const { alice, cot } = await referralFunnel();
    await inbound(ALICE_NUMBER, "5511933332222", "Oi, Alice! Sou Caio, vim pela Lotus Veículos para a cotação de seguro auto.", "wamid.in1");
    const caio = await db.lead.findUniqueOrThrow({ where: { phone: "5511933332222" } });
    expect(caio).toMatchObject({ name: "Caio", source: "whatsapp", pipelineId: cot.id, sdrId: alice.id, whatsappNumberId: ALICE_NUMBER });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);

    // The main number and a number no funnel uses: the default funnel, answered from where they wrote
    const franchise = await db.pipeline.findFirstOrThrow({ where: { isDefault: true } });
    await inbound("123", "5511922221111", "Oi", "wamid.in2", "Lia");
    expect(await db.lead.findUniqueOrThrow({ where: { phone: "5511922221111" } })).toMatchObject({ pipelineId: franchise.id, whatsappNumberId: null });
    await inbound("789", "5511911112222", "Oi", "wamid.in3", "Gil");
    expect(await db.lead.findUniqueOrThrow({ where: { phone: "5511911112222" } })).toMatchObject({ pipelineId: franchise.id, whatsappNumberId: "789" });
  });

  it("imports into the funnel with its number and SDR", async () => {
    const { alice, duda, cot } = await referralFunnel();
    const { importLeads } = await import("@/lib/import");
    const franchise = await db.pipeline.findFirstOrThrow({ where: { isDefault: true } });
    const csv = ["nome;telefone;funil", "Ana;11977776666;parceiro-veiculos", "Rui;11966665555;"].join("\n");
    expect((await importLeads(csv, { pipelineId: franchise.id, startAi: false, actor: "Teste" })).created).toBe(2);
    expect(await db.lead.findUniqueOrThrow({ where: { phone: "5511977776666" } })).toMatchObject({ pipelineId: cot.id, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    // The rest of the file keeps the round robin
    const rui = await db.lead.findUniqueOrThrow({ where: { phone: "5511966665555" } });
    expect(rui).toMatchObject({ pipelineId: franchise.id, whatsappNumberId: null });
    expect([alice.id, duda.id]).toContain(rui.sdrId);
  });

  it("a lead without an SDR is named and handed to the funnel's own SDR", async () => {
    const { alice } = await referralFunnel();
    const { lead } = await leads.createLead({ name: "Gil", phone: "11911112222", source: "Portal", pipelineId: (await db.pipeline.findUniqueOrThrow({ where: { slug: "parceiro-veiculos" } })).id, qualification: { parceiro: "Lotus Veículos", produto: "seguro auto" } }, "teste");
    const noSdr = await db.lead.update({ where: { id: lead.id }, data: { sdrId: null } });
    const rule = { text: "Oi", templateName: "banneg_cotacao_parceiro", templateParams: ["nome", "sdr", "parceiro", "produto"] };
    expect(await jobs.runAction(noSdr, "whatsapp", rule)).toMatch(/^WhatsApp/);
    expect(sends().at(-1)?.body).toMatchObject({ template: { components: [{ parameters: [{ text: "Gil" }, { text: "Alice" }, {}, {}] }] } });
    expect(await jobs.runAction(noSdr, "ai_on", {})).toBe("IA ativada; primeiro contato a caminho.");
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).sdrId).toBe(alice.id);
  });

  // The store shows the client a QR code to write to Alice; the paid greeting only goes if the client does not write
  it("the greeting waits 15 minutes and does not go when the client wrote first", async () => {
    await referralFunnel({ delayMinutes: 15 });
    const referral = { funil: "parceiro-veiculos", produto: "seguro auto", parceiro: "Lotus Veículos" };
    const maria = await (await post({ ...referral, name: "Maria Souza", phone: "5541999998888", ref: "portal:maria" })).json();
    const greeting = await db.job.findFirstOrThrow({ where: { leadId: maria.id, type: "rule.run" } });
    expect(greeting.runAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

    // A few seconds later, still in the store, she sends the ready message to Alice's number
    await inbound(ALICE_NUMBER, "5541999998888", "Oi, Alice! Sou Maria, vim pela Lotus Veículos para a cotação de seguro auto.", "wamid.in1", "Maria", new Date(Date.now() + 5000));
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    await drain();
    // Alice answers for free inside the window Maria opened, knowing the store and the product
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);
    expect(buildUserTurn(vi.mocked(runSdrTurn).mock.calls[0][0])).toContain("O Banneg é a corretora oficial dessa loja");

    // Fifteen minutes later the greeting has nothing to do
    await db.job.update({ where: { id: greeting.id }, data: { runAt: new Date() } });
    await drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: greeting.id } })).toMatchObject({ status: "DONE", result: "Ignorado: o lead já escreveu." });
    expect(sends()).toHaveLength(1);

    // A client who left without writing gets the approved template from Alice's number
    calls.length = 0;
    const rui = await (await post({ ...referral, name: "Rui", phone: "5541999997777", ref: "portal:rui" })).json();
    await db.job.updateMany({ where: { leadId: rui.id, type: "rule.run" }, data: { runAt: new Date() } });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "template"]]);
  });

  it("a client who writes to Alice before any referral never gets the greeting", async () => {
    await referralFunnel({ delayMinutes: 15 });
    await inbound(ALICE_NUMBER, "5511933332222", "Oi, Alice! Quero cotar um seguro.", "wamid.in1");
    const caio = await db.lead.findUniqueOrThrow({ where: { phone: "5511933332222" } });
    expect(await db.job.findFirstOrThrow({ where: { leadId: caio.id, type: "rule.run" } })).toMatchObject({
      status: "CANCELLED",
      result: "Cancelado: o lead escreveu primeiro.",
    });
  });

  it("other delayed WhatsApp automations still go after the lead writes", async () => {
    const duda = await db.sdrAgent.findUniqueOrThrow({ where: { name: "Duda" } });
    const perdido = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "perdido" } });
    const lead = await newLead({ sdrId: duda.id });
    await leads.moveLead(lead.id, perdido.id, "teste");
    // Writes while lost: the 90-day reactivation still goes (the window is open, so as plain text)
    await leads.handleInbound({ phone: "5541999998888", body: "Oi", externalId: "wamid.in1", at: new Date(Date.now() + 5000) });
    const rule = await db.automationRule.findFirstOrThrow({ where: { stageId: perdido.id, action: "whatsapp" } });
    const job = await db.job.findFirstOrThrow({ where: { leadId: lead.id, payload: { path: ["ruleId"], equals: rule.id } } });
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    await drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).result).toBe("WhatsApp enviado.");
  });
});
