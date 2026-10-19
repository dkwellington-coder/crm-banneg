// Facebook and Instagram lead forms read straight from Meta, each lead landing in the right funnel.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
delete process.env.META_PAGE_ID;

// Loaded after DATABASE_URL is set, since the module opens the database
const { funnelForForm, mapFields } = await import("@/lib/meta-leads");
const { installDefaultPipeline } = await import("@/lib/pipeline-defaults");

describe("form answers", () => {
  it("maps the standard and Portuguese questions, and keeps the rest for the AI", () => {
    expect(
      mapFields([
        { name: "full_name", values: ["Ana Souza"] },
        { name: "phone_number", values: ["+5511988887777"] },
        { name: "email", values: ["ana@x.com"] },
        { name: "cidade", values: ["Campinas"] },
        { name: "qual_seu_capital_para_investir?", values: ["R$ 50 mil"] },
      ]),
    ).toEqual({
      name: "Ana Souza",
      phone: "+5511988887777",
      email: "ana@x.com",
      city: "Campinas",
      qualification: { "qual seu capital para investir": "R$ 50 mil" },
    });
    expect(mapFields([{ name: "first_name", values: ["Rui"] }, { name: "last_name", values: ["Lima"] }]).name).toBe("Rui Lima");
  });

  it("picks the funnel from the form name", () => {
    expect(funnelForForm("Franquia Banneg - Outubro")).toBe("franquias");
    expect(funnelForForm("Cotação Seguro Auto")).toBe("produtos");
    expect(funnelForForm("Consórcio imobiliário")).toBe("produtos");
    expect(funnelForForm("Formulário 3")).toBeNull();
  });
});

