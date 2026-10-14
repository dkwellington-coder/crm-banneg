import type { Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { isWindowOpen, sendTemplate, sendText } from "./whatsapp";
import { getSettings, isTestContact } from "./settings";

/**
 * Sends a WhatsApp message choosing the right path by itself: free text inside the 24-hour window,
 * an approved template outside it. The team never has to think about Meta's window rule.
 */
export async function sendWhatsApp(lead: Lead, body: string, author: string, purpose = "reengagement") {
  if (!lead.phone) throw new Error("Lead sem telefone.");
  const open = isWindowOpen(lead.lastInboundAt);
  let template: { name: string; language: string; body: string } | null = null;
  if (!open) {
    template = await db.whatsAppTemplate.findFirst({ where: { active: true, purpose }, orderBy: { name: "asc" } });
    template ??= await db.whatsAppTemplate.findFirst({ where: { active: true }, orderBy: { name: "asc" } });
    if (!template) throw new Error("Janela de 24 h fechada e nenhum modelo aprovado cadastrado em Configurações.");
  }
  const firstName = (lead.name ?? "").split(" ")[0] || "tudo bem";
  const text = template ? template.body.replace("{{1}}", firstName) : body;
  const msg = await db.message.create({
    data: { leadId: lead.id, channel: "WHATSAPP", direction: "OUT", body: text, author, template: template?.name },
  });
  const settings = await getSettings();
  if (settings.testMode && !isTestContact(settings, lead.phone)) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SIMULATED" } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true as const, id: `simulado-${msg.id}`, messageId: msg.id, usedTemplate: !!template, simulated: true };
  }
  const res = template
    ? await sendTemplate(lead.phone, template.name, template.language, template.body.includes("{{1}}") ? [firstName] : [])
    : await sendText(lead.phone, body);
  if (res.ok) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", externalId: res.id } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
  } else {
    await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: res.error } });
    await logEvent(lead.id, "whatsapp.failed", author, `Mensagem não enviada: ${res.error}`, { code: res.code ?? null });
  }
  return { ...res, messageId: msg.id, usedTemplate: !!template, simulated: false };
}
