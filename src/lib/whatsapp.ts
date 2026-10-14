import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "./db";

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta errors that mean the whole account is blocked, not this one message.
// These go to a red banner on every screen instead of hiding inside a conversation.
const ACCOUNT_ERRORS: Record<number, string> = {
  131042: "Pagamento pendente na conta do WhatsApp Business. Regularize em business.facebook.com > Faturamento.",
  131031: "A conta do WhatsApp Business foi bloqueada pela Meta.",
  190: "O token de acesso do WhatsApp expirou. Gere um novo token permanente no Meta Business.",
  131056: "Muitas mensagens para o mesmo número em pouco tempo. Aguarde alguns minutos.",
  130429: "Limite de envio da Meta atingido. As mensagens serão reenviadas automaticamente.",
};

export type SendResult = { ok: true; id: string } | { ok: false; code?: number; error: string; accountLevel: boolean };

export function isWindowOpen(lastInboundAt: Date | null | undefined, now = new Date()) {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

export function normalizePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  // Brazilian numbers without country code
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

export function classifyError(code: number | undefined, message: string) {
  const accountMessage = code !== undefined ? ACCOUNT_ERRORS[code] : undefined;
  return { accountLevel: !!accountMessage, friendly: accountMessage ?? message };
}

async function post(body: Record<string, unknown>): Promise<SendResult> {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!phoneId || !token) return { ok: false, error: "WhatsApp não configurado (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TOKEN).", accountLevel: true };
  const res = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id: string }[];
    error?: { code?: number; message?: string };
  };
  if (res.ok && json.messages?.[0]?.id) {
    await setHealth(null);
    return { ok: true, id: json.messages[0].id };
  }
  const code = json.error?.code;
  const { accountLevel, friendly } = classifyError(code, json.error?.message ?? `HTTP ${res.status}`);
  if (accountLevel) await setHealth({ code, message: friendly });
  return { ok: false, code, error: friendly, accountLevel };
}

export function sendText(to: string, body: string) {
  return post({ to, type: "text", text: { body, preview_url: true } });
}

export function sendTemplate(to: string, name: string, language: string, params: string[]) {
  return post({
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
    },
  });
}

export type WhatsAppHealth = { code?: number; message: string; at: string } | null;

export async function setHealth(problem: { code?: number; message: string } | null) {
  const value = problem ? { ...problem, at: new Date().toISOString() } : null;
  await db.setting.upsert({
    where: { key: "whatsapp_health" },
    create: { key: "whatsapp_health", value: value ?? {} },
    update: { value: value ?? {} },
  });
}

export async function getHealth(): Promise<WhatsAppHealth> {
  const row = await db.setting.findUnique({ where: { key: "whatsapp_health" } });
  const v = row?.value as { message?: string } | undefined;
  return v?.message ? (row!.value as WhatsAppHealth) : null;
}

export function verifySignature(rawBody: string, header: string | null) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type InboundMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string };
  interactive?: { button_reply?: { title: string }; list_reply?: { title: string } };
};

// Shape of the parts of the Cloud API webhook we use
export type WebhookPayload = {
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: InboundMessage[];
        statuses?: {
          id: string;
          status: "sent" | "delivered" | "read" | "failed";
          errors?: { code: number; title?: string; message?: string }[];
        }[];
      };
    }[];
  }[];
};

export function messageText(m: InboundMessage) {
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    `[${m.type} recebido]`
  );
}
