import { db } from "./db";

/**
 * Result and cost per campaign and per funnel: the leads a campaign brought in a period and how
 * far they went, next to what Meta charged for it. Leads are matched to spend by campaign name.
 */

export type CampaignRow = {
  campaign: string;
  // Funnel most of the campaign's leads landed in; null when no lead reached the CRM
  funnel: string | null;
  spend: number;
  metaLeads: number;
  leads: number;
  qualified: number;
  meetings: number;
  won: number;
  revenue: number;
};

export type FunnelRow = Omit<CampaignRow, "campaign" | "metaLeads">;

export async function campaignReport(since: Date) {
  const [leadRows, spendRows] = await Promise.all([
    db.$queryRaw<{ campaign: string; funnel: string; leads: bigint; qualified: bigint; meetings: bigint; won: bigint; revenue: bigint | null }[]>`
      SELECT l.campaign, p.name AS funnel,
        COUNT(*) AS leads,
        COUNT(*) FILTER (WHERE l.status IN ('QUALIFIED','MEETING_BOOKED','HANDED_OFF','WON')) AS qualified,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Meeting" m WHERE m."leadId" = l.id)) AS meetings,
        COUNT(*) FILTER (WHERE l.status = 'WON') AS won,
        SUM(l.value) FILTER (WHERE l.status = 'WON') AS revenue
      FROM "Lead" l JOIN "Pipeline" p ON p.id = l."pipelineId"
      WHERE l."createdAt" >= ${since} AND l.campaign IS NOT NULL AND l.campaign <> ''
      GROUP BY l.campaign, p.name`,
    db.adSpend.groupBy({
      by: ["campaignName"],
      where: { date: { gte: new Date(`${since.toISOString().slice(0, 10)}T00:00:00Z`) } },
      _sum: { spend: true, metaLeads: true },
    }),
  ]);

  const byCampaign = new Map<string, CampaignRow & { funnelLeads: number }>();
  const row = (campaign: string) => {
    let r = byCampaign.get(campaign);
    if (!r) {
      r = { campaign, funnel: null, funnelLeads: 0, spend: 0, metaLeads: 0, leads: 0, qualified: 0, meetings: 0, won: 0, revenue: 0 };
      byCampaign.set(campaign, r);
    }
    return r;
  };
  for (const l of leadRows) {
    const r = row(l.campaign);
    const leads = Number(l.leads);
    r.leads += leads;
    r.qualified += Number(l.qualified);
    r.meetings += Number(l.meetings);
    r.won += Number(l.won);
    r.revenue += Number(l.revenue ?? 0);
    if (leads > r.funnelLeads) {
      r.funnel = l.funnel;
      r.funnelLeads = leads;
    }
  }
  for (const s of spendRows) {
    const r = row(s.campaignName);
    r.spend += s._sum.spend ?? 0;
    r.metaLeads += s._sum.metaLeads ?? 0;
  }

  const campaigns: CampaignRow[] = [...byCampaign.values()]
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ funnelLeads, ...r }) => ({ ...r, spend: Math.round(r.spend * 100) / 100 }))
    .sort((a, b) => b.spend - a.spend || b.leads - a.leads);

  const byFunnel = new Map<string | null, FunnelRow>();
  for (const c of campaigns) {
    const f = byFunnel.get(c.funnel) ?? { funnel: c.funnel, spend: 0, leads: 0, qualified: 0, meetings: 0, won: 0, revenue: 0 };
    f.spend += c.spend;
    f.leads += c.leads;
    f.qualified += c.qualified;
    f.meetings += c.meetings;
    f.won += c.won;
    f.revenue += c.revenue;
    byFunnel.set(c.funnel, f);
  }
  const funnels = [...byFunnel.values()]
    .map((f) => ({ ...f, spend: Math.round(f.spend * 100) / 100 }))
    .sort((a, b) => (a.funnel === null ? 1 : b.funnel === null ? -1 : b.spend - a.spend || b.leads - a.leads));

  return { campaigns, funnels, hasSpend: spendRows.length > 0 };
}
