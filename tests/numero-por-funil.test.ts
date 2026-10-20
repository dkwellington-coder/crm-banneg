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
const sentEmails = vi.hoisted(() => [] as { to: string; body: string; html?: string }[]);
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (to: string, _subject: string, body: string, _a: unknown, html?: string) => {
    sentEmails.push({ to, body, html });
    return "id";
  }),
}));

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
  const COTACOES = "pipeline-cotacoes";
  const turn = (qualification: Record<string, unknown>, funnelId = COTACOES) =>
    buildUserTurn({
      agentName: "Alice",
      persona: "x",
      settings: DEFAULT_SETTINGS,
      funnel: { id: funnelId, name: funnelId === COTACOES ? "Cotações" : "Expansão", goal: null, questions: [] },
      knowledge: [],
      lead: { name: "Maria", phone: null, email: null, city: null, state: null, source: "Portal", qualification, summary: null },
      transcript: [],
      slots: [],
      now: new Date("2026-10-20T15:00:00Z"),
    } satisfies SdrContext);

  it("knows the store that referred the client and the quote it came for", () => {
    const referred = turn({ parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: COTACOES });
    expect(referred).toContain(
      'Indicação: o lead veio pela loja parceira "Lotus Veículos" para uma cotação de seguro auto. O Banneg é a corretora oficial dessa loja',
    );
    // The funnel's id is the CRM's business, not the conversation's
    expect(referred).not.toContain(COTACOES);
    expect(turn({ parceiro: "Lotus Veículos", parceiroFunil: COTACOES })).toContain("diga que você é do Banneg, a corretora oficial da Lotus Veículos");
    // Other funnels' leads (a franchise form with a product) get nothing new
    expect(turn({ produto: "franquia" })).not.toContain("Indicação");
  });

  it("speaks for the store only in the funnel the store referred the lead to", () => {
    // Caio was qualifying for a franchise when a store referred him: he stays in Expansão and a person decides,
    // so the franchise SDR does not turn the conversation into the store's quote
    expect(turn({ parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: COTACOES }, "pipeline-expansao")).not.toContain("Indicação");
    // A store's referral from before the CRM kept the funnel: as before, only data
    expect(turn({ parceiro: "Lotus Veículos", produto: "seguro auto" })).not.toContain("Indicação");
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
  // Meta's answers to reads (the account's numbers, a number's name), set by each test
  let metaGet: (url: string) => Response | undefined = () => undefined;
  // Meta's answer to a send, when a test wants an error
  let metaSend: (url: string) => Response | undefined = () => undefined;

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
      if (url.endsWith("/messages")) return metaSend(url) ?? Response.json({ messages: [{ id: `wamid.${calls.length}.${Date.now()}` }] });
      const got = metaGet(url);
      if (got) return got;
      throw new Error(`unexpected ${url}`);
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    sentEmails.length = 0;
    metaGet = () => undefined;
    metaSend = () => undefined;
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
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

    // Her message cancelled the greeting; one that still ran fifteen minutes later would have nothing to do
    expect(await db.job.findUniqueOrThrow({ where: { id: greeting.id } })).toMatchObject({ status: "CANCELLED", result: "Cancelado: o lead escreveu primeiro." });
    await db.job.update({ where: { id: greeting.id }, data: { status: "PENDING", runAt: new Date() } });
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

  it("the greeting does not go when the client's message is older than the referral that scheduled it", async () => {
    await referralFunnel({ delayMinutes: 15 });
    // She pressed send while the CRM was still taking the store's referral: Meta's time of her message comes before it
    const pressedSend = new Date(Date.now() - 2000);
    const maria = await (
      await post({ name: "Maria Souza", phone: "5541999998888", funil: "parceiro-veiculos", produto: "seguro auto", parceiro: "Lotus Veículos", ref: "portal:maria" })
    ).json();
    await inbound(ALICE_NUMBER, "5541999998888", "Oi, Alice! Sou Maria, vim pela Lotus Veículos para a cotação de seguro auto.", "wamid.in1", "Maria", pressedSend);
    expect(await db.job.findFirstOrThrow({ where: { leadId: maria.id, type: "rule.run" } })).toMatchObject({
      status: "CANCELLED",
      result: "Cancelado: o lead escreveu primeiro.",
    });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);
  });

  it("a lost client who wrote to Alice before the store's referral got here is answered by Alice right away, not greeted later", async () => {
    const { alice, duda, cot } = await referralFunnel({ delayMinutes: 15 });
    const perdido = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "perdido" } });
    const ana = await newLead({ name: "Ana Lima", phone: "5511966665555", stageId: perdido.id, status: "LOST", sdrId: duda.id });
    // Still lost when she sends the store's ready message: a task for the team, no AI
    await inbound(ALICE_NUMBER, "5511966665555", "Oi, Alice! Sou Ana, vim pela Lotus Veículos para a cotação de consórcio.", "wamid.in1", "Ana");
    expect(await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).toMatchObject({ whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    await drain();
    expect(sends()).toHaveLength(0);

    // The referral arrives later (the portal sent it again): the lead starts over and the AI answers the waiting message
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    const back = await post({ name: "Ana Lima", phone: "11966665555", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "consórcio", ref: "portal:ana" });
    expect(await back.json()).toMatchObject({ moved: true });
    expect(await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).toMatchObject({ pipelineId: cot.id, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    expect(await db.job.findFirstOrThrow({ where: { leadId: ana.id, type: "rule.run" } })).toMatchObject({ status: "CANCELLED" });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);
    const ctx = vi.mocked(runSdrTurn).mock.calls[0][0];
    expect(ctx.agentName).toBe("Alice");
    expect(buildUserTurn(ctx)).toContain("O Banneg é a corretora oficial dessa loja");
  });

  it("a client the store sent to Alice is answered by Alice on her number, whatever SDR it had on the main one", async () => {
    const { alice, duda, cot } = await referralFunnel({ delayMinutes: 15 });
    const perdido = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "perdido" } });
    // Lost with Duda, talked on the main number an hour ago: the referral keeps the conversation there
    const hourAgo = new Date(Date.now() - 3600_000);
    const bia = await newLead({ name: "Bia", phone: "5511944443333", stageId: perdido.id, status: "LOST", sdrId: duda.id, lastInboundAt: hourAgo });
    await db.message.create({ data: { leadId: bia.id, channel: "WHATSAPP", direction: "IN", body: "Agora não", author: "Bia", status: "RECEIVED", createdAt: hourAgo } });
    await db.message.create({ data: { leadId: bia.id, channel: "WHATSAPP", direction: "OUT", body: "Tudo bem!", author: "Duda", status: "SENT" } });
    await post({ name: "Bia", phone: "11944443333", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "seguro auto", ref: "portal:bia" });
    expect(await db.lead.findUniqueOrThrow({ where: { id: bia.id } })).toMatchObject({ pipelineId: cot.id, whatsappNumberId: null, sdrId: duda.id });

    // She scans the store's QR code and greets Alice on Alice's number
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    await inbound(ALICE_NUMBER, "5511944443333", "Oi, Alice! Sou Bia, vim pela Lotus Veículos para a cotação de seguro auto.", "wamid.in1", "Bia");
    expect(await db.lead.findUniqueOrThrow({ where: { id: bia.id } })).toMatchObject({ whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    expect((await db.leadEvent.findFirstOrThrow({ where: { leadId: bia.id, type: "whatsapp.number_changed" } })).summary).toMatch(/, com a Alice\.$/);
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);
    expect(vi.mocked(runSdrTurn).mock.calls[0][0].agentName).toBe("Alice");

    // Writing back to the main number keeps her SDR: that number has no SDR of its own
    await inbound("123", "5511944443333", "Oi", "wamid.in2", "Bia");
    expect(await db.lead.findUniqueOrThrow({ where: { id: bia.id } })).toMatchObject({ whatsappNumberId: null, sdrId: alice.id });
  });

  it("a client who writes from another phone with the referral's code is that referral's lead", async () => {
    await referralFunnel({ delayMinutes: 15 });
    const referral = { funil: "parceiro-veiculos", produto: "seguro auto", parceiro: "Lotus Veículos" };
    // The store typed one phone; the portal's id ends in the code of the ready message
    const maria = await (await post({ ...referral, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" })).json();
    await inbound(ALICE_NUMBER, "5541988887777", "Oi, Alice! Sou Maria, vim pela Lotus Veículos para a cotação de seguro auto. Pedido ABC123", "wamid.in1", "Maria");
    expect(await db.lead.count()).toBe(1);
    expect(await db.lead.findUniqueOrThrow({ where: { id: maria.id } })).toMatchObject({ phone: "5541988887777", whatsappNumberId: ALICE_NUMBER });
    expect((await db.leadEvent.findFirstOrThrow({ where: { leadId: maria.id, type: "lead.phone_changed" } })).summary).toContain("5541999998888 → 5541988887777");
    // She wrote first: the paid greeting does not go, Alice answers on the phone she wrote from
    expect(await db.job.findFirstOrThrow({ where: { leadId: maria.id, type: "rule.run" } })).toMatchObject({ status: "CANCELLED" });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.to])).toEqual([[ALICE_NUMBER, "5541988887777"]]);

    // Once the referral's lead has written, the code does not take it to yet another phone
    await inbound(ALICE_NUMBER, "5541977776666", "Oi! Pedido abc123", "wamid.in2", "Outro");
    expect((await db.lead.findUniqueOrThrow({ where: { id: maria.id } })).phone).toBe("5541988887777");
    expect(await db.lead.count({ where: { phone: "5541977776666" } })).toBe(1);
  });

  // The ready message the store's QR code fills in, with the referral's code (the end of the portal's id)
  const ready = (name: string, code = "ABC123") => `Oi, Alice! Sou ${name}, vim pela Lotus Veículos para a cotação de seguro auto. Pedido ${code}`;
  const quote = { funil: "parceiro-veiculos", produto: "seguro auto", parceiro: "Lotus Veículos" };

  it("a client who writes with the code from a phone the CRM already had takes the referral there, and the typed phone gets nothing", async () => {
    const { alice, duda, cot } = await referralFunnel({ delayMinutes: 15 });
    const perdido = await db.stage.create({ data: { pipelineId: cot.id, key: "perdido", name: "Perdido", kind: "LOST", position: 9 } });
    // Maria's own phone is an old lead waiting in the franchise queue, with Duda; the store typed another phone
    const franchise = await db.pipeline.findFirstOrThrow({ where: { isDefault: true } });
    const fila = await db.stage.create({ data: { pipelineId: franchise.id, key: "fila", name: "Na fila", position: 50 } });
    const old = await newLead({ name: "Maria S.", phone: "5541988887777", stageId: fila.id, sdrId: duda.id });
    const ref = await (
      await post({ ...quote, name: "Maria Souza", phone: "5541999998888", email: "maria@x.com", observacao: "Ficha da Maria", ref: "portal:cm9x7k2abc123" })
    ).json();
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();

    await inbound(ALICE_NUMBER, "5541988887777", ready("Maria"), "wamid.in1", "Maria");
    // The referral goes on in her lead: back in Cotações with the store and product, on Alice's number with Alice
    const maria = await db.lead.findUniqueOrThrow({ where: { id: old.id } });
    expect(maria).toMatchObject({ pipelineId: cot.id, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id, email: "maria@x.com" });
    expect(maria.qualification).toMatchObject({ parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: cot.id });
    expect(await db.leadEvent.count({ where: { leadId: old.id, type: "lead.form", summary: "Ficha da Maria" } })).toBe(1);
    expect(await db.task.count({ where: { leadId: old.id, title: "Nova indicação da Lotus Veículos: cotar seguro auto" } })).toBe(1);
    // The lead the referral made with the typed phone closes as a duplicate: nothing waits for it
    expect(await db.lead.findUniqueOrThrow({ where: { id: ref.id } })).toMatchObject({ phone: "5541999998888", stageId: perdido.id, aiPaused: true });
    expect(await db.job.count({ where: { leadId: ref.id, status: "PENDING" } })).toBe(0);
    expect(await db.job.count({ where: { leadId: old.id, type: "rule.run", status: "PENDING" } })).toBe(0);

    // Alice answers her on the phone she wrote from, knowing the store
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.to, c.body?.type])).toEqual([[ALICE_NUMBER, "5541988887777", "text"]]);
    const ctx = vi.mocked(runSdrTurn).mock.calls[0][0];
    expect(ctx).toMatchObject({ agentName: "Alice", funnel: { name: "Cotações/ Seguros e Consórcios" } });
    expect(buildUserTurn(ctx)).toContain("O Banneg é a corretora oficial dessa loja");
  });

  it("a phone that already holds a referral writing another referral's code goes to the team, and that referral still greets its client", async () => {
    await referralFunnel({ delayMinutes: 15 });
    // The store's own phone sent Maria's ready message, so Maria's referral is on the store's phone now
    const maria = await (await post({ ...quote, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" })).json();
    await inbound(ALICE_NUMBER, "5541933334444", ready("Maria"), "wamid.in1", "Loja");
    await drain();
    // Then it sends the next client's
    const joao = await (await post({ ...quote, name: "João Lima", phone: "5541977776666", ref: "portal:cm9x7k2zzz999" })).json();
    calls.length = 0;
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    await inbound(ALICE_NUMBER, "5541933334444", ready("João", "ZZZ999"), "wamid.in2", "Loja");
    await drain();
    // Nobody answers it as Maria's conversation: a person sorts out who is writing
    expect(sends()).toHaveLength(0);
    expect(vi.mocked(runSdrTurn)).not.toHaveBeenCalled();
    expect(await db.task.count({ where: { leadId: maria.id, title: "Conferir quem escreveu: veio o pedido ZZZ999, da indicação de João Lima" } })).toBe(1);
    // João's referral still waits for him on the phone the store typed, and greets him there
    expect(await db.lead.findUniqueOrThrow({ where: { id: joao.id } })).toMatchObject({ phone: "5541977776666", lastInboundAt: null });
    await db.job.updateMany({ where: { leadId: joao.id, type: "rule.run", status: "PENDING" }, data: { runAt: new Date() } });
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.to, c.body?.type])).toEqual([[ALICE_NUMBER, "5541977776666", "template"]]);
  });

  it("someone else the CRM knows sending a client's code never takes that client's referral", async () => {
    const { cot } = await referralFunnel({ delayMinutes: 15 });
    const duda = await db.sdrAgent.findUniqueOrThrow({ where: { name: "Duda" } });
    // The store's owner was a franchise lead once; he scans Maria's QR code himself
    const carlos = await newLead({ name: "Carlos Lotus", phone: "5541955554444", sdrId: duda.id, status: "AI_QUALIFYING" });
    const maria = await (await post({ ...quote, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" })).json();
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    await inbound(ALICE_NUMBER, "5541955554444", ready("Maria"), "wamid.in1", "Carlos");
    await drain();
    // His lead stays his, a person sorts it out, and Maria's referral still greets her on the phone the store typed
    expect(vi.mocked(runSdrTurn)).not.toHaveBeenCalled();
    expect(await db.lead.findUniqueOrThrow({ where: { id: carlos.id } })).toMatchObject({ qualification: {}, stageId: carlos.stageId });
    expect(await db.task.count({ where: { leadId: carlos.id, title: "Conferir quem escreveu: veio o pedido ABC123, da indicação de Maria Souza" } })).toBe(1);
    expect(await db.lead.findUniqueOrThrow({ where: { id: maria.id } })).toMatchObject({ phone: "5541999998888", pipelineId: cot.id, aiPaused: false });
    await db.job.updateMany({ where: { leadId: maria.id, type: "rule.run", status: "PENDING" }, data: { runAt: new Date() } });
    calls.length = 0;
    await drain();
    expect(sends().map((c) => [c.body?.to, c.body?.type])).toEqual([["5541999998888", "template"]]);

    // The same before the referral got here: it makes its own lead with the phone the store typed
    await inbound(ALICE_NUMBER, "5541955554444", ready("João", "ZZZ999"), "wamid.in2", "Carlos");
    const joao = await post({ ...quote, name: "João Lima", phone: "5541977776666", ref: "portal:cm9x7k2zzz999" });
    expect(await joao.json()).toMatchObject({ created: true });
    expect(await db.lead.findFirstOrThrow({ where: { externalId: "portal:cm9x7k2zzz999" } })).toMatchObject({ phone: "5541977776666" });
    expect(await db.lead.findUniqueOrThrow({ where: { id: carlos.id } })).toMatchObject({ qualification: {} });
  });

  it("a referral that arrives after its client wrote with the code is that conversation: no task, and its data is kept", async () => {
    const { alice, cot } = await referralFunnel({ delayMinutes: 15 });
    // The CRM was slow: the store showed the QR code and Maria wrote before the referral got here
    await inbound(ALICE_NUMBER, "5541999998888", ready("Maria"), "wamid.in1", "Mah");
    await drain();
    const referral = {
      ...quote,
      name: "Maria Souza",
      phone: "5541999998888",
      email: "maria@x.com",
      cidade: "Curitiba",
      estado: "PR",
      source: "Parceiro Lotus Veículos",
      campaign: "Portal de indicações",
      observacao: "Ficha da Maria",
      ref: "portal:cm9x7k2abc123",
    };
    const res = await post(referral);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: true, moved: false, task: false, pipeline: "Cotações/ Seguros e Consórcios", stage: "Novo" });
    expect(await db.lead.count()).toBe(1);
    const maria = await db.lead.findFirstOrThrow({ include: { tasks: true } });
    expect(maria).toMatchObject({
      name: "Maria Souza",
      email: "maria@x.com",
      city: "Curitiba",
      state: "PR",
      source: "Parceiro Lotus Veículos",
      campaign: "Portal de indicações",
      externalId: "portal:cm9x7k2abc123",
      pipelineId: cot.id,
      sdrId: alice.id,
      whatsappNumberId: ALICE_NUMBER,
    });
    expect(maria.qualification).toMatchObject({ parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: cot.id });
    expect(maria.tasks).toEqual([]);
    expect(await db.leadEvent.count({ where: { leadId: maria.id, type: "lead.duplicate" } })).toBe(0);
    expect(await db.leadEvent.count({ where: { leadId: maria.id, type: "lead.form", summary: "Ficha da Maria" } })).toBe(1);
    // Nothing else goes out: Alice already answered her, and no greeting waits
    calls.length = 0;
    await db.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date() } });
    await drain();
    expect(sends()).toHaveLength(0);
    // The portal sending it again finds the same lead
    expect(await (await post(referral)).json()).toMatchObject({ id: maria.id, repeated: true });
  });

  it("a client who wrote from another phone before the referral arrived stays one lead, and the typed phone is never greeted", async () => {
    const { cot } = await referralFunnel({ delayMinutes: 15 });
    await inbound(ALICE_NUMBER, "5541988887777", ready("Maria"), "wamid.in1", "Maria");
    await drain();
    calls.length = 0;
    const res = await post({ ...quote, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" });
    expect(await res.json()).toMatchObject({ created: true, task: false });
    expect(await db.lead.count()).toBe(1);
    const maria = await db.lead.findFirstOrThrow();
    expect(maria).toMatchObject({ phone: "5541988887777", externalId: "portal:cm9x7k2abc123", pipelineId: cot.id });
    expect((await db.leadEvent.findFirstOrThrow({ where: { leadId: maria.id, type: "lead.referral_joined" } })).summary).toContain(
      "A loja informou o número 5541999998888; o cliente escreveu de 5541988887777.",
    );
    await db.job.updateMany({ where: { status: "PENDING" }, data: { runAt: new Date() } });
    await drain();
    expect(sends()).toHaveLength(0);
  });

  it("a client who wrote first to a number no funnel used yet goes to the referral's funnel when it arrives, and the AI answers", async () => {
    const { alice, cot } = await referralFunnel({ delayMinutes: 15 });
    // Cotações still on the main number while Alice's number is being set up: the team answers there
    await db.pipeline.update({ where: { id: cot.id }, data: { whatsappNumberId: null } });
    await inbound(ALICE_NUMBER, "5541999998888", ready("Maria"), "wamid.in1", "Maria");
    const maria = await db.lead.findFirstOrThrow();
    expect(maria).toMatchObject({ aiPaused: true, whatsappNumberId: ALICE_NUMBER });
    await drain();
    expect(sends()).toHaveLength(0);

    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    expect(await (await post({ ...quote, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" })).json()).toMatchObject({
      id: maria.id,
      created: true,
      pipeline: "Cotações/ Seguros e Consórcios",
      stage: "Novo",
    });
    expect(await db.lead.findUniqueOrThrow({ where: { id: maria.id } })).toMatchObject({ pipelineId: cot.id, aiPaused: false, whatsappNumberId: ALICE_NUMBER, sdrId: alice.id });
    // Answered from the number she wrote to, with the store; the greeting does not go
    await drain();
    expect(sends().map((c) => [c.url.split("/").at(-2), c.body?.type])).toEqual([[ALICE_NUMBER, "text"]]);
    expect(buildUserTurn(vi.mocked(runSdrTurn).mock.calls[0][0])).toContain("O Banneg é a corretora oficial dessa loja");
    expect(await db.job.count({ where: { leadId: maria.id, type: "rule.run", status: "PENDING" } })).toBe(0);
  });

  it("a lead the CRM had that wrote the code before the referral arrived is referred again, with no lead for the typed phone", async () => {
    const { alice, cot } = await referralFunnel({ delayMinutes: 15 });
    const perdido = await db.stage.findFirstOrThrow({ where: { pipeline: { isDefault: true }, key: "perdido" } });
    const ana = await newLead({ name: "Ana Lima", phone: "5511966665555", stageId: perdido.id, status: "LOST" });
    await inbound(ALICE_NUMBER, "5511966665555", ready("Ana"), "wamid.in1", "Ana");
    const res = await post({ ...quote, name: "Ana Lima", phone: "5511900001111", ref: "portal:cm9x7k2abc123" });
    expect(await res.json()).toMatchObject({ id: ana.id, created: false, moved: true, task: true, pipeline: "Cotações/ Seguros e Consórcios" });
    expect(await db.lead.count()).toBe(1);
    expect(await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).toMatchObject({ pipelineId: cot.id, sdrId: alice.id, whatsappNumberId: ALICE_NUMBER });
    expect((await db.leadEvent.findFirstOrThrow({ where: { leadId: ana.id, type: "lead.duplicate" } })).summary).toContain("a loja informou o número 5511900001111");
  });

  it("a client someone is working in another funnel keeps that funnel's talk; moved to the referral's funnel, the AI speaks for the store", async () => {
    const { duda, cot, novo } = await referralFunnel();
    const franchise = await db.pipeline.findFirstOrThrow({ where: { isDefault: true } });
    const qualificando = await db.stage.findFirstOrThrow({ where: { pipelineId: franchise.id, key: "qualificando" } });
    const caio = await newLead({ name: "Caio", phone: "5511933332222", stageId: qualificando.id, status: "AI_QUALIFYING", sdrId: duda.id });
    await post({ ...quote, name: "Caio", phone: "5511933332222", ref: "portal:caio" });
    // He stays in Expansão and a person decides; the store and product are kept for when they move him
    expect(await db.lead.findUniqueOrThrow({ where: { id: caio.id } })).toMatchObject({
      pipelineId: franchise.id,
      qualification: { parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: cot.id },
    });
    const { runSdrTurn } = await import("@/lib/sdr");
    vi.mocked(runSdrTurn).mockClear();
    await inbound("123", "5511933332222", "Tenho 100 mil para investir", "wamid.in1", "Caio");
    await drain();
    const franchiseTurn = vi.mocked(runSdrTurn).mock.calls[0][0];
    expect(franchiseTurn).toMatchObject({ agentName: "Duda", funnel: { name: "Expansão" } });
    expect(buildUserTurn(franchiseTurn)).not.toContain("Indicação:");

    // The team moves him to Cotações: there the AI speaks for the store
    await leads.moveLead(caio.id, novo.id, "Gerente");
    vi.mocked(runSdrTurn).mockClear();
    await inbound("123", "5511933332222", "Pode cotar o seguro do carro", "wamid.in2", "Caio");
    await drain();
    expect(buildUserTurn(vi.mocked(runSdrTurn).mock.calls[0][0])).toContain('o lead veio pela loja parceira "Lotus Veículos" para uma cotação de seguro auto');
  });

  it("the banner names a funnel's number Meta refuses or blocks, and lets it go once it can send or Meta no longer knows it", async () => {
    const { cot } = await referralFunnel();
    const { checkFunnelNumbers } = await import("@/lib/integrations");
    let alice: () => Response = () => Response.json({ health_status: { can_send_message: "AVAILABLE" } });
    metaGet = (url) => (url.includes(`/${ALICE_NUMBER}?fields=health_status`) ? alice() : undefined);
    const refused = () => Response.json({ error: { code: 100, message: "Unsupported get request. Object with ID '456' does not exist" } }, { status: 400 });
    const blocked = () =>
      Response.json({
        health_status: { can_send_message: "BLOCKED", entities: [{ entity_type: "PHONE_NUMBER", can_send_message: "BLOCKED", errors: [{ error_code: 141010, error_description: "Nome em análise." }] }] },
      });

    // Meta does not know the funnel's number (or the token has no access to it): the banner says so, for that number
    alice = refused;
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toMatchObject({ code: 100, numberId: ALICE_NUMBER });
    // A network failure says nothing either way
    alice = () => {
      throw new Error("fetch failed");
    };
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toMatchObject({ code: 100, numberId: ALICE_NUMBER });
    alice = blocked;
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toMatchObject({ code: 141010, numberId: ALICE_NUMBER });

    // The team moves the funnel back to the main number: Alice's leads still talk there, so her number is still checked...
    await db.pipeline.update({ where: { id: cot.id }, data: { whatsappNumberId: null } });
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toMatchObject({ code: 141010, numberId: ALICE_NUMBER });
    // ...and the banner goes as soon as Meta releases it
    alice = () => Response.json({ health_status: { can_send_message: "AVAILABLE" } });
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toBeNull();

    // A number no funnel uses that Meta no longer knows: nothing left to wait for
    await whatsapp.setHealth({ code: 141010, message: "Nome em análise." }, ALICE_NUMBER);
    alice = refused;
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toBeNull();
    // The main number's own problem is never touched here
    await whatsapp.setHealth({ code: 131042, message: "Pagamento pendente." });
    await checkFunnelNumbers();
    expect(await whatsapp.getHealth()).toMatchObject({ code: 131042 });
  });

  it("someone new writing to a number no funnel uses yet is left to the team, not to the default funnel's AI", async () => {
    await inbound("789", "5511911112222", "Oi, Alice! Quero cotar um seguro.", "wamid.in1", "Gil");
    const gil = await db.lead.findUniqueOrThrow({ where: { phone: "5511911112222" } });
    expect(gil).toMatchObject({ whatsappNumberId: "789", aiPaused: true });
    expect(await db.leadEvent.count({ where: { leadId: gil.id, type: "whatsapp.unassigned_number" } })).toBe(1);
    await drain();
    expect(sends()).toHaveLength(0);
    expect(await db.lead.findUniqueOrThrow({ where: { id: gil.id } })).toMatchObject({ aiPaused: true });
    expect(await db.task.count({ where: { leadId: gil.id, title: "Responder mensagem do lead no WhatsApp" } })).toBe(1);
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

  it("a Meta limit on Alice's number stays on it: the main number's queues go on and only her number clears it", async () => {
    const limit = (code: number, on: string) => (url: string) =>
      url.includes(`/${on}/messages`) ? Response.json({ error: { code, message: "limite" } }, { status: 400 }) : undefined;
    const onAlice = await newLead({ phone: "5541999997777", whatsappNumberId: ALICE_NUMBER, lastInboundAt: new Date() });
    const onMain = await newLead({ lastInboundAt: new Date() });
    metaSend = limit(130429, ALICE_NUMBER);
    expect((await messaging.sendWhatsApp(onAlice, "Oi!", "Alice")).ok).toBe(false);
    expect(await whatsapp.getHealth()).toMatchObject({ code: 130429, numberId: ALICE_NUMBER });
    // The main number sending (or a message of it delivered) says nothing about Alice's number
    metaSend = () => undefined;
    expect((await messaging.sendWhatsApp(onMain, "Oi!", "Duda")).ok).toBe(true);
    expect(await whatsapp.getHealth()).toMatchObject({ numberId: ALICE_NUMBER });

    // Only the queues of the funnel on Alice's number wait
    const { cot } = await referralFunnel();
    const franchise = await db.pipeline.findFirstOrThrow({ where: { isDefault: true }, include: { stages: true } });
    const queue = async (pipelineId: string, toStageId: string, phone: string) => {
      const fila = await db.stage.create({ data: { pipelineId, key: "fila-teste", name: "Na fila", position: 50 } });
      await db.automationRule.create({ data: { stageId: fila.id, trigger: "daily", action: "move", config: { toStageId, perDay: 10 } } });
      return newLead({ phone, pipelineId, stageId: fila.id });
    };
    const novoMain = franchise.stages.find((st) => st.key === "novo")!;
    const novoCot = await db.stage.findFirstOrThrow({ where: { pipelineId: cot.id, key: "novo" } });
    const waitingMain = await queue(franchise.id, novoMain.id, "5511900000011");
    const waitingAlice = await queue(cot.id, novoCot.id, "5511900000012");
    const NOON = new Date("2026-10-14T15:00:00Z");
    await db.setting.update({ where: { key: "whatsapp_health" }, data: { value: { code: 130429, message: "Limite", at: NOON.toISOString(), numberId: ALICE_NUMBER } } });
    const { runDailyBatches } = await import("@/lib/batches");
    expect(await runDailyBatches(NOON)).toEqual({ released: 1, paused: "Limite" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: waitingMain.id } })).stageId).toBe(novoMain.id);
    expect((await db.lead.findUniqueOrThrow({ where: { id: waitingAlice.id } })).stageId).not.toBe(novoCot.id);

    // A message from Alice's number delivered: her number is fine again
    const out = await db.message.create({ data: { leadId: onAlice.id, channel: "WHATSAPP", direction: "OUT", body: "Oi", author: "Alice", status: "SENT", externalId: "wamid.out1" } });
    const status = (to: string) =>
      webhook.POST(
        new Request("http://x/api/whatsapp/webhook", {
          method: "POST",
          body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: to }, statuses: [{ id: out.externalId, status: "delivered" }] } }] }] }),
        }),
      );
    await status("123");
    expect(await whatsapp.getHealth()).toMatchObject({ numberId: ALICE_NUMBER });
    await status(ALICE_NUMBER);
    expect(await whatsapp.getHealth()).toBeNull();

    // A problem of the whole account (payment) is neither replaced by a limit on Alice's number nor cleared by it
    metaSend = limit(131042, "123");
    expect((await messaging.sendWhatsApp(onMain, "Oi!", "Duda")).ok).toBe(false);
    metaSend = limit(130429, ALICE_NUMBER);
    expect((await messaging.sendWhatsApp(onAlice, "Oi!", "Alice")).ok).toBe(false);
    expect(await whatsapp.getHealth()).toMatchObject({ code: 131042 });
    expect((await whatsapp.getHealth())?.numberId).toBeUndefined();
    metaSend = () => undefined;
    await messaging.sendWhatsApp(onAlice, "Oi!", "Alice");
    expect(await whatsapp.getHealth()).toMatchObject({ code: 131042 });
    await messaging.sendWhatsApp(onMain, "Oi!", "Duda");
    expect(await whatsapp.getHealth()).toBeNull();
  });

  it("keeps the account's numbers for the screens, never failing when Meta or the settings are missing", async () => {
    const { refreshWhatsAppNumbers, savedWhatsAppNumbers } = whatsapp;
    // Without the account id nothing is asked and nothing breaks
    expect(await refreshWhatsAppNumbers()).toBeNull();
    expect(calls).toHaveLength(0);

    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-1";
    let metaDown = false;
    metaGet = (url) =>
      url.includes("waba-1/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating")
        ? metaDown
          ? Response.json({ error: { message: "Serviço indisponível" } }, { status: 503 })
          : Response.json({
              data: [
                { id: "123", display_phone_number: "+55 11 92013-8123", verified_name: "Banneg", quality_rating: "GREEN" },
                { id: ALICE_NUMBER, display_phone_number: "+55 17 99679-0187", verified_name: "Alice Banneg", quality_rating: "GREEN" },
              ],
            })
        : undefined;
    const first = await refreshWhatsAppNumbers();
    expect(first?.numbers).toEqual([
      { id: "123", display: "+55 11 92013-8123", name: "Banneg", quality: "GREEN" },
      { id: ALICE_NUMBER, display: "+55 17 99679-0187", name: "Alice Banneg", quality: "GREEN" },
    ]);
    expect((await savedWhatsAppNumbers())?.numbers).toHaveLength(2);

    // Read less than an hour ago: Meta is not asked again
    calls.length = 0;
    expect((await refreshWhatsAppNumbers({ ifOlderThanMs: 3600_000 }))?.at).toBe(first?.at);
    expect(calls).toHaveLength(0);

    // Meta down: the last list stays, with the error to show
    metaDown = true;
    const failed = await refreshWhatsAppNumbers();
    expect(failed).toMatchObject({ error: "Serviço indisponível", numbers: first?.numbers });
    expect((await savedWhatsAppNumbers())?.numbers).toHaveLength(2);
    // Even a network failure only leaves the list as it was
    metaGet = () => {
      throw new Error("fetch failed");
    };
    expect((await refreshWhatsAppNumbers())?.numbers).toHaveLength(2);
  });

  it("Verificar número lists each number with the funnels that use it, and whether the funnel's number can send", async () => {
    const { checkWhatsApp } = await import("@/lib/integrations");
    await referralFunnel();
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = "waba-1";
    process.env.WHATSAPP_FORWARD_URL = "";
    try {
      metaGet = (url) => {
        if (url.includes("/123?fields=display_phone_number")) return Response.json({ display_phone_number: "+55 11 92013-8123", verified_name: "Banneg" });
        if (url.includes("/123?fields=health_status")) return Response.json({ health_status: { can_send_message: "AVAILABLE" } });
        if (url.includes(`/${ALICE_NUMBER}?fields=health_status`))
          return Response.json({
            health_status: { can_send_message: "BLOCKED", entities: [{ entity_type: "PHONE_NUMBER", can_send_message: "BLOCKED", errors: [{ error_code: 141010, error_description: "Nome de exibição em análise." }] }] },
          });
        if (url.includes("/message_templates") || url.includes("/subscribed_apps")) return Response.json({ data: [] });
        if (url.includes("/phone_numbers"))
          return Response.json({
            data: [
              { id: "123", display_phone_number: "+55 11 92013-8123", verified_name: "Banneg", quality_rating: "GREEN" },
              { id: ALICE_NUMBER, display_phone_number: "+55 17 99679-0187", verified_name: "Alice Banneg", quality_rating: "UNKNOWN" },
            ],
          });
      };
      const check = await checkWhatsApp();
      expect(check.ok).toBe(true);
      expect(check.details).toEqual(
        expect.arrayContaining([
          "+55 11 92013-8123 (Banneg), principal: funil Expansão.",
          "+55 17 99679-0187 (Alice Banneg): funil Cotações/ Seguros e Consórcios.",
          "+55 17 99679-0187: envio bloqueado pela Meta: Nome de exibição em análise.",
        ]),
      );
    } finally {
      delete process.env.WHATSAPP_FORWARD_URL;
    }
  });

  it("the e-mail for a lead WhatsApp did not reach points to the number its conversation is on", async () => {
    await db.setting.create({ data: { key: "whatsapp_number", value: { number: "+55 11 92013-8123" } } });
    await db.emailTemplate.create({ data: { key: "whatsapp_nao_chegou", name: "n", subject: "s", body: "Chame: {{link_whatsapp}} ou salve {{numero_whatsapp}}" } });
    const integrations = await import("@/lib/integrations");
    const { enqueue } = await import("@/lib/queue");
    const onMain = await newLead({ email: "maria@x.com" });
    const onAlice = await newLead({ phone: "5541999997777", email: "rui@x.com", whatsappNumberId: ALICE_NUMBER });
    expect(await integrations.whatsappNumberFor(onMain)).toBe("+55 11 92013-8123");

    // Not in the saved list yet: Meta is asked for that number's name; if it does not answer, the main number
    metaGet = (url) => (url.includes(`/${ALICE_NUMBER}?fields=display_phone_number`) ? Response.json({ display_phone_number: "+55 17 99679-0187" }) : undefined);
    expect(await integrations.whatsappNumberFor(onAlice)).toBe("+55 17 99679-0187");
    metaGet = () => Response.json({ error: { message: "x" } }, { status: 400 });
    expect(await integrations.whatsappNumberFor(onAlice)).toBe("+55 11 92013-8123");

    await db.setting.create({
      data: { key: "whatsapp_numbers", value: { at: new Date().toISOString(), numbers: [{ id: ALICE_NUMBER, display: "+55 17 99679-0187", name: "Alice Banneg", quality: "GREEN" }] } },
    });
    for (const lead of [onMain, onAlice]) await enqueue("whatsapp.undelivered_emails", { leadId: lead.id });
    await drain();
    expect(sentEmails.find((e) => e.to === "maria@x.com")?.body).toContain("https://wa.me/5511920138123?text=");
    expect(sentEmails.find((e) => e.to === "rui@x.com")?.body).toContain("https://wa.me/5517996790187?text=");
    expect(sentEmails.find((e) => e.to === "rui@x.com")?.body).toContain("salve +55 17 99679-0187");
  });
});
