import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { db } from "./db";
import { logEvent } from "./events";
import { createLead, ensureTask } from "./leads";
import { normalizePhone, savedWhatsAppNumbers } from "./whatsapp";

/**
 * A mailbox that turns e-mails into leads (leads@banneg.com.br): a site form, a partner or anyone who writes there
 * becomes a lead in the funnel chosen on Integrações, and the e-mail stays in the lead's conversation. The CRM reads
 * the box every 2 minutes and never marks anything as read, so the team still sees every e-mail in the webmail.
 */

const RETRY_AFTER_ERROR_MS = 15 * 60 * 1000;
// The first read (or a box the server recreated) brings the last 3 days
const BACKFILL_DAYS = 3;
const MAX_PER_RUN = 40;
// A huge attachment is never needed: the text comes first in the e-mail
const MAX_BYTES = 2_000_000;
const ANSWER_EMAIL_TASK = "Responder e-mail do lead";

export function mailboxUser() {
  return (process.env.LEADS_IMAP_USER || "leads@banneg.com.br").trim().toLowerCase();
}

// preview: the start of an e-mail that had no contact, so a form laid out some new way can be read later
export type EmailLog = { at: string; from: string; subject: string; result: string; leadId?: string; preview?: string };

export type EmailLeadsState = {
  // The box's UIDVALIDITY and the last e-mail read: a new e-mail always has a higher UID
  uidValidity?: string;
  lastUid?: number;
  // Funnel the e-mails go to (null = the default funnel)
  pipelineId?: string | null;
  // Funnel the quote requests go to (the site's quote form): unset = the funnel named "Cotações"; null = the funnel above
  quotePipelineId?: string | null;
  at?: string;
  error?: string | null;
  created?: number;
  // The last e-mails read and what became of each, for Integrações
  log?: EmailLog[];
};

const STATE_KEY = "email_leads";

export async function emailLeadsState(): Promise<EmailLeadsState> {
  return ((await db.setting.findUnique({ where: { key: STATE_KEY } }))?.value as EmailLeadsState | undefined) ?? {};
}

async function saveState(value: EmailLeadsState) {
  const json = JSON.parse(JSON.stringify(value));
  await db.setting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value: json }, update: { value: json } });
}

export async function setEmailLeadsFunnel(pipelineId: string | null, quotePipelineId?: string | null) {
  const state = await emailLeadsState();
  await saveState({ ...state, pipelineId, quotePipelineId: quotePipelineId === undefined ? state.quotePipelineId : quotePipelineId });
}

/** The funnel quote requests go to: the one chosen, else the funnel named "Cotações"; null = the box's own funnel. */
export async function quoteFunnel(state: EmailLeadsState): Promise<{ id: string; name: string } | null> {
  if (state.quotePipelineId === null) return null;
  const pipelines = await db.pipeline.findMany({ select: { id: true, name: true }, orderBy: { position: "asc" } });
  return pipelines.find((p) => p.id === state.quotePipelineId) ?? pipelines.find((p) => QUOTE_FUNNEL.test(p.name)) ?? null;
}

// ---------- Reading one e-mail ----------

// "Cotações/ Seguros e Consórcios"
const QUOTE_FUNNEL = /cota[çc]/i;
// The site's quote form says "Solicitação de cotação"; a person may ask for an "orçamento"
const QUOTE_ASK = /cota[çc](?:[ãa]o|[õo]es)|or[çc]amento/i;

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// A Brazilian phone written any way: +55 (17) 99999-0000, 17 999990000, (061) 9325-8573
const PHONE_RE = /(?<![\d/])(?:\+?\s?55[\s.-]*)?\(?0?[1-9]\d\)?[\s.-]*9?\s?\d{4}[\s.-]?\d{4}(?!\d)/g;
const NO_REPLY = /^(no-?reply|do-?not-?reply|nao-?responda|naoresponda|mailer|wordpress|notifica)/i;
const BOUNCE = /^(mailer-daemon|postmaster|bounce)/i;
const AUTO_SUBJECT =
  /^(\s*(re|res|fw|fwd|enc):\s*)*(undeliver|delivery status|returned mail|mail delivery|falha n[ao] entrega|n[aã]o (foi )?entregue|resposta autom[aá]tica|automatic reply|auto[- ]?reply|ausente|out of office|fora do escrit[oó]rio)/i;
