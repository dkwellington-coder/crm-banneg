import { db } from "./db";
import { sendEmail } from "./email";
import { CRM_URL, phoneLabel } from "./calendar";
import { sendTemplate, sendText } from "./whatsapp";
import { teamSender, uazapi } from "./team-alert";
import { getSettings } from "./settings";

/**
 * The number posting the meetings in the team's group (Wellington's own WhatsApp: connected in the CRM on Banneg's own
 * server since 2026-11-23, on Uazapi before; see lib/team-alert teamSender). When WhatsApp drops that session
 * nothing says so: the notices just stop. Wellington (2026-11-19): "sempre que desconectar me avise na hora". The cron asks
 * the instance every minute; two bad answers in a row (about 2 minutes, so a blip does not wake anyone) and the CRM:
 * shows a red banner on every screen, e-mails the owner and writes to the number itself from the official WhatsApp.
 * When it comes back, the banner goes and a short "voltou" follows the same way.
 */
const KEY = "uazapi_health";
// Bad answers in a row before warning: the cron runs every minute
export const BAD_CHECKS = 2;
/** How to connect again, by where the number is connected. */
const howToReconnect = (sender: "suporte" | "uazapi") =>
  sender === "suporte"
    ? `Para reconectar: abra ${CRM_URL}/integracoes#uazapi, clique em "Ler o QR code" e aponte o celular (WhatsApp > Aparelhos conectados > Conectar um aparelho).`
    : `Para reconectar: abra ${process.env.UAZAPI_URL?.trim().replace(/\/+$/, "") || "o painel da Uazapi"}, entre na instância e leia o QR code no celular (WhatsApp > Aparelhos conectados > Conectar um aparelho).`;

/** Out of the 24 h window the warning goes as this template (approved by Meta: the cron sends new templates for review). */
export const UAZAPI_TEMPLATE = {
  name: "banneg_aviso_whatsapp_grupo_desconectado",
  category: "UTILITY",
  purpose: "group_sender_alert",
  body: "Aviso do CRM Banneg: o WhatsApp {{1}}, que manda as reuniões no grupo da equipe, desconectou às {{2}}. Enquanto estiver desconectado, os avisos de reunião não chegam ao grupo. Para reconectar, abra o CRM em Integrações e leia o QR code de novo.",
} as const;

export type UazapiHealth = {
  ok: boolean;
  // Where the number is connected: the CRM's own server or Uazapi (a switch starts a new record)
  sender?: "suporte" | "uazapi";
  // A number just created in the CRM and never connected yet: no warning, no banner
  waiting?: boolean;
  // What Uazapi says (connected, disconnected, connecting) or "sem resposta"
  status: string;
  message?: string;
  // The connected number (55DDD...), kept from the last good answer
  phone?: string;
  // Since when it is in this state
  since: string;
  checkedAt: string;
  // Bad answers in a row
  bad?: number;
  // When the owner was warned about this disconnection, and how it went
  alertedAt?: string;
  alert?: string[];
};

type RawStatus = {
  instance?: { status?: string; owner?: string; profileName?: string; lastDisconnectReason?: string };
  status?: { connected?: boolean; loggedIn?: boolean; jid?: string | null } | string;
  connected?: boolean;
};

/** Reads Uazapi's answer: connected or not, and the number when it says it. */
export function readStatus(raw: RawStatus): { connected: boolean; status: string; phone?: string; reason?: string } {
  const word = (raw.instance?.status ?? (typeof raw.status === "string" ? raw.status : "") ?? "").toLowerCase();
  const flags = typeof raw.status === "object" && raw.status ? raw.status : undefined;
  const connected =
    flags?.connected === false || flags?.loggedIn === false
      ? false
      : ["connected", "open"].includes(word) || flags?.connected === true || raw.connected === true;
  const jid = raw.instance?.owner || (flags?.jid ?? "");
  const digits = jid.split(/[@:]/)[0].replace(/\D/g, "");
  return {
    connected,
    status: word || (connected ? "connected" : "disconnected"),
    ...(digits.length >= 12 && { phone: digits }),
    ...(raw.instance?.lastDisconnectReason && { reason: raw.instance.lastDisconnectReason }),
  };
}

export async function getUazapiHealth(): Promise<UazapiHealth | null> {
  const v = (await db.setting.findUnique({ where: { key: KEY } }))?.value as UazapiHealth | undefined;
  return v?.checkedAt ? v : null;
}

/** For the banner: only once the warning threshold is reached. */
export async function uazapiDown() {
  const h = await getUazapiHealth();
  return h && !h.ok && !h.waiting && (h.bad ?? 0) >= BAD_CHECKS ? h : null;
}

const clock = (d: Date) => d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const day = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

/** The template exists in the CRM (as a draft the cron sends to Meta), so the warning also reaches him out of the window. */
async function ensureTemplate() {
  await db.whatsAppTemplate.upsert({
    where: { name: UAZAPI_TEMPLATE.name },
    create: { ...UAZAPI_TEMPLATE, status: "draft", active: false },
    update: {},
  });
}

