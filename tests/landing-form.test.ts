// The landing page's franchise form, served by the CRM: the lead lands in Vendas de Franquias with what it answered.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const { readLandingForm, FormError, CAPITAL, START } = await import("@/lib/landing-form");
const { installDefaultPipeline } = await import("@/lib/pipeline-defaults");

const form = (over: Record<string, unknown> = {}) => ({
  event_id: "2b1f6c1e-9d3a-4c55-8f0e-6a7b8c9d0e1f",
  name: "Lia Prado",
  phone: "(17) 98160-0011",
  email: "Lia@x.com",
  city: "São José do Rio Preto",
  state: "sp",
  investment: CAPITAL[2],
  start_window: START[1],
  website: "",
  contact_consent: true,
  elapsed_ms: 9000,
  utm: { utm_source: "meta", utm_campaign: "franquia-out", other: "x" },
  landing_url: "https://franquia.banneg.com.br/?utm_source=meta",
  ...over,
});

describe("reading the landing form", () => {
  it("keeps what the lead answered and the campaign it came from", () => {
    expect(readLandingForm(form())).toMatchObject({
      name: "Lia Prado",
      email: "lia@x.com",
      state: "SP",
      capital: "Acima de R$ 30 mil até R$ 50 mil",
      start: "De 31 a 90 dias",
      utm: { utm_source: "meta", utm_campaign: "franquia-out" },
    });
  });

  it("turns robots and incomplete forms away", () => {
    const fails = (over: Record<string, unknown>) => expect(() => readLandingForm(form(over))).toThrow(FormError);
    fails({ website: "spam.com" });
    fails({ elapsed_ms: 300 });
    fails({ contact_consent: false });
    fails({ phone: "1234" });
    fails({ email: "lia" });
    fails({ state: "XX" });
    fails({ investment: "1 milhão" });
    fails({ start_window: "" });
    fails({ event_id: "abc" });
    fails({ name: "L".repeat(500) });
  });
});

describe.skipIf(!dbUrl)("the landing form in the CRM", () => {
  let db: typeof import("@/lib/db").db;
  let route: typeof import("@/app/api/form/franquia/route");
  let page: typeof import("@/app/form/[form]/route");
  let franchise: { id: string };
  const post = (body: unknown, origin = "https://crm.test", ip = "1.2.3.4") =>
    route.POST(
      new Request("https://crm.test/api/form/franquia", {
        method: "POST",
        headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    route = await import("@/app/api/form/franquia/route");
    page = await import("@/app/form/[form]/route");
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    franchise = await installDefaultPipeline(db);
    await db.pipeline.update({ where: { id: franchise.id }, data: { slug: "franquias" } });
    // Another funnel first in line, so the form has to pick Vendas de Franquias itself
    await db.pipeline.updateMany({ where: { id: franchise.id }, data: { isDefault: false } });
    const other = await db.pipeline.create({ data: { name: "Cotações", slug: "cotacoes", position: 0, isDefault: true } });
    await db.stage.create({ data: { pipelineId: other.id, key: "novo", name: "Novo", position: 0 } });
  });

  it("creates the lead in Vendas de Franquias with its answers, once", async () => {
    const res = await post(form());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ saved: true, receipt: form().event_id });
    const lead = await db.lead.findFirstOrThrow({ include: { events: true } });
    expect(lead).toMatchObject({
      name: "Lia Prado",
      phone: "5517981600011",
      email: "lia@x.com",
      city: "São José do Rio Preto",
      state: "SP",
      source: "Landing franquia",
      campaign: "franquia-out",
      pipelineId: franchise.id,
    });
    expect(lead.qualification).toMatchObject({ capital: "Acima de R$ 30 mil até R$ 50 mil", timeline: "De 31 a 90 dias", utm_source: "meta" });
    expect(lead.events.find((e) => e.type === "lead.form")?.summary).toMatch(/capital Acima de R\$ 30 mil.*Aceitou receber contato/);

    // The page sends again after a lost answer: nothing new
    const again = await post(form());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ saved: true });
    expect(await db.lead.count()).toBe(1);
    expect(await db.leadEvent.count({ where: { type: "lead.form" } })).toBe(1);
  });

  it("a lead already here: keeps what the AI learned, fills the rest and asks the team to call", async () => {
    const { createLead } = await import("@/lib/leads");
    const { lead } = await createLead({ name: "Lia", phone: "17981600011", source: "Facebook", qualification: { capital: "R$ 80 mil" } }, "teste");
    expect((await post(form({ event_id: uuid(1) }))).status).toBe(200);
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { tasks: true } });
    expect(after.qualification).toMatchObject({ capital: "R$ 80 mil", timeline: "De 31 a 90 dias" });
    expect(after.tasks.map((t) => t.title)).toEqual(["Lead preencheu o formulário da franquia de novo: chamar"]);
  });

  it("answers only its own page, and stops a robot sending from one connection", async () => {
    expect((await post(form(), "https://evil.test")).status).toBe(403);
    const bad = await post(form({ contact_consent: false }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Confirme que deseja receber contato sobre a franquia." });
    for (let i = 0; i < 20; i++) expect((await post(form({ event_id: uuid(100 + i), phone: `1798160${String(1000 + i)}` }), undefined, "9.9.9.9")).status).toBe(201);
    expect((await post(form({ event_id: uuid(200), phone: "17981609999" }), undefined, "9.9.9.9")).status).toBe(429);
    // Someone else is not held back
    expect((await post(form({ event_id: uuid(201), phone: "17981608888" }), undefined, "5.5.5.5")).status).toBe(201);
  });

  it("the page: the same form, framed only by the Banneg pages", async () => {
    const res = await page.GET(new Request("https://crm.test/form/principal"), { params: Promise.resolve({ form: "principal" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self' https://franquia.banneg.com.br");
    const html = await res.text();
    expect(html).toContain("Vamos conversar sobre<br>sua franquia?");
    expect(html).toContain('"postTo":"/api/form/franquia"');
    expect(html).toContain("<option>Acima de R$ 50 mil</option>");
    expect((await page.GET(new Request("https://crm.test/form/x"), { params: Promise.resolve({ form: "x" }) })).status).toBe(404);
  });
});
