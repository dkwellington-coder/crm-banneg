import type { Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { isWindowOpen, sendButtons, sendMedia, sendTemplate, sendText, type SendResult } from "./whatsapp";
import { getSettings, isTestContact } from "./settings";

export type SendOptions = {
  // Picks the approved template by its use when the 24-hour window is closed (first_contact, reminder, reengagement)
  purpose?: string;
  // This exact Meta template when the window is closed (automation rules)
  templateName?: string;
  // Automatic messages never fall back to an unrelated template: without their own, they wait for the lead
  automatic?: boolean;
  // Tap-to-answer buttons sent with the text inside the window
  buttons?: string[];
};

export type SendOutcome =
  | { ok: true; skipped: string; usedTemplate?: undefined }
  | { ok: true; skipped?: undefined; id: string; messageId: string; usedTemplate: boolean; simulated: boolean }
  | { ok: false; skipped?: undefined; error: string; code?: number; messageId: string; usedTemplate: boolean; simulated: false };

// Pretty file names for PDFs the lead receives
const FILE_NAMES: Record<string, string> = {
  "apresentacao-de-valor.pdf": "Banneg - Apresentação de Valor.pdf",
  "por-que-investir.pdf": "Banneg - Por que investir.pdf",
  "simulacoes-de-rentabilidade.pdf": "Banneg - Simulações de rentabilidade.pdf",
  "catalogo-lojas-3d.pdf": "Banneg - Catálogo de Lojas.pdf",
};

/** A material link in the text becomes a real video, PDF or photo in WhatsApp, with the rest as its caption. */
export function findMaterial(body: string, materials: string[]) {
  const url = materials.find((m) => m && body.includes(m));
  if (!url) return null;
  const file = url.split("/").pop() ?? "";
  const kind = /\.mp4$/i.test(file) ? "video" : /\.pdf$/i.test(file) ? "document" : /\.(jpe?g|png)$/i.test(file) ? "image" : null;
  if (!kind) return null;
  // "está aqui: <link>. Depois..." -> "está aqui. Depois..."; "vídeo do Wellington: <link>\n\nSe puder" -> "vídeo do Wellington.\n\nSe puder"
  const at = body.indexOf(url);
  let before = body.slice(0, at).replace(/[\s:]+$/, "");
  const after = body.slice(at + url.length);
  if (/[\p{L}\p{N})"]$/u.test(before) && !/^[.!?,;]/.test(after)) before += ".";
  const caption = (before + after)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { url, kind, caption, filename: FILE_NAMES[file] ?? file } as const;
}

/**
 * Sends a WhatsApp message choosing the right path by itself: free text inside the 24-hour window,
 * an approved template outside it. The team never has to think about Meta's window rule.
 */
export async function sendWhatsApp(lead: Lead, body: string, author: string, options: SendOptions | string = {}): Promise<SendOutcome> {
  const o: SendOptions = typeof options === "string" ? { purpose: options } : options;
  if (!lead.phone) throw new Error("Lead sem telefone.");
  if (o.automatic && lead.whatsappOptOut) return { ok: true, skipped: "Ignorado: o lead pediu para parar as mensagens." };
  const settings = await getSettings();
  const simulated = settings.testMode && !isTestContact(settings, lead.phone);
  const open = isWindowOpen(lead.lastInboundAt);

  let template: { name: string; language: string; body: string; active: boolean } | null = null;
  if (!open) {
    if (o.templateName) {
      template = await db.whatsAppTemplate.findUnique({ where: { name: o.templateName } });
      if (!template) return { ok: true, skipped: `Ignorado: janela de 24 h fechada e o modelo ${o.templateName} não está cadastrado.` };
      // In test mode the flow can be tried before Meta approves the template
      if (!template.active && !simulated) return { ok: true, skipped: `Ignorado: janela de 24 h fechada e o modelo ${o.templateName} ainda não foi aprovado pela Meta.` };
    } else if (o.purpose || !o.automatic) {
      const usable = simulated ? {} : { active: true };
      // Never an unrelated template: a lead in proposal must not get the "pausing your service" one
      // Utility before marketing: Meta can hold marketing templates back from people who never wrote
      template = await db.whatsAppTemplate.findFirst({
        where: { ...usable, purpose: o.purpose ?? "reengagement" },
        orderBy: [{ active: "desc" }, { category: "desc" }, { name: "asc" }],
      });
      if (!template && o.automatic) return { ok: true, skipped: "Ignorado: janela de 24 h fechada e o modelo da Meta para esta mensagem ainda não foi aprovado." };
      if (!template) throw new Error("Janela de 24 h fechada: o lead não escreve há mais de 24 h e o modelo de retomada ainda não foi aprovado pela Meta.");
    } else {
      return { ok: true, skipped: "Ignorado: janela de 24 h fechada e esta mensagem não tem modelo da Meta." };
    }
  }
  const firstName = (lead.name ?? "").split(" ")[0] || "tudo bem";
  // {{2}} is the lead's SDR, so Alice's leads never get a message signed by Duda
  const sdrName = template?.body.includes("{{2}}")
    ? ((lead.sdrId && (await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }))?.name) || author)
    : "";
  const params = template?.body.includes("{{2}}") ? [firstName, sdrName] : template?.body.includes("{{1}}") ? [firstName] : [];
  const text = template ? template.body.replace("{{1}}", firstName).replace("{{2}}", sdrName) : body;
  const msg = await db.message.create({
    data: { leadId: lead.id, channel: "WHATSAPP", direction: "OUT", body: text, author, template: template?.name },
  });
  if (simulated) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SIMULATED" } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: `simulado-${msg.id}`, messageId: msg.id, usedTemplate: !!template, simulated: true };
  }
  let res: SendResult;
  if (template) {
    res = await sendTemplate(lead.phone, template.name, template.language, params);
  } else {
    const material = findMaterial(body, Object.values(settings.materials));
    if (material) res = await sendMedia(lead.phone, material.kind, material.url, material.caption, material.filename);
    else if (o.buttons?.length) res = await sendButtons(lead.phone, body, o.buttons);
    else res = await sendText(lead.phone, body);
  }
  if (res.ok) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", externalId: res.id } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: res.id, messageId: msg.id, usedTemplate: !!template, simulated: false };
  }
  await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: res.error } });
  await logEvent(lead.id, "whatsapp.failed", author, `Mensagem não enviada: ${res.error}`, { code: res.code ?? null });
  return { ok: false, error: res.error, code: res.code, messageId: msg.id, usedTemplate: !!template, simulated: false };
}
