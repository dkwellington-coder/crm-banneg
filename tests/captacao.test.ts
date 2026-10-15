// The prospecting funnel: each button the lead taps moves it to the next message, the AI answers
// what the lead types, and whoever wants a meeting goes to the franchise funnel.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesAnswer } from "@/lib/rules";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";

vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => null),
}));

describe("answers", () => {
  it("matches the tapped button or the same words typed", () => {
    expect(matchesAnswer("Quero ver", ["Quero ver", "Agora não"])).toBe(true);
    expect(matchesAnswer("  quero VER! ", ["Quero ver"])).toBe(true);
    expect(matchesAnswer("Agora nao", ["Agora não"])).toBe(true);
    expect(matchesAnswer("quero ver como funciona o modelo", ["Quero ver"])).toBe(false);
    expect(matchesAnswer("", ["Quero ver"])).toBe(false);
  });
});

describe.skipIf(!dbUrl)("prospecting funnel", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  const sent: Record<string, unknown>[] = [];
  const stages: Record<string, string> = {};
  let franchiseQualified: string;
  const BOTTINI = "https://crm-banneg-banneg.vercel.app/materiais/ciro-bottini.mp4";
  const GANHOS = "https://crm-banneg-banneg.vercel.app/materiais/como-ganhar-dinheiro.mp4";

  // Rules of the same moment run a second apart, in their order: bring them all due, keeping the order
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      await db.$executeRawUnsafe(`UPDATE "Job" SET "runAt" = "runAt" - interval '10 seconds' WHERE status = 'PENDING'`);
      if ((await jobs.runDueJobs()).length === 0) break;
    }
  };

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}.${Date.now()}` }] }), { status: 200 });
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    const franchise = await db.pipeline.create({ data: { name: "Vendas de Franquias", slug: "franquias", isDefault: true } });
    franchiseQualified = (await db.stage.create({ data: { pipelineId: franchise.id, key: "qualificado", name: "Qualificado", position: 2 } })).id;
    const p = await db.pipeline.create({ data: { name: "Captação", slug: "captacao", nextPipelineId: franchise.id, position: 5 } });
    for (const [key, name, position] of [
      ["msg1", "1ª mensagem", 1],
      ["msg2", "2ª mensagem", 2],
      ["final", "Mensagem final", 5],
      ["descartado", "Agora não", 7],
    ] as const) {
      stages[key] = (await db.stage.create({ data: { pipelineId: p.id, key, name, position, kind: key === "descartado" ? "LOST" : "OPEN" } })).id;
    }
    await db.whatsAppTemplate.create({
      data: { name: "banneg_captacao_convite", body: "Oi, {{1}}! Aqui é o Wellington.", buttons: ["Quero ver", "Agora não"] },
    });
    await db.whatsAppTemplate.create({
      data: { name: "banneg_captacao_final", body: "Oi, {{1}}! Última mensagem.", buttons: ["Quero marcar", "Não tenho interesse"], headerUrl: BOTTINI },
    });
    const rule = (stageId: string, data: Record<string, unknown>) => db.automationRule.create({ data: { stageId, ...data } as never });
    await rule(stages.msg1, { action: "whatsapp", config: { text: "Oi, {{nome}}!", templateName: "banneg_captacao_convite" } });
    await rule(stages.msg1, { trigger: "answer", action: "move", config: { answers: ["Quero ver"], toStageId: stages.msg2 }, position: 1 });
    await rule(stages.msg1, { trigger: "answer", action: "move", config: { answers: ["Agora não"], toStageId: stages.descartado }, position: 2 });
    await rule(stages.msg2, { action: "whatsapp", config: { text: `Veja como ganha: ${GANHOS}\n\nQuer saber mais?`, buttons: ["Quero saber mais", "Agora não"] } });
    await rule(stages.final, { action: "whatsapp", config: { text: `${BOTTINI} Quer marcar?`, templateName: "banneg_captacao_final" } });
    await rule(stages.final, {
      trigger: "answer",
      action: "move",
      config: { answers: ["Quero marcar"], toStageId: franchiseQualified, aiReplies: true },
    });
  });

  const newLead = (stage: string) => leads.createLead({ name: "Ana Souza", phone: "11988887777", source: "Carteira", stageId: stages[stage] }, "Teste");
  const inbound = (body: string, n: number) =>
    leads.handleInbound({ phone: "5511988887777", body, externalId: `wamid.in.${n}`, at: new Date() });
  const aiReplies = () => db.job.count({ where: { type: "sdr.reply" } });

  it("a tapped button moves the lead and the next message answers, with the video on top", async () => {
    await newLead("msg1");
    await drain();
    expect(sent[0]).toMatchObject({ type: "template", template: { name: "banneg_captacao_convite" } });

    await inbound("Quero ver", 1);
    expect(await aiReplies()).toBe(0);
    await drain();
    const lead = await db.lead.findFirstOrThrow();
    expect(lead.stageId).toBe(stages.msg2);
    expect(sent[1]).toMatchObject({
      type: "interactive",
      interactive: {
        header: { type: "video", video: { link: GANHOS } },
        body: { text: "Veja como ganha.\n\nQuer saber mais?" },
        action: { buttons: [{ reply: { title: "Quero saber mais" } }, { reply: { title: "Agora não" } }] },
      },
    });
  });

  it("what the lead types goes to the AI, and 'Agora não' closes the lead", async () => {
    await newLead("msg1");
    await drain();
    await inbound("Como funciona isso?", 1);
    expect(await aiReplies()).toBe(1);
    await inbound("Agora não", 2);
    await drain();
    expect(await db.lead.findFirstOrThrow()).toMatchObject({ stageId: stages.descartado, status: "DISQUALIFIED" });
  });

  it("the last message carries the video, and 'Quero marcar' goes to the franchise funnel with the AI answering", async () => {
    await newLead("final");
    await drain();
    expect(sent[0]).toMatchObject({
      type: "template",
      template: {
        name: "banneg_captacao_final",
        components: [{ type: "header", parameters: [{ type: "video", video: { link: BOTTINI } }] }, { type: "body" }],
      },
    });
    await inbound("Quero marcar", 1);
    expect(await aiReplies()).toBe(1);
    await drain();
    expect((await db.lead.findFirstOrThrow()).stageId).toBe(franchiseQualified);
  });
});