// Where a forwarded e-mail starts (Gmail, Outlook, Apple Mail, in Portuguese and English)
const FORWARD_MARK =
  /^\s*(-{2,}\s*(forwarded message|mensagem encaminhada|original message|mensagem original)\s*-{2,}|begin forwarded message:|in[ií]cio da mensagem encaminhada:)\s*$/im;
// Where the quoted e-mail of a reply starts
const QUOTE_MARK = /^\s*(em .{3,120} escreveu:|on .{3,120} wrote:|-{2,}\s*(original message|mensagem original)\s*-{2,}|_{10,})\s*$/im;

type Fields = {
  name?: string;
  email?: string;
  phone?: string;
  city?: string;
  state?: string;
  qualification: Record<string, string>;
  // How many "Label: value" lines: 3 or more is a form, fewer is a person writing
  lines: number;
};

const clean = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[*_]/g, "")
    .trim();

type Field = "name" | "email" | "phone" | "city" | "state";

function fieldOf(label: string): Field | null {
  if (/^(nome( completo)?|seu nome|name|full name|your name)$/.test(label)) return "name";
  if (/^(e-?mail|seu e-?mail|email address|your email)$/.test(label)) return "email";
  if (/^(telefone|celular|whatsapp|whats|fone|tel|phone|contato|telefone\/whatsapp|celular\/whatsapp|telefone \(whatsapp\)|phone number)$/.test(label)) return "phone";
  if (/^(cidade|city)$/.test(label)) return "city";
  if (/^(estado|uf)$/.test(label)) return "state";
  return null;
}

// Questions a site form asks that are worth a line of their own for the AI (the label sits above the answer)
const EXTRA_LABEL = /^(mensagem|message|comment or message|comentario( ou mensagem)?|observac(ao|oes)|duvida|interesse|produto|servico|empresa|seguro|tipo de seguro|consorcio|como nos conheceu|o que procura)$/;
const HEADER_LABEL = /^(de|from|para|to|cc|enviado|sent|data|date|assunto|subject)$/;

function put(out: Fields, label: string, raw: string, value: string) {
  out.lines++;
  const field = fieldOf(label);
  if (field === "email") out.email ??= EMAIL_RE.exec(value)?.[0];
  else if (field) out[field] ??= value;
  else if (Object.keys(out.qualification).length < 12) out.qualification[raw.trim().slice(0, 60)] = value.slice(0, 500);
}

const LABEL_LINE = /^[-*_ ]*([\p{L}][\p{L}\p{N} /()?-]{0,40}?)[-*_ :]*$/u;

function isLabelLine(line: string) {
  const m = LABEL_LINE.exec(line);
  const label = m ? clean(m[1]).replace(/\?$/, "").trim() : "";
  return !!m && (!!fieldOf(label) || EXTRA_LABEL.test(label));
}

/**
 * A form's answers as lead fields: "Label: value" lines, or a known label on its own line with the answer below it
 * (WordPress forms such as WPForms). Labels the CRM has no field for go to the AI.
 */
