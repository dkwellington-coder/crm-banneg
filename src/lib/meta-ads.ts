import { db } from "./db";

/**
 * What the Meta ad accounts spent per campaign and day. Leads carry the campaign name, so the CRM
 * can put a cost on each lead, meeting and sale, per campaign and per funnel.
 */

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
// The first read brings this much history; later reads refresh the last few days, which Meta still adjusts
const BACKFILL_DAYS = 90;
const REFRESH_DAYS = 3;

type Account = { id: string; name: string; account_status?: number; currency?: string };
type InsightRow = {
  campaign_id: string;
  campaign_name: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type: string; value: string }[];
  date_start: string;
};

export type MetaAdsState = {
  at?: string;
  error?: string | null;
  accounts?: { id: string; name: string }[];
  // Day the history was first read, so later reads only refresh the last days
  backfilledAt?: string;
};

// The leads token reads the ads too once it has ads_read and the ad account assigned
function token() {
  return process.env.META_ADS_TOKEN || process.env.META_LEADS_TOKEN || process.env.WHATSAPP_TOKEN;
}

const PERMISSION_CODES = new Set([10, 100, 190, 200, 210, 230, 272, 278]);

async function get<T>(pathOrUrl: string, accessToken: string): Promise<T> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}/${pathOrUrl}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const code = json.error?.code;
    const message = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(
      code !== undefined && PERMISSION_CODES.has(code)
        ? `O token da Meta não tem permissão para ler os anúncios (${message}). Atribua a conta de anúncios ao usuário do sistema e gere o token com ads_read.`
        : message,
    );
  }
  return json;
}

/** The ad accounts this token reaches: META_AD_ACCOUNT_ID when set (comma separated), else every assigned one. */
export async function adAccounts(): Promise<Account[]> {
  const t = token();
  if (!t) throw new Error("Falta o token da Meta (META_LEADS_TOKEN).");
  const ids = (process.env.META_AD_ACCOUNT_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const accounts = ids.length
    ? await Promise.all(ids.map((id) => get<Account>(`${id.startsWith("act_") ? id : `act_${id}`}?fields=id,name,account_status,currency`, t)))
    : (await get<{ data: Account[] }>("me/adaccounts?fields=id,name,account_status,currency&limit=50", t)).data;
  if (!accounts.length) throw new Error("Nenhuma conta de anúncios ligada a este token. Atribua a conta de anúncios do Banneg ao usuário do sistema no Meta Business.");
  return accounts;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function leadsOf(row: InsightRow) {
  // "lead" already adds up form and site leads; the others are fallbacks for accounts that report only those
  for (const type of ["lead", "onsite_conversion.lead_grouped", "leadgen_grouped"]) {
    const a = row.actions?.find((x) => x.action_type === type);
    if (a) return Math.round(Number(a.value) || 0);
  }
  return 0;
}

/** Reads spend per campaign and day from every ad account into AdSpend. Called by the cron. */
export async function syncAdSpend(now = new Date()) {
  const row = await db.setting.findUnique({ where: { key: "meta_ads" } });
  const state = (row?.value as MetaAdsState | undefined) ?? {};
  const save = (value: MetaAdsState) => db.setting.upsert({ where: { key: "meta_ads" }, create: { key: "meta_ads", value }, update: { value } });
  try {
    const t = token()!;
    const accounts = await adAccounts();
    const since = new Date(now.getTime() - (state.backfilledAt ? REFRESH_DAYS : BACKFILL_DAYS) * 86_400_000);
    const range = encodeURIComponent(JSON.stringify({ since: day(since), until: day(now) }));
    let rows = 0;
    for (const account of accounts) {
      let next: string | undefined =
        `${account.id}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_increment=1&time_range=${range}&limit=500`;
      while (next) {
        const page: { data: InsightRow[]; paging?: { next?: string } } = await get(next, t);
        for (const r of page.data) {
          const data = {
            date: new Date(`${r.date_start}T00:00:00Z`),
            accountId: account.id,
            campaignId: r.campaign_id,
            campaignName: r.campaign_name,
            spend: Number(r.spend) || 0,
            impressions: Number(r.impressions) || 0,
            clicks: Number(r.clicks) || 0,
            metaLeads: leadsOf(r),
          };
          const id = `${r.date_start}:${r.campaign_id}`;
          await db.adSpend.upsert({ where: { id }, create: { id, ...data }, update: data });
          rows++;
        }
        next = page.paging?.next;
      }
    }
    await save({
      at: now.toISOString(),
      error: null,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      backfilledAt: state.backfilledAt ?? now.toISOString(),
    });
    return { accounts: accounts.length, rows };
  } catch (e) {
    const error = (e as Error).message;
    await save({ ...state, at: now.toISOString(), error });
    return { error };
  }
}
