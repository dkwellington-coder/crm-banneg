import { db } from "./db";
import { createLead, pipelineByRef } from "./leads";
import { normalizePhone, phoneVariants } from "./whatsapp";

/**
 * Facebook and Instagram lead forms. The CRM reads new leads straight from each form every few
 * minutes, and once a day checks the last 30 days of every form for a lead that never got here.
 */

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000;
// A minute of overlap so a lead saved in the same second as the last one read is not lost
const OVERLAP_S = 60;
// A form seen for the first time (a new campaign) is read from 3 days back, so its first leads count too
const NEW_FORM_BACKFILL_S = 3 * 86_400;
// The daily check: how far back, and how often
export const AUDIT_DAYS = 30;
const AUDIT_EVERY_MS = 12 * 3600_000;
const LEAD_FIELDS = "id,created_time,field_data,campaign_name,platform";

type Page = { id: string; name: string; access_token?: string };
type Paged<T> = { data: T[]; paging?: { next?: string } };
type Form = { id: string; name: string; status: string };
type MetaLead = {
  id: string;
  created_time: string;
  field_data?: { name: string; values?: string[] }[];
  campaign_name?: string;
  platform?: string;
};
export type FormGroup = { page: Page; token: string; forms: Form[] };

type MetaLeadsState = {
  // Unix seconds of the newest lead read, per form; a form seen for the first time starts 3 days back
  cursors?: Record<string, number>;
  // Leads already read, so the overlap never processes one twice
  seen?: string[];
  // Funnel chosen by hand for a form: { formId: "produtos" }
  forms?: Record<string, string>;
  // The active forms as last read, with the funnel each one feeds (null = the default funnel)
  names?: Record<string, { name: string; page: string; funnel: string | null }>;
  at?: string;
  error?: string | null;
  found?: number;
  created?: number;
};

// A system-user token with leads_retrieval and the Page assigned; the WhatsApp one works when it has those permissions
function token() {
  return process.env.META_LEADS_TOKEN || process.env.WHATSAPP_TOKEN;
}

const PERMISSION_CODES = new Set([10, 100, 190, 200, 210, 230]);