export function formFields(text: string): Fields {
  const out: Fields = { qualification: {}, lines: 0 };
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = /^[*_]*([\p{L}][\p{L}\p{N} /()?-]{0,40}?)[*_]*\s*:\s*(.+?)$/u.exec(lines[i]);
    if (m) {
      const label = clean(m[1]).replace(/\?$/, "").trim();
      const value = m[2].replace(/^[*_]+|[*_]+$/g, "").trim();
      if (value && !value.startsWith("//") && !HEADER_LABEL.test(label)) put(out, label, m[1], value);
      continue;
    }
    // "--- Nome ---", "Nome", "NOME:" alone on a line, the answer on the next lines
    const alone = LABEL_LINE.exec(lines[i]);
    const label = alone ? clean(alone[1]).replace(/\?$/, "").trim() : "";
    if (!alone || !isLabelLine(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j]) j++;
    const answer: string[] = [];
    let last = i;
    // The answer is one line for a contact field; a message runs to a blank line or the next label
    for (; j < lines.length && lines[j] && !isLabelLine(lines[j]); j++) {
      answer.push(lines[j]);
      last = j;
      if (fieldOf(label)) break;
    }
    if (!answer.length) continue;
    put(out, label, alone[1], answer.join(" "));
    i = last;
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", eacute: "é", ecirc: "ê", iacute: "í", oacute: "ó", ocirc: "ô", otilde: "õ", uacute: "ú", ccedil: "ç",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Eacute: "É", Ecirc: "Ê", Iacute: "Í", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Uacute: "Ú", Ccedil: "Ç",
};

/** An HTML e-mail as lines of text, each table row, cell and bold label on its own line (as a form e-mail shows them). */
export function htmlText(html: string) {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|section|strong|b|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (e, name: string) => ENTITIES[name] ?? e)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first phone in the text that is a real Brazilian number and not one of the company's own. */
export function findPhone(text: string, own: string[]) {
  for (const m of text.matchAll(PHONE_RE)) {
    const phone = normalizePhone(m[0]);
    if (/^55[1-9]\d{9,10}$/.test(phone) && !own.includes(phone)) return phone;
  }
  return null;
}

function firstAddress(a: AddressObject | AddressObject[] | undefined) {
  const v = (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value).find((x) => x.address);
  return v ? { address: v.address!.trim().toLowerCase(), name: v.name?.trim() || "" } : null;
}

