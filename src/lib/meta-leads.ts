import { db } from "./db";
import { createLead, pipelineByRef } from "./leads";

/**
 * Facebook and Instagram lead forms. The CRM reads new leads straight from each form every few
 * minutes, so the old CRM keeps receiving them too until the team switches over: nothing to cut.
 */

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000;
// A minute of overlap so a lead saved in the same second as the last one read is not lost
const OVERLAP_S = 60;

type Page = { id: string; name: string; access_token?: string };
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
  // Unix seconds of the newest lead read, per form; a form seen for the first time starts from now
  cursors?: Record<string, number>;
  // Leads already read, so the overlap never processes one twice
  seen?: string[];
  // Funnel chosen by hand for a form: { formId: "produtos" }
  forms?: Record<string, string>;
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
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok) {
    const code = json.error?.code;
    const message = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(
      code !== undefined && PERMISSION_CODES.has(code)
        ? `O token da Meta não tem permissão para ler os formulários (${message}). Ele precisa da Página atribuída com acesso a leads e das permissões leads_retrieval e pages_show_list.`
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

/** Reads the new leads of every active form and creates them in the right funnel. Called by the cron. */
export async function pullMetaLeads(now = new Date()) {
  const state = await loadState();
  // While the token lacks permission, try again every 30 minutes instead of on every tick
  if (state.error && state.at && now.getTime() - Date.parse(state.at) < RETRY_AFTER_ERROR_MS) return { skipped: state.error };
  const cursors = { ...state.cursors };
  const seen = new Set(state.seen ?? []);
  let created = 0;
  try {
    const groups = await leadForms();
    for (const { token: pageToken, forms } of groups) {
      for (const form of forms) {
        const since = cursors[form.id];
        if (since === undefined) {
          // Older form leads come in with the exports of the old CRM, into the old-leads queue
          cursors[form.id] = Math.floor(now.getTime() / 1000);
          continue;
        }
        const filtering = encodeURIComponent(JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since - OVERLAP_S }]));
        const { data } = await get<{ data: MetaLead[] }>(
          `${form.id}/leads?fields=id,created_time,field_data,campaign_name,platform&filtering=${filtering}&limit=100`,
          pageToken,
        );
        for (const l of data.sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time))) {
          cursors[form.id] = Math.max(cursors[form.id], Math.floor(Date.parse(l.created_time) / 1000));
          if (seen.has(l.id)) continue;
          seen.add(l.id);
          const fields = mapFields(l.field_data);
          if (!fields.phone && !fields.email) continue;
          const pipeline = await pipelineByRef(state.forms?.[form.id] ?? funnelForForm(form.name));
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
          if (r.created) created++;
        }
      }
    }
    const found = groups.reduce((n, g) => n + g.forms.length, 0);
    await saveState({ ...state, cursors, seen: [...seen].slice(-500), at: now.toISOString(), error: null, found, created: (state.created ?? 0) + created });
    return { created, forms: found };
  } catch (e) {
    const error = (e as Error).message;
    await saveState({ ...state, cursors, seen: [...seen].slice(-500), at: now.toISOString(), error });
    return { error };
  }
}