async function get<T>(path: string, accessToken: string): Promise<T> {
  // A "next page" link from Meta comes whole
  const url = path.startsWith("https://") ? path : `${GRAPH}/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const code = json.error?.code;
    const message = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(
      code !== undefined && PERMISSION_CODES.has(code)
        ? `O token da Meta não tem permissão para ler os formulários (${message}). Ele precisa da Página atribuída e das permissões leads_retrieval, pages_show_list, pages_read_engagement e pages_manage_ads.`
        : message,
    );
  }
  return json;
}

/** The Pages this token reaches and their active lead forms. */
export async function leadForms(): Promise<FormGroup[]> {
  const t = token();
  if (!t) throw new Error("Falta o token da Meta (META_LEADS_TOKEN ou WHATSAPP_TOKEN).");
  const pageId = process.env.META_PAGE_ID;
  const pages = pageId
    ? [await get<Page>(`${pageId}?fields=id,name,access_token`, t)]
    : (await get<{ data: Page[] }>("me/accounts?fields=id,name,access_token&limit=50", t)).data;
  if (!pages.length) throw new Error("Nenhuma Página do Facebook ligada a este token. Atribua a Página do Banneg ao usuário do sistema no Meta Business.");
  const groups: FormGroup[] = [];
  for (const page of pages) {
    const pageToken = page.access_token ?? t;
    const forms = (await get<{ data: Form[] }>(`${page.id}/leadgen_forms?fields=id,name,status&limit=100`, pageToken)).data;
    groups.push({ page, token: pageToken, forms: forms.filter((f) => f.status === "ACTIVE") });
  }
  return groups;
}

/** Which funnel a form feeds, from its name: product quotes or the franchise (the default). */
export function funnelForForm(formName: string) {
  const n = formName.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/franquia|franqueado|expansao|seja (um )?socio|abra (seu|sua)/.test(n)) return "franquias";
  if (/sindicat|sincomercio/.test(n)) return "sindicatos";
  if (/seguro|cotacao|consorcio|saude|odonto|plano|vida|auto|residencial|solar|energia|produto/.test(n)) return "produtos";
  return null;
}

/** The form's answers as lead fields; questions the CRM has no field for go to the AI as qualification. */
export function mapFields(fieldData: MetaLead["field_data"] = []) {
  const out: { name?: string; phone?: string; email?: string; city?: string; state?: string; qualification: Record<string, string> } = { qualification: {} };
  let first = "";
  let last = "";
  for (const f of fieldData) {
    const value = (f.values ?? []).join(", ").trim();
    if (!value) continue;
    const key = f.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (key === "full_name" || key === "nome" || key === "nome_completo") out.name = value;
    else if (key === "first_name") first = value;
    else if (key === "last_name") last = value;
    else if (key === "email" || key === "e-mail") out.email = value;
    else if (/phone|telefone|whatsapp|celular/.test(key)) out.phone ??= value;
    else if (key === "city" || key === "cidade") out.city = value;
    else if (key === "state" || key === "estado" || key === "province") out.state = value;
    else out.qualification[f.name.replace(/_/g, " ").replace(/\?$/, "").slice(0, 120)] = value.slice(0, 500);
  }
  if (!out.name && (first || last)) out.name = `${first} ${last}`.trim();
  return out;
}

async function loadState(): Promise<MetaLeadsState> {
  const row = await db.setting.findUnique({ where: { key: "meta_leads" } });
  return (row?.value as MetaLeadsState | undefined) ?? {};
}

async function saveState(value: MetaLeadsState) {
  await db.setting.upsert({ where: { key: "meta_leads" }, create: { key: "meta_leads", value }, update: { value } });
}

/** After a successful check from the screen, the next tick reads the forms without waiting out the retry. */
export async function retryMetaLeadsNow() {
  const state = await loadState();
  if (state.error) await saveState({ ...state, error: null });
}

/** The form's leads created after a moment (Unix seconds), every page of them. */
async function formLeads(formId: string, after: number, pageToken: string, maxPages = 20) {
  const filtering = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: after }]));
  let next: string | undefined = `${formId}/leads?fields=${LEAD_FIELDS}&filtering=${filtering}&limit=100`;
  const out: MetaLead[] = [];
  for (let page = 0; next && page < maxPages; page++) {
    const res: Paged<MetaLead> = await get<Paged<MetaLead>>(next, pageToken);
    out.push(...res.data);
    next = res.data.length ? res.paging?.next : undefined;
  }
  return out;
}

/** Creates the form lead in its funnel; false when it has no contact or is already here (same phone). */
async function bringLead(l: MetaLead, form: Form, funnel: string | null) {
  const fields = mapFields(l.field_data);
  if (!fields.phone && !fields.email) return false;
  const pipeline = await pipelineByRef(funnel);
  const r = await createLead(
    {
      name: fields.name,
      phone: fields.phone,
      email: fields.email,
      city: fields.city,
      state: fields.state,
      source: l.platform === "ig" ? "Instagram" : "Facebook",
      campaign: l.campaign_name || form.name,
      externalId: `meta:${l.id}`,
      pipelineId: pipeline?.id,
      qualification: { ...fields.qualification, formulario: form.name },
      createdAt: new Date(l.created_time),
    },
    "Formulário da Meta",
  );
  return r.created;
}

/** Is this form lead in the CRM: by its Meta id, its phone (with or without the 9) or its e-mail. */
async function inCrm(l: MetaLead) {
  if (await db.lead.findFirst({ where: { externalId: `meta:${l.id}` }, select: { id: true } })) return true;
  const fields = mapFields(l.field_data);
  const phone = fields.phone ? normalizePhone(fields.phone) : "";
  if (phone && (await db.lead.findFirst({ where: { phone: { in: phoneVariants(phone) } }, select: { id: true } }))) return true;
  const email = fields.email?.trim().toLowerCase();
  return !!email && !!(await db.lead.findFirst({ where: { email }, select: { id: true } }));
}

export type MissingLead = { id: string; formId: string; form: string; pageId: string; at: string; name: string | null };
export type MetaLeadsAudit = { at: string; days: number; total: number; noContact: number; missing: MissingLead[]; error?: string | null };
const AUDIT_KEY = "meta_leads_audit";

export async function lastMetaLeadsAudit() {
  return (await db.setting.findUnique({ where: { key: AUDIT_KEY } }))?.value as MetaLeadsAudit | undefined;
}

/**
 * Every lead the active forms got in the last 30 days, checked against the CRM: the ones that never
 * got here (a form first read late, a lead the old CRM got alone) are listed on Integrações.
 */
export async function auditMetaLeads(now = new Date(), days = AUDIT_DAYS): Promise<MetaLeadsAudit> {
  let audit: MetaLeadsAudit;
  try {
    const after = Math.floor(now.getTime() / 1000) - days * 86_400;
    const missing: MissingLead[] = [];
    let total = 0;
    let noContact = 0;
    for (const { page, token: pageToken, forms } of await leadForms()) {
      for (const form of forms) {
        for (const l of await formLeads(form.id, after, pageToken)) {
          total++;
          const fields = mapFields(l.field_data);
          if (!fields.phone && !fields.email) noContact++;
          else if (!(await inCrm(l))) missing.push({ id: l.id, formId: form.id, form: form.name, pageId: page.id, at: l.created_time, name: fields.name ?? null });
        }
      }
    }
    missing.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    audit = { at: now.toISOString(), days, total, noContact, missing: missing.slice(0, 300), error: null };
  } catch (e) {
    audit = { ...((await lastMetaLeadsAudit()) ?? { days, total: 0, noContact: 0, missing: [] }), at: now.toISOString(), error: (e as Error).message };
  }
  await db.setting.upsert({ where: { key: AUDIT_KEY }, create: { key: AUDIT_KEY, value: audit }, update: { value: audit } });
  return audit;
}

/** The daily check, run by the cron: twice a day at most. */
export async function auditMetaLeadsIfDue(now = new Date()) {
  const last = await lastMetaLeadsAudit();
  if (last?.at && now.getTime() - Date.parse(last.at) < AUDIT_EVERY_MS) return null;
  return auditMetaLeads(now);
}

/** Brings the leads the check found missing into their funnels, as new leads, then checks again. */
export async function bringMissingMetaLeads(now = new Date()) {
  const audit = await lastMetaLeadsAudit();
  if (!audit?.missing.length) return { created: 0, audit };
  const state = await loadState();
  const groups = await leadForms();
  let created = 0;
  for (const m of audit.missing) {
    const group = groups.find((g) => g.page.id === m.pageId);
    const form = group?.forms.find((f) => f.id === m.formId);
    if (!group || !form) continue;
    const l = await get<MetaLead>(`${m.id}?fields=${LEAD_FIELDS}`, group.token);
    if (await inCrm(l)) continue;
    if (await bringLead(l, form, state.forms?.[form.id] ?? funnelForForm(form.name))) created++;
  }
  return { created, audit: await auditMetaLeads(now) };
}

/** Reads the new leads of every active form and creates them in the right funnel. Called by the cron. */
export async function pullMetaLeads(now = new Date()) {
  const state = await loadState();
  // While the token lacks permission, try again every 30 minutes instead of on every tick
  if (state.error && state.at && now.getTime() - Date.parse(state.at) < RETRY_AFTER_ERROR_MS) return { skipped: state.error };
  const cursors = { ...state.cursors };
  const seen = new Set(state.seen ?? []);
  const names: NonNullable<MetaLeadsState["names"]> = {};
  let created = 0;
  try {
    const groups = await leadForms();
    for (const { page, token: pageToken, forms } of groups) {
      for (const form of forms) {
        const funnel = state.forms?.[form.id] ?? funnelForForm(form.name);
        names[form.id] = { name: form.name, page: page.name, funnel };
        const since = (cursors[form.id] ??= Math.floor(now.getTime() / 1000) - NEW_FORM_BACKFILL_S);
        const data = await formLeads(form.id, since - OVERLAP_S, pageToken);
        for (const l of data.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time))) {
          cursors[form.id] = Math.max(cursors[form.id], Math.floor(Date.parse(l.created_time) / 1000));
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          if (await bringLead(l, form, funnel)) created++;
        }
      }
    }
    const found = groups.reduce((n, g) => n + g.forms.length, 0);
    await saveState({ ...state, cursors, names, seen: [...seen].slice(-500), at: now.toISOString(), error: null, found, created: (state.created ?? 0) + created });
    return { created, forms: found };
  } catch (e) {
    const error = (e as Error).message;
    await saveState({ ...state, cursors, seen: [...seen].slice(-500), at: now.toISOString(), error });
    return { error };
  }
}
