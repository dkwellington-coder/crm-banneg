// A person who refers clients (an affiliate of the Portal de indicações) is no store: the client never reads "a
// corretora oficial da João Silva", in the stage's WhatsApp, in the AI's talk or in the team's task. A store's referral
// stays exactly as it was. The pure parts always run; the rest only when TEST_DATABASE_URL is set. Meta (fetch) and
// Claude are stubbed.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdrDecision } from "@/lib/sdr";
import { buildUserTurn, type SdrContext } from "@/lib/sdr";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { actionLabel, forPerson, speaksOfPartner, type RuleConfig } from "@/lib/rules";
import { readyName } from "@/lib/leads";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";
process.env.PORTAL_LEADS_TOKEN = "portal-token";

const nextDecision = vi.hoisted(() => ({ value: null as SdrDecision | null }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));
// A manager is signed in for the server action that saves an automation
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: vi.fn(async () => ({ id: "u1", name: "Gerente", role: "MANAGER" })),
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: vi.fn() }));

// The Cotações greeting as it is today, and its version for a person
const STORE_TEXT =
  "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}, somos a corretora oficial da {{parceiro}}. Recebi seu contato para uma cotação de {{produto}}, pode ser?";
const STORE_BODY = "Oi, {{1}}! Aqui é a {{2}}, do Banneg, somos a corretora oficial da {{3}}. Recebi seu contato para uma cotação de {{4}}, pode ser?";
const PERSON_TEXT = "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}. Recebi seu contato por indicação de {{parceiro}} para uma cotação de {{produto}}, pode ser?";
const PERSON_BODY = "Oi, {{1}}! Aqui é a {{2}}, do Banneg. Recebi seu contato por indicação de {{3}} para uma cotação de {{4}}, pode ser?";
const PARAMS = ["nome", "sdr", "parceiro", "produto"];
const SKIPPED = "Ignorado: indicação de pessoa (afiliado) e esta automação fala de loja; falta a versão para pessoa.";

const COTACOES = "pipeline-cotacoes";
const turn = (qualification: Record<string, unknown>) =>
  buildUserTurn({
    agentName: "Alice",
    persona: "x",
    settings: DEFAULT_SETTINGS,
    funnel: { id: COTACOES, name: "Cotações", goal: null, questions: [] },
    knowledge: [],
    lead: { name: "Ana", phone: null, email: null, city: null, state: null, source: "Portal", qualification, summary: null },
    transcript: [],
    slots: [],
    now: new Date("2026-10-20T15:00:00Z"),
  } satisfies SdrContext);

