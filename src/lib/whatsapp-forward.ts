import { db } from "./db";
import { WEBHOOK_URL } from "./integrations";

/**
 * While the old CRM is still in use, every WhatsApp notification this CRM receives is passed on,
 * unchanged and with Meta's signature, to the address set in the Meta app (the old CRM). So the
 * number can point here without the old CRM going quiet.
 */

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
// Marks a copy, so two systems forwarding to each other never bounce a message back and forth
export const FORWARD_HEADER = "x-crm-banneg-copy";
const TTL_MS = 3600_000;

type ForwardState = { url: string | null; at: string; error?: string | null };
let cached: ForwardState | null = null;

async function get<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

/** The webhook address set in the Meta app itself, which the old CRM receives on. */
async function appCallbackUrl() {
  const secret = process.env.WHATSAPP_APP_SECRET;
  const token = process.env.WHATSAPP_TOKEN;
  if (!secret || !token) return null;
  const appId = process.env.META_APP_ID || (await get<{ id: string }>(`${GRAPH}/app`, token)).id;
  const subs = await get<{ data: { object: string; callback_url?: string; active?: boolean }[] }>(`${GRAPH}/${appId}/subscriptions`, `${appId}|${secret}`);
  const url = subs.data.find((s) => s.object === "whatsapp_business_account" && s.active !== false)?.callback_url ?? null;
  return url && url !== WEBHOOK_URL ? url : null;
}

// The owner's switch on Integrações: once only this CRM attends, the old one gets no copy
const COPY_KEY = "whatsapp_copy";

/** Turns the copy to the old CRM off (only this CRM attends) or back on. */
export async function setWhatsAppCopy(off: boolean, by: string) {
  const value = { off, by, at: new Date().toISOString() };
  await db.setting.upsert({ where: { key: COPY_KEY }, create: { key: COPY_KEY, value }, update: { value } });
}

export async function whatsAppCopyOff() {
  const row = await db.setting.findUnique({ where: { key: COPY_KEY } });
  return (row?.value as { off?: boolean } | undefined)?.off === true;
}

/** Where copies go: WHATSAPP_FORWARD_URL when set (empty turns copies off), else the Meta app's own address. */
export async function forwardTarget(now = new Date()): Promise<string | null> {
  const fixed = process.env.WHATSAPP_FORWARD_URL;
  if (fixed !== undefined) return fixed.trim() || null;
  if (await whatsAppCopyOff()) return null;
  if (cached && now.getTime() - Date.parse(cached.at) < TTL_MS) return cached.url;
  const row = await db.setting.findUnique({ where: { key: "whatsapp_forward" } });
  const saved = row?.value as ForwardState | undefined;
  if (saved && now.getTime() - Date.parse(saved.at) < TTL_MS) return (cached = saved).url;
  let state: ForwardState;
  try {
    state = { url: await appCallbackUrl(), at: now.toISOString(), error: null };
  } catch (e) {
    // Meta could not be asked right now: keep sending to the last known address
    state = { url: saved?.url ?? null, at: now.toISOString(), error: (e as Error).message };
  }
  await db.setting.upsert({ where: { key: "whatsapp_forward" }, create: { key: "whatsapp_forward", value: state }, update: { value: state } });
  cached = state;
  return state.url;
}

/** Sends the notification exactly as Meta delivered it. Never throws: the copy must not hold up this CRM. */
export async function forwardCopy(raw: string, headers: Headers) {
  if (headers.get(FORWARD_HEADER)) return { skipped: "copy" as const };
  const url = await forwardTarget().catch(() => null);
  if (!url) return { skipped: "no-target" as const };
  const out: Record<string, string> = { "Content-Type": "application/json", [FORWARD_HEADER]: "1" };
  for (const name of ["x-hub-signature-256", "x-hub-signature"]) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  try {
    const res = await fetch(url, { method: "POST", headers: out, body: raw, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.warn(`Cópia do WhatsApp para o CRM antigo: HTTP ${res.status}`);
    return { status: res.status };
  } catch (e) {
    console.warn(`Cópia do WhatsApp para o CRM antigo falhou: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}

/** For tests: forget the address read from Meta. */
export function resetForwardCache() {
  cached = null;
}