/** Who is warned: the owner's e-mail, and the number itself (or the owner's phone) on the official WhatsApp. */
async function warn(subject: string, body: string, phone: string | undefined, template?: string[]) {
  const done: string[] = [];
  const owners = await db.user.findMany({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" }, select: { email: true, phone: true } });
  for (const o of owners) {
    try {
      await sendEmail(o.email, subject, body);
      done.push(`e-mail para ${o.email}`);
    } catch (e) {
      done.push(`e-mail para ${o.email} falhou: ${(e as Error).message}`);
    }
  }
  const to = (phone ?? owners.find((o) => o.phone)?.phone ?? "").replace(/\D/g, "");
  if (to.length >= 12 && process.env.WHATSAPP_TOKEN) {
    const text = await sendText(to, body);
    if (text.ok) done.push(`WhatsApp para ${phoneLabel(to)}`);
    else {
      // Out of the 24 h window: the approved template, when there is one
      const t = template && (await db.whatsAppTemplate.findFirst({ where: { name: UAZAPI_TEMPLATE.name, active: true } }));
      const res = t && template ? await sendTemplate(to, t.name, t.language, template) : null;
      done.push(res?.ok ? `WhatsApp (modelo) para ${phoneLabel(to)}` : `WhatsApp para ${phoneLabel(to)} falhou: ${res?.error ?? text.error}`);
    }
  }
  return done;
}

/** One check (the cron, every minute). Returns what it saw, or null when no number is set up to post in the group. */
export async function checkUazapi(now = new Date()): Promise<UazapiHealth | null> {
  const settings = await getSettings();
  const kind = teamSender(settings)?.kind;
  if (!kind) return null;
  await ensureTemplate();
  const saved = await getUazapiHealth();
  // Switched from Uazapi to the CRM's own server (or back): what was known of the other one does not count
  const prev = saved && (saved.sender ?? "uazapi") === kind ? saved : null;
  // The number created in the CRM that was never connected: he is still reading the QR code
  const waiting = kind === "suporte" && !settings.meetingSender?.phone;
  const where = kind === "uazapi" ? " da Uazapi" : "";
  const source = kind === "uazapi" ? "A Uazapi" : "O servidor do WhatsApp";
  let seen: ReturnType<typeof readStatus>;
  let message: string | undefined;
  try {
    seen = readStatus(await uazapi<RawStatus>("/instance/status", undefined, settings));
  } catch (e) {
    seen = { connected: false, status: "sem resposta" };
    message = (e as Error).message;
  }
  const phone = seen.phone ?? prev?.phone;
  const at = now.toISOString();
  let next: UazapiHealth;
  if (seen.connected) {
    next = { ok: true, sender: kind, status: seen.status, ...(phone && { phone }), since: prev?.ok ? prev.since : at, checkedAt: at };
    // It was down and he was told: tell him it is back
    if (prev && !prev.ok && prev.alertedAt) {
      const who = phone ? ` ${phoneLabel(phone)}` : "";
      next.alert = await warn(
        "WhatsApp do grupo de reuniões conectado de novo",
        `Aviso do CRM Banneg: o WhatsApp${who}, que manda as reuniões no grupo da equipe, voltou a ficar conectado às ${clock(now)} (estava desconectado desde ${day(new Date(prev.since))}). Os avisos de reunião voltaram a ir para o grupo.`,
        phone,
      );
    }
  } else {
    const wasBad = prev && !prev.ok;
    const bad = (wasBad ? (prev.bad ?? 0) : 0) + 1;
    next = {
      ok: false,
      sender: kind,
      ...(waiting && { waiting: true }),
      status: seen.status,
      ...((message ?? seen.reason) && { message: message ?? seen.reason }),
      ...(phone && { phone }),
      since: wasBad ? prev.since : at,
      checkedAt: at,
      bad,
      ...(wasBad && prev.alertedAt && { alertedAt: prev.alertedAt, alert: prev.alert }),
    };
    if (bad >= BAD_CHECKS && !next.alertedAt && !waiting) {
      const since = new Date(next.since);
      const who = phone ? phoneLabel(phone) : "do grupo de reuniões";
      const why = message ? `${source} não respondeu (${message}).` : `${source} diz que o número está "${seen.status}".`;
      next.alertedAt = at;
      next.alert = await warn(
        "WhatsApp do grupo de reuniões desconectado",
        [
          `Aviso do CRM Banneg: o WhatsApp ${who}, que manda as reuniões no grupo da equipe, desconectou${where} às ${clock(since)}. ${why}`,
          "Enquanto estiver desconectado, os avisos de reunião e a agenda das 7h não chegam ao grupo da equipe.",
          howToReconnect(kind),
          "Aviso de novo quando voltar.",
        ].join("\n\n"),
        phone,
        [who, clock(since)],
      );
    }
  }
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value: next }, update: { value: next } });
  // In the runtime logs, only when the state changes
  if (!prev || prev.ok !== next.ok || next.alert !== prev.alert)
    console.info(`Grupo de reuniões (${kind}): ${next.ok ? "conectado" : `desconectado (${next.status}${next.message ? `: ${next.message}` : ""})`}${next.alert ? ` · avisos: ${next.alert.join("; ")}` : ""}`);
  return next;
}
