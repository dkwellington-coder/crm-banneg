// A quote the AI hands to a person goes by e-mail AND to the quotes WhatsApp group (Wellington, 2026-11-17): who the lead
// is, what it wants quoted, the data it gave and its page in the CRM.
import { describe, expect, it } from "vitest";
import { actionLabel, ACTIONS } from "@/lib/rules";
import { handoffRequest, leadGroupNotice, leadNotice } from "@/lib/notify";

const lead = {
  id: "cmlead9",
  name: "Carla Mendes",
  phone: "5517991234567",
  email: "carla@x.com",
  city: "Rio Preto",
  state: "SP",
  source: "whatsapp",
  campaign: null,
  qualification: { produto: "Seguro de carro", placa: "ABC1D23", uso: "trabalho", parceiroFunil: "x" },
  aiSummary: "Quer cotar o seguro do carro, usa para trabalhar, é casada.",
};
const messages = [
  { direction: "OUT", body: "Me passa a placa?", createdAt: new Date("2026-11-17T18:00:00Z") },
  { direction: "IN", body: "ABC1D23", createdAt: new Date("2026-11-17T18:02:00Z") },
];

describe("handoffRequest", () => {
  it("reads what the lead wants from the open handoff task", () => {
    expect(handoffRequest([{ title: "Ligar amanhã" }, { title: "Assumir conversa: Cotação de seguro auto, placa ABC1D23" }])).toBe(
      "Cotação de seguro auto, placa ABC1D23",
    );
    expect(handoffRequest([{ title: "Ligar amanhã" }])).toBeNull();
  });
});

describe("the quotes group notice", () => {
  it("leads with the headline and the request, then the data, the summary, the last messages and the page", () => {
    const text = leadGroupNotice(lead, {
      pipeline: "Cotações/ Seguros e Consórcios",
      stage: "Cotação: com atendente",
      messages,
      title: "Nova cotação para atender",
      request: "Cotação de seguro auto",
    });
    expect(text.startsWith("*Nova cotação para atender*\n\n*Cliente:* Carla Mendes (Cotações/ Seguros e Consórcios)")).toBe(true);
    expect(text).toContain("*WhatsApp:* (17) 99123-4567 · https://wa.me/5517991234567");
    expect(text).toContain("*E-mail:* carla@x.com");
    expect(text).toContain("*O que o cliente quer:* Cotação de seguro auto");
    expect(text).toContain("*Dados que o cliente passou:*\nproduto: Seguro de carro\nplaca: ABC1D23\nuso: trabalho");
    expect(text).not.toContain("parceiroFunil");
    expect(text).toContain("*Resumo da IA:* Quer cotar o seguro do carro");
    expect(text).toContain("17/11, 15:02 Cliente: ABC1D23");
    expect(text.endsWith("*Ficha no CRM:* https://crm-banneg-banneg.vercel.app/leads/cmlead9")).toBe(true);
  });

  it("without a headline it says the lead wants a consultant", () => {
    const text = leadGroupNotice({ ...lead, email: null, qualification: null, aiSummary: null }, { pipeline: "X", stage: "Y", messages: [] });
    expect(text.startsWith("*Quer falar com um consultor*")).toBe(true);
    expect(text).not.toContain("E-mail");
    expect(text).not.toContain("Dados que");
  });

  it("the e-mail takes the same headline and request", () => {
    const { subject, body } = leadNotice(lead, { pipeline: "Cotações", stage: "x", messages, title: "Nova cotação para atender", request: "Cotação de seguro auto" });
    expect(subject).toBe("Nova cotação para atender: Carla Mendes (Cotações)");
    expect(body.startsWith("Nova cotação para atender: Carla Mendes.")).toBe(true);
    expect(body).toContain("O que o cliente quer:\nCotação de seguro auto");
  });

  it("is an automation the funnel editor offers and labels with the group", () => {
    expect(ACTIONS.group.label).toBe("Avisar um grupo do WhatsApp");
    expect(actionLabel("group", { groupId: "1203@g.us", groupName: "Cotações Banneg", subject: "Nova cotação para atender" })).toBe(
      "Avisar no grupo do WhatsApp “Cotações Banneg” com os dados do lead (“Nova cotação para atender”)",
    );
  });
});

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("the group automation, end to end", () => {
  const GROUP = { id: "120363005555555555@g.us", name: "Cotações Banneg" };
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  let down = false;

  it("posts the handed-off lead in the chosen group with what it asked for; a Uazapi failure retries", async () => {
    process.env.DATABASE_URL = dbUrl;
    process.env.WHATSAPP_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
    process.env.UAZAPI_URL = "https://banneg.uazapi.com";
    process.env.UAZAPI_TOKEN = "tok";
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
      if (url.startsWith("https://banneg.uazapi.com")) {
        posts.push({ url, body: init.body ? JSON.parse(init.body) : {} });
        return down ? Response.json({ error: "instance disconnected" }, { status: 503 }) : Response.json({ messageid: "m1" });
      }
      return Response.json({ messages: [{ id: "wamid.1" }] });
    });
    const { db } = await import("@/lib/db");
    const { installDefaultPipeline } = await import("@/lib/pipeline-defaults");
    const leads = await import("@/lib/leads");
    const jobs = await import("@/lib/jobs");
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    const stage = await db.stage.findFirstOrThrow({ where: { key: "com_gerente" } });
    await db.automationRule.deleteMany({ where: { stageId: stage.id } });
    await db.automationRule.create({
      data: { stageId: stage.id, trigger: "enter", delayMinutes: 0, action: "group", config: { groupId: GROUP.id, groupName: GROUP.name, subject: "Nova cotação para atender" } },
    });
    const { lead } = await leads.createLead({ name: "Carla Mendes", phone: "17991234567", source: "whatsapp" }, "Teste");
    await jobs.runDueJobs();
    posts.length = 0;
    await leads.ensureTask(lead.id, null, "Assumir conversa: Cotação de seguro auto, placa ABC1D23");
    down = true;
    await leads.moveLead(lead.id, stage.id, "Alice");
    await jobs.runDueJobs();
    const job = await db.job.findFirstOrThrow({ where: { type: "rule.run", leadId: lead.id, status: { in: ["PENDING", "DONE"] } }, orderBy: { createdAt: "desc" } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1 });
    down = false;
    posts.length = 0;
    await db.job.update({ where: { id: job.id }, data: { runAt: new Date() } });
    await jobs.runDueJobs();
    const sent = posts.filter((p) => p.url.endsWith("/send/text"));
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ number: GROUP.id, linkPreview: false });
    const text = String(sent[0].body.text);
    expect(text.startsWith("*Nova cotação para atender*")).toBe(true);
    expect(text).toContain("*O que o cliente quer:* Cotação de seguro auto, placa ABC1D23");
    expect(text).toContain(`/leads/${lead.id}`);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).result).toBe("Aviso postado no grupo Cotações Banneg.");
    vi.unstubAllGlobals();
  });
});
