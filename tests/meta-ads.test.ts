// What each Meta campaign spent, next to the leads, meetings and sales it brought, per funnel.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.META_LEADS_TOKEN = "t";
delete process.env.META_AD_ACCOUNT_ID;

describe.skipIf(!dbUrl)("ad spend and results", () => {
  let db: typeof import("@/lib/db").db;
  let ads: typeof import("@/lib/meta-ads");
  let report: typeof import("@/lib/campaign-report");
  const urls: string[] = [];
  let failWith: { code: number; message: string } | null = null;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    ads = await import("@/lib/meta-ads");
    report = await import("@/lib/campaign-report");
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (failWith) return json({ error: failWith }, 400);
      if (url.includes("/me/adaccounts")) return json({ data: [{ id: "act_1", name: "Banneg Ads" }] });
      if (url.includes("page=2"))
        return json({
          data: [{ campaign_id: "c2", campaign_name: "Telemedicina Out", spend: "50.50", impressions: "900", clicks: "20", date_start: "2026-10-14" }],
        });
      if (url.includes("/act_1/insights"))
        return json({
          data: [
            {
              campaign_id: "c1",
              campaign_name: "Franquia R$19.900",
              spend: "120.00",
              impressions: "5000",
              clicks: "80",
              actions: [{ action_type: "lead", value: "6" }],
              date_start: "2026-10-14",
            },
            { campaign_id: "c1", campaign_name: "Franquia R$19.900", spend: "80.00", date_start: "2026-10-15" },
          ],
          paging: { next: "https://graph.facebook.com/v21.0/act_1/insights?page=2" },
        });
      return json({});
    });
  });

  beforeEach(async () => {
    urls.length = 0;
    failWith = null;
    await db.$executeRawUnsafe('TRUNCATE "AdSpend","Job","LeadEvent","Message","Meeting","Task","Lead","Stage","Pipeline","Setting" CASCADE');
  });

  it("reads 90 days the first time, then refreshes the last days, following Meta's pages", async () => {
    const now = new Date("2026-10-15T15:00:00Z");
    expect(await ads.syncAdSpend(now)).toEqual({ accounts: 1, rows: 3 });
    expect(decodeURIComponent(urls.find((u) => u.includes("/act_1/insights"))!)).toContain('"since":"2026-07-17","until":"2026-10-15"');
    const rows = await db.adSpend.findMany({ orderBy: { id: "asc" } });
    expect(rows.map((r) => [r.id, r.spend, r.metaLeads])).toEqual([
      ["2026-10-14:c1", 120, 6],
      ["2026-10-14:c2", 50.5, 0],
      ["2026-10-15:c1", 80, 0],
    ]);

    urls.length = 0;
    await ads.syncAdSpend(now);
    expect(decodeURIComponent(urls.find((u) => u.includes("/act_1/insights"))!)).toContain('"since":"2026-10-12"');
    expect(await db.adSpend.count()).toBe(3);
  });

  it("without ads_read it says what to do", async () => {
    failWith = { code: 200, message: "(#200) Missing ads_read" };
    expect(await ads.syncAdSpend()).toMatchObject({ error: expect.stringContaining("ads_read") });
    const state = (await db.setting.findUniqueOrThrow({ where: { key: "meta_ads" } })).value as { error: string };
    expect(state.error).toContain("não tem permissão");
  });

  it("puts a cost on each lead and sale, per campaign and per funnel", async () => {
    await ads.syncAdSpend(new Date("2026-10-15T15:00:00Z"));
    const franquias = await db.pipeline.create({ data: { name: "Vendas de Franquias", slug: "franquias" } });
    const tele = await db.pipeline.create({ data: { name: "Telemedicina", slug: "telemedicina" } });
    const fs = await db.stage.create({ data: { pipelineId: franquias.id, name: "Novo", position: 0 } });
    const ts = await db.stage.create({ data: { pipelineId: tele.id, name: "Novo", position: 0 } });
    const at = new Date("2026-10-14T12:00:00Z");
    const lead = (n: number, campaign: string, stageId: string, pipelineId: string, extra = {}) =>
      db.lead.create({ data: { name: `L${n}`, phone: `55119000000${n}`, source: "Facebook", campaign, stageId, pipelineId, createdAt: at, ...extra } });
    await lead(1, "Franquia R$19.900", fs.id, franquias.id, { status: "WON", value: 19900 });
    await lead(2, "Franquia R$19.900", fs.id, franquias.id, { status: "QUALIFIED" });
    await lead(3, "Franquia R$19.900", fs.id, franquias.id);
    await lead(4, "Franquia R$19.900", fs.id, franquias.id);
    await lead(5, "Telemedicina Out", ts.id, tele.id);

    const r = await report.campaignReport(new Date("2026-10-01T00:00:00Z"));
    expect(r.hasSpend).toBe(true);
    expect(r.campaigns).toEqual([
      { campaign: "Franquia R$19.900", funnel: "Vendas de Franquias", spend: 200, metaLeads: 6, leads: 4, qualified: 2, meetings: 0, won: 1, revenue: 19900 },
      { campaign: "Telemedicina Out", funnel: "Telemedicina", spend: 50.5, metaLeads: 0, leads: 1, qualified: 0, meetings: 0, won: 0, revenue: 0 },
    ]);
    expect(r.funnels.map((f) => [f.funnel, f.spend, f.leads, f.won])).toEqual([
      ["Vendas de Franquias", 200, 4, 1],
      ["Telemedicina", 50.5, 1, 0],
    ]);
  });
});