describe("a person's referral, without the database", () => {
  it("still finds the client's first name in the portal's ready message for a person's referral", () => {
    expect(readyName("Oi, Alice! Sou Ana, vim pela indicação de João Silva para a cotação de seguro auto. Pedido ABC123")).toBe("Ana");
    expect(readyName("Oi! Sou Ana e quero seguir com a minha cotação pela indicação de João Silva. Pedido ABC123")).toBe("Ana");
    // The store's wording, as before
    expect(readyName("Oi, Alice! Sou Bia, vim pela Lotus Veículos para a cotação de seguro auto. Pedido ABC123")).toBe("Bia");
    // Without the referral's code it is no ready message
    expect(readyName("Sou Ana, vim pela indicação de João Silva")).toBeNull();
  });

  it("a rule speaks of the partner by {{parceiro}} in its text or in its template; its person version replaces text and template", () => {
    expect(speaksOfPartner({ text: STORE_TEXT })).toBe(true);
    expect(speaksOfPartner({ text: "Oi, {{nome}}!", templateParams: PARAMS })).toBe(true);
    expect(speaksOfPartner({ text: "Oi, {{nome}}! Conseguiu ver?", templateParams: ["nome"] })).toBe(false);

    const rule: RuleConfig = { text: STORE_TEXT, templateName: "banneg_cotacao_parceiro", templateParams: PARAMS, buttons: ["Pode ser"] };
    expect(forPerson(rule)).toBeNull();
    // A version without its text is no version
    expect(forPerson({ ...rule, pessoa: { templateName: "banneg_cotacao_indicacao" } })).toBeNull();
    expect(forPerson({ ...rule, pessoa: { text: PERSON_TEXT, templateName: "banneg_cotacao_indicacao", templateParams: PARAMS } })).toMatchObject({
      text: PERSON_TEXT,
      templateName: "banneg_cotacao_indicacao",
      templateParams: PARAMS,
      buttons: ["Pode ser"],
    });
    // Text only: outside the window it waits for the lead, never the store's template
    expect(forPerson({ ...rule, pessoa: { text: PERSON_TEXT } })).toMatchObject({ text: PERSON_TEXT, templateName: undefined, templateParams: undefined });

    expect(actionLabel("whatsapp", rule)).not.toContain("pessoa");
    expect(actionLabel("whatsapp", { ...rule, pessoa: { text: PERSON_TEXT } })).toContain("com versão para indicação de pessoa");
  });

  it("the AI says a person referred the company, and never that it is that person's broker; a store's prompt is as it was", () => {
    const person = turn({ parceiro: "João Silva", parceiroTipo: "PESSOA", produto: "seguro auto", parceiroFunil: COTACOES });
    expect(person).toContain(
      'Indicação: o lead veio por indicação de "João Silva", parceiro do Banneg, para uma cotação de seguro auto. Se ainda não se apresentou nesta conversa, diga que você é do Banneg e que João Silva indicou o Banneg para a cotação, e siga com a cotação. João Silva é uma pessoa, não uma loja: não diga que o Banneg é corretora oficial de João Silva. Se a decisão for disqualify, João Silva lê o motivo (reason) no portal de indicações: diga o motivo sem expor dados pessoais ou financeiros do lead.',
    );
    expect(person).not.toContain("corretora oficial da");
    expect(person).not.toContain("loja parceira");
    expect(turn({ parceiro: "João Silva", parceiroTipo: "PESSOA", parceiroFunil: COTACOES })).toContain(
      'Indicação: o lead veio por indicação de "João Silva", parceiro do Banneg. Se ainda',
    );

    const store = turn({ parceiro: "Lotus Veículos", produto: "seguro auto", parceiroFunil: COTACOES });
    expect(store).toContain(
      'Indicação: o lead veio pela loja parceira "Lotus Veículos" para uma cotação de seguro auto. O Banneg é a corretora oficial dessa loja: se ainda não se apresentou nesta conversa, diga que você é do Banneg, a corretora oficial da Lotus Veículos, e siga com a cotação.',
    );
  });
});

