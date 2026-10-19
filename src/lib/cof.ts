import { createHash, randomBytes } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { emailFrom, emailHtml, renderTemplate, sendRawEmail, withButton } from "./email";
import { getSettings, isTestContact, messageVars } from "./settings";
import { ensureTask } from "./leads";

export const COF_TEMPLATE = "cof";
// Lei 13.966/2019: the COF reaches the candidate at least 10 days before any contract or payment
export const COF_DAYS = 10;
// Bigger than this the documents go only by the link: large e-mails bounce
export const MAX_ATTACHED_BYTES = 15 * 1024 * 1024;
const BASE = (process.env.PUBLIC_BASE_URL ?? "https://crm-banneg-banneg.vercel.app").replace(/\/$/, "");

export type CofDoc = { id: string; name: string; size: number; sha256: string };

export const cofLink = (token: string) => `${BASE}/cof/${token}`;

export const DEFAULT_COF_SUBJECT = "COF - Circular de Oferta de Franquia {{empresa}}";
export const DEFAULT_COF_BODY = `Olá, {{nome}}!

Como combinamos, seguem os documentos da franquia {{empresa}}:
{{documentos}}

A Circular de Oferta de Franquia (COF) reúne as informações do {{empresa}} e da franquia. Junto com ela vão os balanços e o contrato. Pela Lei de Franquias (Lei 13.966/2019), você recebe a COF pelo menos 10 dias antes de assinar o contrato ou fazer qualquer pagamento, para ler com calma e tirar todas as dúvidas.

Por favor, confirme que recebeu os documentos no botão abaixo:

{{link_cof}}

Pelo mesmo link você baixa os arquivos de novo quando quiser.

Qualquer dúvida, é só responder este e-mail.

Um abraço,
Time de Expansão {{empresa}}`;

/** The documents that go in the next COF: the active ones, in the order they were uploaded. */
export async function cofDocuments(): Promise<CofDoc[]> {
  const docs = await db.franchiseDocument.findMany({
    where: { active: true, sha256: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, size: true, sha256: true },
  });
  return docs.map((d) => ({ ...d, sha256: d.sha256 ?? "" }));
}

/** When the law's 10 days end: counted from the lead's confirmation, or from the sending while there is none. */
export function cofDeadline(d: { sentAt: Date; confirmedAt: Date | null }) {
  return new Date((d.confirmedAt ?? d.sentAt).getTime() + COF_DAYS * 86_400_000);
}

export const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

const dateBr = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
export const dateTimeBr = (d: Date) =>
  d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * E-mails the COF, the balance sheets and the contract (the documents in Ajustes) to the lead, keeps the
 * e-mail byte for byte as it went and gives the lead a link to confirm receipt. With once, a lead who
 * already got these same files is skipped (an automation firing again); the team's button always sends.
 */
export async function sendCof(lead: Lead, actor: string, opts: { once?: boolean } = {}): Promise<string> {
  if (!lead.email) {
    await ensureTask(lead.id, lead.ownerId, "Pedir o e-mail do lead para enviar a COF");
    return "Ignorado: lead sem e-mail (tarefa criada para pedir).";
  }
  if (lead.emailOptOut) return "Ignorado: lead pediu para não receber e-mails.";
  const docs = await cofDocuments();
  if (!docs.length) {
    await ensureTask(lead.id, lead.ownerId, "Subir a COF em Ajustes e enviar para o lead");
    return "Ignorado: nenhum documento da COF em Ajustes (tarefa criada).";
  }
  if (opts.once) {
    const last = await db.cofDelivery.findFirst({ where: { leadId: lead.id }, orderBy: { sentAt: "desc" } });
    const sameFiles = (last?.documents as CofDoc[] | undefined)?.map((d) => d.sha256).join() === docs.map((d) => d.sha256).join();
    if (last && sameFiles) return `Ignorado: a COF já foi enviada em ${dateBr(last.sentAt)}.`;
  }

  const settings = await getSettings();
  const template = await db.emailTemplate.findUnique({ where: { key: COF_TEMPLATE } });
  const token = randomBytes(24).toString("base64url");
  const attached = docs.reduce((sum, d) => sum + d.size, 0) <= MAX_ATTACHED_BYTES;
  const vars = {
    ...messageVars(settings, lead),
    link_cof: cofLink(token),
    documentos: docs.map((d) => `- ${d.name}${attached ? " (em anexo)" : " (para baixar no link abaixo)"}`).join("\n"),
  };
  const subject = renderTemplate(template?.active ? template.subject : DEFAULT_COF_SUBJECT, vars);
  let text = renderTemplate(template?.active ? template.body : DEFAULT_COF_BODY, vars).replace("Olá, !", "Olá!");
  // The link is the proof of receipt: it goes even if someone edits it out of the text
  if (!text.includes(vars.link_cof)) text += `\n\nConfirme o recebimento dos documentos: ${vars.link_cof}`;
  const html =
    withButton(emailHtml(text), { label: "Confirmar que recebi", url: vars.link_cof }) +
    // Loads when the e-mail is opened: a sign it was seen, not the proof (that is the confirmation)
    `<img src="${BASE}/api/cof/${token}/aberto.gif" width="1" height="1" alt="" style="display:block;border:0">`;
  const files = attached
    ? await db.franchiseDocument.findMany({ where: { id: { in: docs.map((d) => d.id) } }, select: { id: true, data: true, mimeType: true } })
    : [];
  const mail = new MailComposer({
    from: emailFrom(),
    to: lead.email,
    subject,
    text,
    html,
    attachments: docs.flatMap((d) => {
      const f = files.find((x) => x.id === d.id);
      return f ? [{ filename: d.name, content: Buffer.from(f.data), contentType: f.mimeType }] : [];
    }),
  }).compile();
  const messageId = mail.messageId();
  const raw = await mail.build();

  const simulated = settings.testMode && !isTestContact(settings, lead.email);
  const smtpResponse = simulated ? "Simulado (modo teste): não enviado." : await sendRawEmail(lead.email, raw);
  const delivery = await db.cofDelivery.create({
    data: { leadId: lead.id, token, to: lead.email, subject, body: text, documents: docs, attached, messageId, smtpResponse, raw: new Uint8Array(raw), sentBy: actor },
  });
  await db.message.create({
    data: { leadId: lead.id, channel: "EMAIL", direction: "OUT", body: `${subject}\n\n${text}`, author: actor, status: simulated ? "SIMULATED" : "SENT" },
  });
  await logEvent(lead.id, "cof.sent", actor, `COF enviada para ${lead.email}: ${docs.map((d) => d.name).join(", ")}.`, {
    deliveryId: delivery.id,
    smtpResponse,
  });
  return simulated ? "COF simulada (modo teste)." : `COF enviada para ${lead.email}.`;
}