/** The text of the e-mail, as the lead wrote it: without the quoted e-mail of a reply. */
function ownText(text: string) {
  const quote = QUOTE_MARK.exec(text);
  const body = quote ? text.slice(0, quote.index) : text;
  return body
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type ReadEmail =
  | { skip: string; from: string; subject: string; preview?: string }
  | {
      skip?: undefined;
      from: string;
      subject: string;
      messageId: string;
      date: Date;
      body: string;
      // Asks for a quote (insurance, consórcio): goes to the quotes funnel
      quote: boolean;
      lead: { name: string | null; email: string | null; phone: string | null; city: string | null; state: string | null; qualification: Record<string, string> };
    };

/**
 * Who the e-mail is from and what it says. Auto-replies, bounces and newsletters are skipped. An e-mail from the
 * company itself (the site's form, sent from the leads box to itself; a person forwarding a lead) is read for the contact
 * inside it.
 */
export function readLeadEmail(mail: ParsedMail, opts: { mailbox: string; ownPhones: string[]; ownDomains: string[] }): ReadEmail {
  const h = mail.headers;
  const header = (k: string) => String(h.get(k) ?? "").toLowerCase();
  const from = firstAddress(mail.from);
  const replyTo = firstAddress(mail.replyTo);
  const subject = (mail.subject ?? "").trim();
  const shown = from ? (from.name ? `${from.name} <${from.address}>` : from.address) : "remetente desconhecido";
  const skip = (reason: string) => ({ skip: reason, from: shown, subject });
  const isOwn = (address: string) => opts.ownDomains.some((d) => address.endsWith(`@${d}`));
  const usable = (a: { address: string } | null) => !!a && !isOwn(a.address) && !NO_REPLY.test(a.address) && !BOUNCE.test(a.address);

  if (from && BOUNCE.test(from.address)) return skip("aviso de e-mail não entregue");
  if ((header("auto-submitted") && header("auto-submitted") !== "no") || AUTO_SUBJECT.test(subject)) return skip("resposta automática");
  if (header("x-spam-flag") === "yes") return skip("marcado como spam");

  // A site form usually sends HTML only, laid out in a table: its rows read better than the text mailparser makes of it
  const plain = (mail.text || "").replace(/\u00a0/g, " ");
  const fromHtml = mail.html ? htmlText(mail.html) : "";
  const raw = fromHtml && formFields(fromHtml).lines > formFields(plain).lines ? fromHtml : plain;
  // A forwarded lead: the contact is the one in the forwarded e-mail, not the person who forwarded it
  const forward = from && isOwn(from.address) ? FORWARD_MARK.exec(raw) : null;
  const forwarded = forward ? raw.slice(forward.index + forward[0].length) : null;
  const forwardedFrom = forwarded ? /^\s*(?:de|from)\s*:\s*(.+)$/im.exec(forwarded)?.[1] : undefined;
  const forwardedSender = forwardedFrom
    ? { address: EMAIL_RE.exec(forwardedFrom)?.[0].toLowerCase() ?? "", name: forwardedFrom.replace(/<[^>]*>|"/g, "").replace(EMAIL_RE, "").trim() }
    : null;
  const text = ownText(forwarded ?? raw);
  const fields = formFields(text);
  // mailparser keeps the List-* headers together under "list"
  const bulk = !!(h.get("list") || h.get("list-unsubscribe") || h.get("list-id")) || /^(bulk|list|junk)$/.test(header("precedence"));
  if (bulk && !fields.email && !fields.phone) return skip("newsletter ou e-mail em massa");

  const sender = [forwardedSender?.address ? forwardedSender : null, replyTo, forwarded ? null : from].find(usable) ?? null;
  const labeledEmail = fields.email?.toLowerCase();
  // Last, any address in the text that is not the company's (a form that labels the e-mail some other way)
  const anyEmail =
    fields.lines >= 2 ? [...text.matchAll(new RegExp(EMAIL_RE.source, "g"))].map((m) => m[0].toLowerCase()).find((a) => !isOwn(a) && !NO_REPLY.test(a)) : undefined;
  const email = (labeledEmail && !isOwn(labeledEmail) ? labeledEmail : null) ?? sender?.address ?? anyEmail ?? null;
  const labeledPhone = fields.phone ? normalizePhone(fields.phone) : "";
  const phone = (/^55[1-9]\d{9,10}$/.test(labeledPhone) && !opts.ownPhones.includes(labeledPhone) ? labeledPhone : null) ?? findPhone(text, opts.ownPhones);
  if (!email && !phone) return { ...skip("sem e-mail nem telefone do lead"), preview: text.slice(0, 400) };

  const senderName = sender && sender.address === email && sender.name && !EMAIL_RE.test(sender.name) ? sender.name : null;
  const date = mail.date && mail.date.getTime() < Date.now() ? mail.date : new Date();
  const body = text.slice(0, 4000);
  // The AI reads what the lead asked: a form's answers line by line, a person's e-mail as written
  const form = fields.lines >= 3;
  const qualification: Record<string, string> = form ? { ...fields.qualification } : {};
  if (subject) qualification["Assunto do e-mail"] = subject.slice(0, 200);
  if (!form && body) qualification["E-mail do lead"] = body.slice(0, 500);
  return {
    from: shown,
    subject,
    messageId: (mail.messageId || `${from?.address ?? "?"}:${date.toISOString()}:${subject}`).replace(/^<|>$/g, "").slice(0, 300),
    date,
    body,
    quote: QUOTE_ASK.test(`${subject}\n${text}`),
    lead: { name: fields.name ?? senderName, email, phone, city: fields.city ?? null, state: fields.state ?? null, qualification },
  };
}

// ---------- The box ----------

type RawEmail = { uid: number; source: Buffer };
export type Mailbox = { uidValidity: string; newSince(lastUid: number | null, since: Date): Promise<number[]>; read(uid: number): Promise<RawEmail | null>; close(): Promise<void> };

async function openImap(): Promise<Mailbox> {
  const pass = process.env.LEADS_IMAP_PASSWORD;
  if (!pass) throw new Error("Falta a senha da caixa de leads (LEADS_IMAP_PASSWORD) no Vercel.");
  const port = Number(process.env.LEADS_IMAP_PORT || 993);
  const client = new ImapFlow({
    host: process.env.LEADS_IMAP_HOST || "email-ssl.com.br",
    port,
    secure: port === 993,
    auth: { user: mailboxUser(), pass },
    logger: false,
    connectionTimeout: 15_000,
    socketTimeout: 30_000,
  });
  // A dropped connection is reported by the call in progress; without a listener Node would crash the function
  client.on("error", () => {});
  await client.connect();
  const lock = await client.getMailboxLock("INBOX", { readOnly: true });
  const box = client.mailbox;
  return {
    uidValidity: box ? String(box.uidValidity) : "",
    async newSince(lastUid, since) {
      const found = await client.search(lastUid ? { uid: `${lastUid + 1}:*` } : { since }, { uid: true });
      // "n:*" always brings the last e-mail, even an old one
      return (found || []).filter((uid) => !lastUid || uid > lastUid).sort((a, b) => a - b);
    },
    async read(uid) {
      const m = await client.fetchOne(String(uid), { uid: true, source: { maxLength: MAX_BYTES } }, { uid: true });
      return m && m.source ? { uid: m.uid, source: m.source } : null;
    },
    async close() {
      lock.release();
      await client.logout().catch(() => client.close());
    },
  };
}

/** The company's own WhatsApp numbers: a signature or a forwarded e-mail never makes them a lead. */
async function ownPhones() {
  const numbers = await savedWhatsAppNumbers();
  return (numbers?.numbers ?? []).map((n) => normalizePhone(n.display)).filter(Boolean);
}

function ownDomains() {
  const domains = [mailboxUser(), process.env.SMTP_USER ?? "", process.env.SMTP_FROM ?? ""].map((a) => EMAIL_RE.exec(a)?.[0].split("@")[1]?.toLowerCase());
  return [...new Set(domains.filter((d): d is string => !!d))];
}

function friendlyError(e: unknown) {
  const err = e as Error & { authenticationFailed?: boolean; code?: string };
  if (err.authenticationFailed) return `A Locaweb recusou o login de ${mailboxUser()}. Confira a senha em LEADS_IMAP_PASSWORD no Vercel.`;
  if (err.code === "ENOTFOUND" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED" || /timeout/i.test(err.message))
    return `Não consegui conectar no servidor de e-mail (${process.env.LEADS_IMAP_HOST || "email-ssl.com.br"}). Tento de novo em alguns minutos.`;
  return err.message;
}

/** Turns one e-mail into a lead (or adds it to the lead it came from); returns what became of it. */
async function takeEmail(
  source: Buffer,
  funnels: { leads: string | null; quotes: string | null },
  opts: Parameters<typeof readLeadEmail>[1],
): Promise<{ entry: EmailLog; created: boolean }> {
  const read = readLeadEmail(await simpleParser(source), opts);
  const at = new Date().toISOString();
  if (read.skip !== undefined)
    return { entry: { at, from: read.from, subject: read.subject, result: `ignorado: ${read.skip}`, preview: read.preview }, created: false };
  const externalId = `email:${read.messageId}`;
  const known = await db.message.findUnique({ where: { externalId }, select: { leadId: true } });
  if (known) return { entry: { at, from: read.from, subject: read.subject, result: "já lido antes", leadId: known.leadId }, created: false };
  const { lead, created } = await createLead(
    {
      ...read.lead,
      source: "E-mail",
      campaign: read.subject.slice(0, 120) || "E-mail",
      externalId,
      pipelineId: (read.quote && funnels.quotes) || funnels.leads,
      createdAt: read.date,
    },
    "E-mail de leads",
  );
  await db.message.create({
    data: {
      leadId: lead.id,
      channel: "EMAIL",
      direction: "IN",
      body: [read.subject && `Assunto: ${read.subject}`, read.body].filter(Boolean).join("\n\n") || "(e-mail sem texto)",
      author: lead.name || read.lead.email || "Lead",
      status: "RECEIVED",
      externalId,
      createdAt: read.date,
    },
  });
  if (!created) await logEvent(lead.id, "lead.email", "E-mail de leads", `Mandou um e-mail para ${opts.mailbox}${read.subject ? `: "${read.subject}"` : "."}`);
  // Without WhatsApp the AI cannot answer, and a lead already here wrote about something new: a person reads it
  if (!created || !lead.phone) await ensureTask(lead.id, lead.ownerId, ANSWER_EMAIL_TASK);
  // The log shows the lead, not the site or the person who sent the e-mail on its behalf
  const who = [lead.name, lead.email && `<${lead.email}>`].filter(Boolean).join(" ") || lead.phone || read.from;
  return { entry: { at, from: who, subject: read.subject, result: created ? "lead novo" : "lead que já estava no CRM", leadId: lead.id }, created };
}

/** Reads the e-mails that arrived since the last read and creates their leads. Called by the cron every 2 minutes. */
export async function pullEmailLeads(now = new Date(), opts: { force?: boolean; open?: () => Promise<Mailbox> } = {}) {
  const state = await emailLeadsState();
  // A wrong password is not retried every 2 minutes: the e-mail server could lock the box
  if (!opts.force && state.error && state.at && now.getTime() - Date.parse(state.at) < RETRY_AFTER_ERROR_MS) return { skipped: state.error };
  let box: Mailbox | null = null;
  let lastUid = state.lastUid ?? null;
  let uidValidity = state.uidValidity;
  const log: EmailLog[] = [];
  let created = 0;
  try {
    box = await (opts.open ?? openImap)();
    // A recreated box numbers its e-mails again: start over from the last days (the Message-ID avoids repeats)
    if (box.uidValidity !== uidValidity) lastUid = null;
    uidValidity = box.uidValidity;
    const uids = (await box.newSince(lastUid, new Date(now.getTime() - BACKFILL_DAYS * 86_400_000))).slice(0, MAX_PER_RUN);
    const pipeline = state.pipelineId ? await db.pipeline.findUnique({ where: { id: state.pipelineId }, select: { id: true } }) : null;
    const funnels = { leads: pipeline?.id ?? null, quotes: (await quoteFunnel(state))?.id ?? null };
    const read = { mailbox: mailboxUser(), ownPhones: await ownPhones(), ownDomains: ownDomains() };
    for (const uid of uids) {
      const raw = await box.read(uid);
      if (raw) {
        const r = await takeEmail(raw.source, funnels, read).catch((e: Error) => ({
          entry: { at: new Date().toISOString(), from: "?", subject: "", result: `erro: ${e.message}` },
          created: false,
        }));
        if (r.created) created++;
        log.push(r.entry);
      }
      lastUid = Math.max(lastUid ?? 0, uid);
    }
    await saveState({ ...state, uidValidity, lastUid: lastUid ?? state.lastUid, at: now.toISOString(), error: null, created: (state.created ?? 0) + created, log: [...log.reverse(), ...(state.log ?? [])].slice(0, 10) });
    return { read: log.length, created };
  } catch (e) {
    const error = friendlyError(e);
    await saveState({ ...state, uidValidity, lastUid: lastUid ?? state.lastUid, at: now.toISOString(), error, created: (state.created ?? 0) + created, log: [...log.reverse(), ...(state.log ?? [])].slice(0, 10) });
    return { error };
  } finally {
    await box?.close().catch(() => {});
  }
}