describe.skipIf(!dbUrl)("reading the forms", () => {
  let db: typeof import("@/lib/db").db;
  let metaLeads: typeof import("@/lib/meta-leads");
  let franchise: { id: string };
  const leadsByForm: Record<string, unknown[]> = {};
  let failWith: { code: number; message: string } | null = null;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    metaLeads = await import("@/lib/meta-leads");
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (failWith) return json({ error: failWith }, 400);
      if (u.pathname.endsWith("/me/accounts")) return json({ data: [{ id: "pg1", name: "Banneg", access_token: "page-token" }] });
      if (u.pathname.endsWith("/pg1/leadgen_forms"))
        return json({
          data: [
            { id: "f1", name: "Franquia Banneg", status: "ACTIVE" },
            { id: "f2", name: "Cotação seguro auto", status: "ACTIVE" },
            { id: "f3", name: "Antigo", status: "ARCHIVED" },
          ],
        });
      const form = u.pathname.match(/\/(f\d)\/leads$/)?.[1];
      if (form) {
        // Meta's filter on time_created, like the real Graph API
        const after = (JSON.parse(u.searchParams.get("filtering") ?? "[]") as { value: number }[])[0]?.value ?? 0;
        const all = (leadsByForm[form] ?? []) as { created_time: string }[];
        return json({ data: all.filter((l) => Date.parse(l.created_time) / 1000 > after) });
      }
      const one = Object.values(leadsByForm)
        .flat()
        .find((l) => u.pathname.endsWith(`/${(l as { id: string }).id}`));
      if (one) return json(one);
      // WhatsApp sends from the automations
      return json({ messages: [{ id: `wamid.${Math.random()}` }] });
    });
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    franchise = await installDefaultPipeline(db);
    await db.pipeline.update({ where: { id: franchise.id }, data: { slug: "franquias" } });
    const produtos = await db.pipeline.create({ data: { name: "Aquecimento de Produtos", slug: "produtos", position: 2 } });
    await db.stage.create({ data: { pipelineId: produtos.id, key: "fila", name: "Na fila", position: 0 } });
    await db.stage.create({ data: { pipelineId: produtos.id, key: "novo", name: "Novo pedido", position: 1 } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    failWith = null;
    for (const k of Object.keys(leadsByForm)) delete leadsByForm[k];
  });

  const at = (iso: string) => new Date(iso);
  const lead = (id: string, time: string, fields: Record<string, string>, platform = "fb") => ({
    id,
    created_time: time,
    platform,
    campaign_name: "Campanha X",
    field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })),
  });

  it("reads a new form from 3 days back, then brings each new lead once into its funnel", async () => {
    // A new campaign's first leads count; older ones are left to the daily check
    leadsByForm.f1 = [
      lead("L0", "2026-10-01T10:00:00+0000", { full_name: "Velho", phone_number: "11900000001" }),
      lead("L00", "2026-10-14T10:00:00+0000", { full_name: "Recente", phone_number: "11900000002" }),
    ];
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:00:00Z"))).toEqual({ created: 1, forms: 2 });
    expect((await db.lead.findMany()).map((l) => l.name)).toEqual(["Recente"]);
    const state = (await db.setting.findUniqueOrThrow({ where: { key: "meta_leads" } })).value as { names: Record<string, unknown> };
    expect(state.names).toEqual({
      f1: { name: "Franquia Banneg", page: "Banneg", funnel: "franquias" },
      f2: { name: "Cotação seguro auto", page: "Banneg", funnel: "produtos" },
    });

    leadsByForm.f1 = [lead("L1", "2026-10-15T13:01:00+0000", { full_name: "Ana Souza", phone_number: "+55 11 98888-7777", cidade: "Campinas" })];
    leadsByForm.f2 = [lead("L2", "2026-10-15T13:01:30+0000", { full_name: "Caio Reis", email: "caio@x.com", "qual_seguro?": "Auto" }, "ig")];
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:02:00Z"))).toEqual({ created: 2, forms: 2 });

    const ana = await db.lead.findFirstOrThrow({ where: { name: "Ana Souza" }, include: { stage: true } });
    expect(ana).toMatchObject({ pipelineId: franchise.id, phone: "5511988887777", source: "Facebook", city: "Campinas", campaign: "Campanha X" });
    const caio = await db.lead.findFirstOrThrow({ where: { name: "Caio Reis" }, include: { stage: true, pipeline: true } });
    expect(caio).toMatchObject({ source: "Instagram", email: "caio@x.com" });
    // A product form lead skips the queue and is served right away
    expect(caio.pipeline.slug).toBe("produtos");
    expect(caio.stage.key).toBe("novo");
    expect(caio.qualification).toMatchObject({ "qual seguro": "Auto", formulario: "Cotação seguro auto" });

    // The same leads come back in the overlap: nothing is created twice
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:04:00Z"))).toEqual({ created: 0, forms: 2 });
    expect(await db.lead.count()).toBe(3);
  });

  it("the daily check lists the form leads that never got here, and brings them on request", async () => {
    await metaLeads.pullMetaLeads(at("2026-10-15T13:00:00Z"));
    // Already here from the old CRM's export, under the number without the 9
    await db.lead.create({ data: { name: "Importada", phone: "551188887777", pipelineId: franchise.id, stageId: (await db.stage.findFirstOrThrow({ where: { pipelineId: franchise.id } })).id } });
    leadsByForm.f1 = [
      lead("L5", "2026-10-02T10:00:00+0000", { full_name: "Perdida", phone_number: "11977776666" }),
      lead("L6", "2026-10-03T10:00:00+0000", { full_name: "Importada", phone_number: "+55 11 98888-7777" }),
      lead("L7", "2026-10-04T10:00:00+0000", { full_name: "Sem contato" }),
      lead("L8", "2026-09-01T10:00:00+0000", { full_name: "Antiga demais", phone_number: "11966665555" }),
    ];
    const audit = await metaLeads.auditMetaLeads(at("2026-10-15T14:00:00Z"));
    expect(audit).toMatchObject({ total: 3, noContact: 1, error: null });
    expect(audit.missing).toEqual([expect.objectContaining({ id: "L5", form: "Franquia Banneg", name: "Perdida" })]);
    // Not again within 12 hours
    expect(await metaLeads.auditMetaLeadsIfDue(at("2026-10-15T20:00:00Z"))).toBeNull();

    const { created, audit: after } = await metaLeads.bringMissingMetaLeads(at("2026-10-15T14:05:00Z"));
    expect(created).toBe(1);
    expect(after?.missing).toEqual([]);
    const brought = await db.lead.findFirstOrThrow({ where: { name: "Perdida" }, include: { pipeline: true } });
    expect(brought).toMatchObject({ externalId: "meta:L5", source: "Facebook", phone: "5511977776666" });
    expect(brought.pipeline.slug).toBe("franquias");
  });

  it("without permission it says why and waits 30 minutes before trying again", async () => {
    failWith = { code: 200, message: "(#200) Requires leads_retrieval permission" };
    const first = await metaLeads.pullMetaLeads(at("2026-10-15T13:00:00Z"));
    expect(first).toMatchObject({ error: expect.stringContaining("não tem permissão") });
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:10:00Z"))).toMatchObject({ skipped: expect.stringContaining("leads_retrieval") });
    failWith = null;
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:31:00Z"))).toEqual({ created: 0, forms: 2 });
  });

  it("a successful check from the screen lets the next tick read right away", async () => {
    failWith = { code: 200, message: "(#200) Requires leads_retrieval permission" };
    await metaLeads.pullMetaLeads(at("2026-10-15T13:00:00Z"));
    failWith = null;
    await metaLeads.retryMetaLeadsNow();
    expect(await metaLeads.pullMetaLeads(at("2026-10-15T13:02:00Z"))).toEqual({ created: 0, forms: 2 });
  });
});
