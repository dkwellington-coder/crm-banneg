import nodemailer from "nodemailer";
import { materialFileName } from "./settings";
import { mediaKind } from "./whatsapp";

export type EmailAttachment = { filename: string; href: string };

/**
 * PDFs and photos of the materials go attached to the e-mail instead of as links, and the text
 * names the attachment. Videos stay links: they open and play on any phone or computer.
 */
export function attachMaterials(body: string, materials: string[]) {
  const attachments: EmailAttachment[] = [];
  let text = body;
  for (const url of new Set(materials)) {
    if (!url || !text.includes(url)) continue;
    const kind = mediaKind(url);
    if (kind !== "document" && kind !== "image") continue;
    const filename = materialFileName(url);
    attachments.push({ filename, href: url });
    text = text.split(url).join(`${filename} (em anexo)`);
  }
  return { text, attachments };
}

export function renderTemplate(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransport() {
  if (transport) return transport;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 465),
    secure: Number(SMTP_PORT ?? 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transport;
}

/** Plain text to simple HTML: paragraphs, line breaks and clickable links. */
export function emailHtml(body: string) {
  // Quotes too: the text can be written by someone outside the team (the portal's notices), and a quote inside a link
  // would end the href and add attributes
  const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped
    .replace(/(https?:\/\/(?:(?!&quot;|&#39;)[^\s<])+)/g, '<a href="$1">$1</a>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** A big button for the main link of an e-mail: where the link is written in the text, or at the end. */
export function withButton(html: string, button: { label: string; url: string }) {
  const tag = `<p><a href="${button.url}" style="display:inline-block;background:#12357a;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${button.label}</a></p>`;
  const inline = `<p><a href="${button.url}">${button.url}</a></p>`;
  return html.includes(inline) ? html.replace(inline, tag) : html + tag;
}

export const emailFrom = () => process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "";

/** replyTo: who the answer goes to when it is not the sender (the portal's notices answer the store). */
export async function sendEmail(to: string, subject: string, body: string, attachments: EmailAttachment[] = [], html = emailHtml(body), replyTo?: string) {
  const t = getTransport();
  if (!t) throw new Error("E-mail não configurado (SMTP_HOST / SMTP_USER / SMTP_PASS).");
  const info = await t.sendMail({ from: emailFrom(), to, subject, text: body, html, attachments, ...(replyTo && { replyTo }) });
  return info.messageId as string;
}

/** Sends an e-mail already built byte for byte, so the copy kept is exactly what went. Returns the server's answer. */
export async function sendRawEmail(to: string, raw: Buffer) {
  const t = getTransport();
  if (!t) throw new Error("E-mail não configurado (SMTP_HOST / SMTP_USER / SMTP_PASS).");
  const info = await t.sendMail({ envelope: { from: process.env.SMTP_USER, to }, raw });
  return String(info.response ?? "");
}