export function cofByToken(token: string) {
  return db.cofDelivery.findUnique({ where: { token }, include: { lead: { select: { name: true } } } });
}

/** The e-mail's image loaded or the lead opened the page: kept once, as a sign it was seen. */
export async function markCofOpened(token: string, how: "email" | "page") {
  const d = await db.cofDelivery.findUnique({ where: { token }, select: { id: true, leadId: true, openedAt: true } });
  if (!d || d.openedAt) return;
  await db.cofDelivery.update({ where: { id: d.id }, data: { openedAt: new Date() } });
  await logEvent(d.leadId, "cof.opened", "Lead", how === "email" ? "Abriu o e-mail da COF." : "Abriu a página da COF.");
}

/** One document of this COF, for the lead's link; every download goes on the lead's history. */
export async function downloadCofDocument(token: string, docId: string) {
  const d = await db.cofDelivery.findUnique({ where: { token } });
  const doc = d && (d.documents as CofDoc[]).find((x) => x.id === docId);
  if (!d || !doc) return null;
  const file = await db.franchiseDocument.findUnique({ where: { id: doc.id }, select: { data: true, mimeType: true } });
  if (!file) return null;
  await db.cofDelivery.update({ where: { id: d.id }, data: { downloadedAt: d.downloadedAt ?? new Date(), openedAt: d.openedAt ?? new Date() } });
  await logEvent(d.leadId, "cof.downloaded", "Lead", `Baixou ${doc.name}.`);
  return { name: doc.name, mimeType: file.mimeType, data: file.data };
}

/** The lead pressed "Confirmo que recebi": the proof of receipt, with when, from where and on what device. */
export async function confirmCof(token: string, ip: string | null, agent: string | null) {
  const d = await db.cofDelivery.findUnique({ where: { token } });
  if (!d) return null;
  if (d.confirmedAt) return d;
  const now = new Date();
  const updated = await db.cofDelivery.update({
    where: { id: d.id },
    data: { confirmedAt: now, confirmIp: ip?.slice(0, 100), confirmAgent: agent?.slice(0, 300), openedAt: d.openedAt ?? now },
  });
  await logEvent(d.leadId, "cof.confirmed", "Lead", `Confirmou o recebimento da COF em ${dateTimeBr(now)}.`, { ip, agent });
  return updated;
}

// The biggest document the screen can send (in pieces: a Vercel request takes at most 4.5 MB)
export const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

/** One piece of a document being uploaded, added to the end of the file. False when the file would get too big. */
export async function appendDocumentChunk(id: string, chunk: Uint8Array) {
  const added = await db.$executeRaw`UPDATE "FranchiseDocument" SET data = data || ${chunk}
    WHERE id = ${id} AND sha256 IS NULL AND octet_length(data) + ${chunk.length} <= ${MAX_DOCUMENT_BYTES}`;
  return added > 0;
}

/** A finished upload: the size and fingerprint (SHA-256) that prove later which file went. */
export async function finishDocument(id: string) {
  const doc = await db.franchiseDocument.findUnique({ where: { id }, select: { data: true } });
  if (!doc) return null;
  const sha256 = createHash("sha256").update(doc.data).digest("hex");
  return db.franchiseDocument.update({ where: { id }, data: { sha256, size: doc.data.length, active: true }, select: { id: true, name: true, size: true, sha256: true } });
}