describe.skipIf(!dbUrl)("a person's referral", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let api: typeof import("@/app/api/leads/route");
  let actions: typeof import("@/app/actions");
  const sent: { to: string; type: string; body: unknown; params?: string[] }[] = [];
  let franchise: { id: string };

  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await jobs.runDueJobs()).length === 0) break;
  };
  const post = (body: unknown) =>
    api.POST(new Request("http://x/api/leads", { method: "POST", headers: { authorization: "Bearer portal-token" }, body: JSON.stringify(body) }));
  const quote = { funil: "parceiro-veiculos", produto: "seguro auto", campaign: "Portal de indicações" };
  const byPerson = { ...quote, parceiro: "João Silva", parceiroTipo: "PESSOA", source: "Afiliado João Silva" };
  const byStore = { ...quote, parceiro: "Lotus Veículos", parceiroTipo: "LOJA", source: "Parceiro Lotus Veículos" };

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    api = await import("@/app/api/leads/route");
    actions = await import("@/app/actions");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const params = body.template?.components?.find((c: { type: string }) => c.type === "body")?.parameters.map((p: { text: string }) => p.text);
      sent.push({ to: body.to, type: body.type, body: body.text?.body ?? body.interactive?.body?.text ?? body.template?.name, params });
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
    nextDecision.value = null;
  });

  // Cotações as in production: Novo greets the client with banneg_cotacao_parceiro ("corretora oficial da {{3}}")
  async function cotacoes(opts: { delayMinutes?: number; pessoa?: RuleConfig["pessoa"] } = {}) {
    const cot = await db.pipeline.create({ data: { name: "Cotações/ Seguros e Consórcios", slug: "parceiro-veiculos", position: 6 } });
    const novo = await db.stage.create({ data: { pipelineId: cot.id, key: "novo", name: "Novo", position: 0 } });
    const perdido = await db.stage.create({ data: { pipelineId: cot.id, key: "perdido", name: "Perdido", kind: "LOST", position: 9 } });
    await db.whatsAppTemplate.create({ data: { name: "banneg_cotacao_parceiro", body: STORE_BODY, purpose: "importado", buttons: ["Pode ser", "Parar mensagens"] } });
    const rule = await db.automationRule.create({
      data: {
        stageId: novo.id,
        action: "whatsapp",
        delayMinutes: opts.delayMinutes ?? 0,
        config: { text: STORE_TEXT, templateName: "banneg_cotacao_parceiro", templateParams: PARAMS, ...(opts.pessoa && { pessoa: opts.pessoa }) },
      },
    });
    return { cot, novo, perdido, rule };
  }

  it("the portal's person referral keeps parceiroTipo PESSOA; a store's lead has no such key, as before", async () => {
    const { cot } = await cotacoes();
    const ana = await (await post({ ...byPerson, name: "Ana Lima", phone: "5541999998888", ref: "portal:aaa111" })).json();
    expect((await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).qualification).toEqual({
      produto: "seguro auto",
      parceiro: "João Silva",
      parceiroTipo: "PESSOA",
      parceiroFunil: cot.id,
    });
    const maria = await (await post({ ...byStore, name: "Maria Souza", phone: "5541988887777", ref: "portal:bbb222" })).json();
    // A portal from before affiliates sends no kind at all
    const plain = await (await post({ ...byStore, parceiroTipo: undefined, name: "Bia", phone: "5541977776666", ref: "portal:ccc333" })).json();
    for (const id of [maria.id, plain.id]) {
      expect((await db.lead.findUniqueOrThrow({ where: { id } })).qualification).toEqual({ produto: "seguro auto", parceiro: "Lotus Veículos", parceiroFunil: cot.id });
    }
    // Only a partner has a kind
    const ze = await (await post({ ...byPerson, parceiro: undefined, name: "Zé", phone: "5541966665555" })).json();
    expect((await db.lead.findUniqueOrThrow({ where: { id: ze.id } })).qualification).toEqual({ produto: "seguro auto" });
  });

  it("a greeting about the store does not go to a person's referral without its person version; a store's goes as it always did", async () => {
    await cotacoes();
    const ana = await (await post({ ...byPerson, name: "Ana Lima", phone: "5541999998888", ref: "portal:aaa111" })).json();
    const maria = await (await post({ ...byStore, name: "Maria Souza", phone: "5541988887777", ref: "portal:bbb222" })).json();
    await drain();

    expect(sent.filter((m) => m.to === "5541999998888")).toEqual([]);
    expect(await db.job.findFirstOrThrow({ where: { leadId: ana.id, type: "rule.run" } })).toMatchObject({ status: "DONE", result: SKIPPED });
    expect(await db.leadEvent.count({ where: { leadId: ana.id, type: "automation.ran", summary: `Novo: ${SKIPPED}` } })).toBe(1);
    expect(await db.message.count({ where: { leadId: ana.id } })).toBe(0);

    expect(sent.filter((m) => m.to === "5541988887777")).toEqual([
      { to: "5541988887777", type: "template", body: "banneg_cotacao_parceiro", params: ["Maria", "Duda", "Lotus Veículos", "seguro auto"] },
    ]);
    expect((await db.message.findFirstOrThrow({ where: { leadId: maria.id, direction: "OUT" } })).body).toBe(
      "Oi, Maria! Aqui é a Duda, do Banneg, somos a corretora oficial da Lotus Veículos. Recebi seu contato para uma cotação de seguro auto, pode ser?",
    );

    // Inside the 24 h window, and with {{parceiro}} only in the template's variables, the same
    const talking = await db.lead.update({ where: { id: ana.id }, data: { lastInboundAt: new Date() } });
    const rule: RuleConfig = { text: STORE_TEXT, templateName: "banneg_cotacao_parceiro", templateParams: PARAMS };
    expect(await jobs.runAction(talking, "whatsapp", rule)).toBe(SKIPPED);
    expect(await jobs.runAction(talking, "whatsapp", { ...rule, text: "Oi, {{nome}}!" })).toBe(SKIPPED);
    expect(sent.filter((m) => m.to === "5541999998888")).toEqual([]);
    // A message that does not speak of the partner goes as for anyone
    expect(await jobs.runAction(talking, "whatsapp", { text: "Oi, {{nome}}! Conseguiu ver minha mensagem?" })).toBe("WhatsApp enviado.");
    expect(sent.at(-1)).toMatchObject({ to: "5541999998888", type: "text", body: "Oi, Ana! Conseguiu ver minha mensagem?" });
  });

  it("with the person version, a person's referral gets its template outside the window and its text inside", async () => {
    const pessoa = { text: PERSON_TEXT, templateName: "banneg_cotacao_indicacao", templateParams: PARAMS };
    const { rule: greeting } = await cotacoes({ pessoa });
    // Right after it is created the template waits for Meta: nothing goes, and never the store's template instead
    await db.whatsAppTemplate.create({ data: { name: "banneg_cotacao_indicacao", body: PERSON_BODY, purpose: "importado", status: "draft", active: false } });
    const ana = await (await post({ ...byPerson, name: "Ana Lima", phone: "5541999998888", ref: "portal:aaa111" })).json();
    await drain();
    expect(sent).toEqual([]);
    expect((await db.job.findFirstOrThrow({ where: { leadId: ana.id, type: "rule.run" } })).result).toBe(
      "Ignorado: janela de 24 h fechada e o modelo banneg_cotacao_indicacao ainda não foi aprovado pela Meta.",
    );

    // Approved: the person's template, filled with the same variables
    await db.whatsAppTemplate.update({ where: { name: "banneg_cotacao_indicacao" }, data: { status: "APPROVED", active: true } });
    const bia = await (await post({ ...byPerson, name: "Bia Rocha", phone: "5541977776666", ref: "portal:ccc333" })).json();
    const maria = await (await post({ ...byStore, name: "Maria Souza", phone: "5541988887777", ref: "portal:bbb222" })).json();
    await drain();
    expect(sent.find((m) => m.to === "5541977776666")).toEqual({
      to: "5541977776666",
      type: "template",
      body: "banneg_cotacao_indicacao",
      params: ["Bia", "Duda", "João Silva", "seguro auto"],
    });
    expect((await db.message.findFirstOrThrow({ where: { leadId: bia.id, direction: "OUT" } })).body).toBe(
      "Oi, Bia! Aqui é a Duda, do Banneg. Recebi seu contato por indicação de João Silva para uma cotação de seguro auto, pode ser?",
    );
    // The store's lead is untouched by the person version
    expect(sent.find((m) => m.to === "5541988887777")).toEqual({
      to: "5541988887777",
      type: "template",
      body: "banneg_cotacao_parceiro",
      params: ["Maria", "Duda", "Lotus Veículos", "seguro auto"],
    });
    expect((await db.message.findFirstOrThrow({ where: { leadId: maria.id, direction: "OUT" } })).body).toContain("somos a corretora oficial da Lotus Veículos");

    // Inside the window the person's own text goes
    const rule = greeting.config as RuleConfig;
    const talking = await db.lead.update({ where: { id: ana.id }, data: { lastInboundAt: new Date() } });
    expect(await jobs.runAction(talking, "whatsapp", rule)).toBe("WhatsApp enviado.");
    expect(sent.at(-1)).toEqual({
      to: "5541999998888",
      type: "text",
      body: "Oi, Ana! Aqui é a Duda, do Banneg. Recebi seu contato por indicação de João Silva para uma cotação de seguro auto, pode ser?",
      params: undefined,
    });
    // A version with no template of its own waits for the lead outside the window
    const quiet = await db.lead.update({ where: { id: ana.id }, data: { lastInboundAt: null } });
    expect(await jobs.runAction(quiet, "whatsapp", { ...rule, pessoa: { text: PERSON_TEXT } })).toBe(
      "Ignorado: janela de 24 h fechada e esta mensagem não tem modelo da Meta.",
    );
  });

  it("a contact the CRM had, referred by a person, gets the task 'Nova indicação de X', and the kind follows the partner the lead takes", async () => {
    const { cot, perdido: perdidoCot } = await cotacoes({ delayMinutes: 15 });
    // Open in another funnel: stays there and learns the partner it lacked, with its kind
    const rui = (await leads.createLead({ name: "Rui", phone: "11977776666", source: "site" }, "teste")).lead;
    const referral = { ...byPerson, produto: "consórcio", name: "Rui", phone: "11977776666", ref: "portal:rui1" };
    expect(await (await post(referral)).json()).toMatchObject({ id: rui.id, created: false, moved: false, task: true });
    const title = "Nova indicação de João Silva: cotar consórcio";
    expect((await db.task.findMany({ where: { leadId: rui.id } })).map((t) => t.title)).toEqual([title]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: rui.id } })).qualification).toEqual({
      parceiro: "João Silva",
      parceiroTipo: "PESSOA",
      produto: "consórcio",
      parceiroFunil: cot.id,
    });
    // The same person again rings the same task
    const seenAt = new Date();
    await post({ ...referral, ref: "portal:rui2" });
    expect(await db.task.count({ where: { leadId: rui.id } })).toBe(1);
    expect((await db.task.findFirstOrThrow({ where: { leadId: rui.id, title } })).dueAt.getTime()).toBeGreaterThanOrEqual(seenAt.getTime());
    // A store referring him meanwhile gets its own task ("da"), and his conversation keeps the person and its kind
    await post({ ...byStore, produto: "consórcio", name: "Rui", phone: "11977776666", ref: "portal:rui3" });
    expect((await db.task.findMany({ where: { leadId: rui.id }, orderBy: { createdAt: "asc" } })).map((t) => t.title)).toEqual([
      title,
      "Nova indicação da Lotus Veículos: cotar consórcio",
    ]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: rui.id } })).qualification).toMatchObject({ parceiro: "João Silva", parceiroTipo: "PESSOA" });

    // A store's client the CRM had lost starts over with the person who referred her now, and back with a store later
    const perdido = await db.stage.findFirstOrThrow({ where: { pipelineId: franchise.id, key: "perdido" } });
    const ana = (await leads.createLead({ name: "Ana Lima", phone: "11966665555", source: "site", qualification: { parceiro: "Auto Norte", produto: "franquia" } }, "teste")).lead;
    await leads.moveLead(ana.id, perdido.id, "teste", { aiPaused: true, lostReason: "Sem interesse" });
    expect(await (await post({ ...byPerson, name: "Ana Lima", phone: "11966665555", ref: "portal:ana1" })).json()).toMatchObject({ moved: true, task: true });
    expect((await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).qualification).toEqual({
      parceiro: "João Silva",
      parceiroTipo: "PESSOA",
      produto: "seguro auto",
      parceiroFunil: cot.id,
    });
    expect(await db.task.count({ where: { leadId: ana.id, title: "Nova indicação de João Silva: cotar seguro auto" } })).toBe(1);
    await leads.moveLead(ana.id, perdidoCot.id, "teste", { aiPaused: true, lostReason: "Comprou em outro lugar" });
    await post({ ...byStore, name: "Ana Lima", phone: "11966665555", ref: "portal:ana2" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: ana.id } })).qualification).toEqual({
      parceiro: "Lotus Veículos",
      produto: "seguro auto",
      parceiroFunil: cot.id,
    });
  });

  it("the client of a person's referral writes the ready message from a phone the CRM had: the referral goes on there as a person's", async () => {
    const { cot } = await cotacoes({ delayMinutes: 15 });
    const fila = await db.stage.create({ data: { pipelineId: franchise.id, key: "fila", name: "Na fila", position: 50 } });
    const old = (await leads.createLead({ name: "Maria S.", phone: "5541988887777", source: "Kommo", stageId: fila.id, reactivation: true }, "teste")).lead;
    const ref = await (await post({ ...byPerson, name: "Maria Souza", phone: "5541999998888", ref: "portal:cm9x7k2abc123" })).json();

    nextDecision.value = {
      reply: "Oi, Maria! Aqui é a Duda, do Banneg. O João Silva indicou a gente para a sua cotação.",
      extracted: { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null },
      score: 40,
      temperature: "morno",
      decision: "continue",
      slotIndex: null,
      handoffTo: null,
      sendCof: false,
      reason: "respondeu",
      summary: "Pediu cotação.",
    };
    await leads.handleInbound({
      phone: "5541988887777",
      profileName: "Maria",
      body: "Oi, Duda! Sou Maria, vim pela indicação de João Silva para a cotação de seguro auto. Pedido ABC123",
      externalId: "wamid.in1",
      at: new Date(),
      phoneNumberId: "123",
    });
    const maria = await db.lead.findUniqueOrThrow({ where: { id: old.id } });
    expect(maria).toMatchObject({ pipelineId: cot.id });
    expect(maria.qualification).toEqual({ parceiro: "João Silva", parceiroTipo: "PESSOA", produto: "seguro auto", parceiroFunil: cot.id });
    expect(await db.task.count({ where: { leadId: old.id, title: "Nova indicação de João Silva: cotar seguro auto" } })).toBe(1);
    expect((await db.leadEvent.findFirstOrThrow({ where: { leadId: old.id, type: "lead.referral_joined" } })).summary).toContain(
      "Escreveu com o código da indicação de João Silva (pedido ABC123)",
    );
    // The referral's own lead closed as a duplicate
    expect(await db.lead.findUniqueOrThrow({ where: { id: ref.id }, include: { stage: true } })).toMatchObject({ stage: { kind: "LOST" } });

    // The AI answers knowing a person referred her
    await drain();
    const { runSdrTurn } = await import("@/lib/sdr");
    const ctx = vi.mocked(runSdrTurn).mock.calls.at(-1)![0];
    expect(buildUserTurn(ctx)).toContain("diga que você é do Banneg e que João Silva indicou o Banneg para a cotação");
    expect(buildUserTurn(ctx)).not.toContain("corretora oficial da João Silva");
  });

  it("saving an automation keeps its person version, and an editor from before the field existed does not drop it", async () => {
    const { novo, rule } = await cotacoes({ pessoa: { text: "antes" } });
    const form = (extra: Record<string, string | string[]>) => {
      const fd = new FormData();
      const base = { id: rule.id, stageId: novo.id, action: "whatsapp", trigger: "enter", amount: "0", unit: "d", text: STORE_TEXT, templateName: "banneg_cotacao_parceiro", templateParams: PARAMS };
      for (const [k, v] of Object.entries({ ...base, ...extra })) for (const one of [v].flat()) fd.append(k, one);
      return fd;
    };
    const saved = async () => ((await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).config as RuleConfig).pessoa;

    // An old editor's form, with no person fields: the version stays
    await actions.saveRuleAction(form({}));
    expect(await saved()).toEqual({ text: "antes" });

    // The editor's person version: text, template and its variables (only word-like ones)
    await actions.saveRuleAction(
      form({ pessoaForm: "1", pessoaText: PERSON_TEXT, pessoaTemplateName: "banneg_cotacao_indicacao", pessoaTemplateParams: [...PARAMS.slice(0, 3), "x y"] }),
    );
    expect(await saved()).toEqual({ text: PERSON_TEXT, templateName: "banneg_cotacao_indicacao", templateParams: ["nome", "sdr", "parceiro"] });
    const config = (await db.automationRule.findUniqueOrThrow({ where: { id: rule.id } })).config as RuleConfig;
    expect(config).toMatchObject({ text: STORE_TEXT, templateName: "banneg_cotacao_parceiro", templateParams: PARAMS });

    // A text with no template: no variables either
    await actions.saveRuleAction(form({ pessoaForm: "1", pessoaText: PERSON_TEXT, pessoaTemplateParams: PARAMS }));
    expect(await saved()).toEqual({ text: PERSON_TEXT });

    // Cleared in the editor: gone
    await actions.saveRuleAction(form({ pessoaForm: "1", pessoaText: "", pessoaTemplateName: "banneg_cotacao_indicacao" }));
    expect(await saved()).toBeUndefined();

    // Another action never carries it
    await db.automationRule.update({ where: { id: rule.id }, data: { config: { text: STORE_TEXT, pessoa: { text: "antes" } } } });
    await actions.saveRuleAction(form({ action: "task", title: "Ligar" }));
    expect(await saved()).toBeUndefined();
  });
});
