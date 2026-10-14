import nodemailer from "nodemailer";

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

export async function sendEmail(to: string, subject: string, body: string) {
  const t = getTransport();
  if (!t) throw new Error("E-mail não configurado (SMTP_HOST / SMTP_USER / SMTP_PASS).");
  const escaped = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = escaped
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const info = await t.sendMail({ from: process.env.SMTP_FROM ?? process.env.SMTP_USER, to, subject, text: body, html });
  return info.messageId as string;
}
