import type { Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { isUndelivered, isWindowOpen, mediaKind, sendAudio, sendButtons, sendMedia, sendTemplate, sendText, type SendResult } from "./whatsapp";
import { AUDIO_MARK, WHATSAPP_AUDIO, baseMime, transcribe, uploadWhatsAppMedia, webmToOgg } from "./audio";
import { getSettings, materialFileName, whatsappIsReal } from "./settings";
import { enqueue } from "./queue";

export type SendOptions = {
  // Picks the approved template by its use when the 24-hour window is closed (first_contact, reminder, reengagement)
  purpose?: string;
  // This exact Meta template when the window is closed (automation rules)
  templateName?: string;
  // Automatic messages never fall back to an unrelated template: without their own, they wait for the lead
  automatic?: boolean;
  // Tap-to-answer buttons sent with the text inside the window
  buttons?: string[];
  // The template's {{1}}, {{2}}, {{3}}... when it asks for more than the name (a meeting's date, time and link)
  params?: string[];
};

export type SendOutcome =
  | { ok: true; skipped: string; usedTemplate?: undefined }
  | { ok: true; skipped?: undefined; id: string; messageId: string; usedTemplate: boolean; simulated: boolean }
  | { ok: false; skipped?: undefined; error: string; code?: number; messageId: string; usedTemplate: boolean; simulated: false };

/** A material link in the text becomes a real video, PDF or photo in WhatsApp, with the rest as its caption. */
export function findMaterial(body: string, materials: string[]) {
  const url = materials.find((m) => m && body.includes(m));
  if (!url) return null;
  const file = url.split("/").pop() ?? "";
  const kind = mediaKind(file);
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
  return { url, kind, caption, filename: materialFileName(url) } as const;
}

/** What a message typed by the team goes out as when the window is closed: someone who never wrote gets the first contact, not "any questions left?". */
export function manualPurpose(lead: Pick<Lead, "lastInboundAt">) {
  return lead.lastInboundAt ? "reengagement" : "first_contact";
}

/** The approved template for a use. Utility before marketing: Meta can hold marketing templates back from people who never wrote. */
export function templateFor(purpose: string, simulated = false) {
  return db.whatsAppTemplate.findFirst({
    // The CRM fills {{1}} and {{2}} only: a template asking for a date or a link ({{3}}, {{4}}) would fail at Meta
    where: { ...(simulated ? {} : { active: true }), purpose, NOT: { body: { contains: "{{3}}" } } },
    orderBy: [{ active: "desc" }, { category: "desc" }, { name: "asc" }],
  });
}

/**
 * Sends a WhatsApp message choosing the right path by itself: free text inside the 24-hour window,
 * an approved template outside it. The team never has to think about Meta's window rule.
 */
export async function sendWhatsApp(lead: Lead, body: string, author: string, options: SendOptions | string = {}): Promise<SendOutcome> {
  const o: SendOptions = typeof options === "string" ? { purpose: options } : options;
  if (!lead.phone) throw new Error("Lead sem telefone.");
  if (o.automatic && lead.whatsappOptOut) return { ok: true, skipped: "Ignorado: o lead pediu para parar as mensagens." };
  // Read fresh: a retry of a job that just failed must not write to a number already set aside
  if (o.automatic && (await db.lead.count({ where: { id: lead.id, stage: { key: SEND_ERROR_STAGE.key } } })))
    return { ok: true, skipped: "Ignorado: o WhatsApp deste contato deu erro; ele está na coluna de erro." };
  const settings = await getSettings();
  const simulated = !whatsappIsReal(settings, lead);
  const open = isWindowOpen(lead.lastInboundAt);

  let template: { name: string; language: string; body: string; active: boolean; headerUrl: string | null } | null = null;
  if (!open) {
    if (o.templateName) {
      template = await db.whatsAppTemplate.findUnique({ where: { name: o.templateName } });
      if (!template) return { ok: true, skipped: `Ignorado: janela de 24 h fechada e o modelo ${o.templateName} não está cadastrado.` };
      // In test mode the flow can be tried before Meta approves the template
      if (!template.active && !simulated) return { ok: true, skipped: `Ignorado: janela de 24 h fechada e o modelo ${o.templateName} ainda não foi aprovado pela Meta.` };
    } else if (o.purpose || !o.automatic) {
      // Never an unrelated template: a lead in proposal must not get the "pausing your service" one
      template = await templateFor(o.purpose ?? manualPurpose(lead), simulated);
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
  const params =
    template && o.params ? o.params : template?.body.includes("{{2}}") ? [firstName, sdrName] : template?.body.includes("{{1}}") ? [firstName] : [];
  const text = template ? template.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "") : body;
  const msg = await db.message.create({
    data: { leadId: lead.id, channel: "WHATSAPP", direction: "OUT", body: text, author, template: template?.name },
  });
  if (simulated) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SIMULATED" } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: `simulado-${msg.id}`, messageId: msg.id, usedTemplate: !!template, simulated: true };
  }
  let res: SendResult;
  // From the number the lead's conversation is on (a funnel's own number), null = the main one
  const from = lead.whatsappNumberId;
  if (template) {
    res = await sendTemplate(lead.phone, template.name, template.language, params, template.headerUrl, from);
  } else {
    const material = findMaterial(body, Object.values(settings.materials));
    // Video and buttons in one message: the video on top, the text and the buttons below
    if (material && o.buttons?.length)
      res = await sendButtons(lead.phone, material.caption, o.buttons, { kind: material.kind, link: material.url, filename: material.filename }, from);
    else if (material) res = await sendMedia(lead.phone, material.kind, material.url, material.caption, material.filename, from);
    else if (o.buttons?.length) res = await sendButtons(lead.phone, body, o.buttons, undefined, from);
    else res = await sendText(lead.phone, body, from);
  }
  if (res.ok) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", externalId: res.id } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: res.id, messageId: msg.id, usedTemplate: !!template, simulated: false };
  }
  await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: res.error, errorCode: res.code } });
  await logEvent(lead.id, "whatsapp.failed", author, `Mensagem não enviada: ${res.error}`, { code: res.code ?? null });
  await afterUndelivered(lead.id, res.error);
  return { ok: false, error: res.error, code: res.code, messageId: msg.id, usedTemplate: !!template, simulated: false };
}

const AUDIO_EXT: Record<string, string> = { "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/amr": "amr" };

/**
 * An audio recorded in the CRM goes as a WhatsApp voice message. Only inside the 24-hour window:
 * Meta has no audio templates. Chrome records WebM, which is turned into Ogg without re-encoding.
 */
export async function sendAudioMessage(lead: Lead, audio: Uint8Array, mimeType: string, author: string): Promise<SendOutcome> {
  if (!lead.phone) throw new Error("Lead sem telefone.");
  if (!isWindowOpen(lead.lastInboundAt)) throw new Error("Janela de 24 h fechada: o áudio só pode ir depois que o lead responder. Mande um texto primeiro.");
  let type = baseMime(mimeType);
  let data = audio;
  if (type === "audio/webm") {
    data = webmToOgg(audio);
    type = "audio/ogg";
  }
  if (!WHATSAPP_AUDIO.has(type)) throw new Error(`O WhatsApp não aceita áudio no formato ${type}.`);
  const settings = await getSettings();
  const simulated = !whatsappIsReal(settings, lead);
  const msg = await db.message.create({
    data: {
      leadId: lead.id,
      channel: "WHATSAPP",
      direction: "OUT",
      body: `${AUDIO_MARK} Áudio`,
      author,
      mediaKind: "audio",
      mediaType: type,
      media: { create: { mimeType: type, data: Buffer.from(data) } },
    },
  });
  if (simulated) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SIMULATED" } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: `simulado-${msg.id}`, messageId: msg.id, usedTemplate: false, simulated: true };
  }
  let res: SendResult;
  try {
    res = await sendAudio(lead.phone, await uploadWhatsAppMedia(data, type, `audio.${AUDIO_EXT[type]}`, lead.whatsappNumberId), lead.whatsappNumberId);
  } catch (e) {
    res = { ok: false, error: (e as Error).message, accountLevel: false };
  }
  if (res.ok) {
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", externalId: res.id } });
    await db.lead.update({ where: { id: lead.id }, data: { lastContactAt: new Date() } });
    return { ok: true, id: res.id, messageId: msg.id, usedTemplate: false, simulated: false };
  }
  await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: res.error, errorCode: res.code } });
  await logEvent(lead.id, "whatsapp.failed", author, `Áudio não enviado: ${res.error}`, { code: res.code ?? null });
  await afterUndelivered(lead.id, res.error);
  return { ok: false, error: res.error, code: res.code, messageId: msg.id, usedTemplate: false, simulated: false };
}

/** Writes out what the team said in an audio, so the conversation (and the AI) can read it later. */
export async function transcribeSentAudio(messageId: string) {
  const media = await db.messageMedia.findUnique({ where: { messageId } });
  if (!media) return;
  const text = await transcribe(media.data, media.mimeType).catch(() => "");
  if (text) await db.message.update({ where: { id: messageId }, data: { body: `${AUDIO_MARK} ${text}` } });
}

// The funnel column where contacts WhatsApp can't reach go, created in each funnel the first time it is needed
export const SEND_ERROR_STAGE = { key: "erro_envio", name: "Erro no WhatsApp", color: "#b91c1c" } as const;
export const UNDELIVERED_CATEGORIES = ["UTILITY", "MARKETING"] as const;
// Won, lost or discarded by the team: the lead stays in that column and gets no new tries
export const isClosed = (lead: Pick<Lead, "status">) => ["DISQUALIFIED", "WON", "LOST"].includes(lead.status);

/**
 * A WhatsApp message did not reach the lead. The first time, e-mails go (welcome and a button to call us
 * on WhatsApp) and the message is tried in the other Meta category, marketing or utility. Only when both
 * were denied does the lead stop getting WhatsApp and go to "Erro no WhatsApp", where the team sees it.
 */
export async function afterUndelivered(leadId: string, lastError: string) {
  const lead = await db.lead.findUnique({ where: { id: leadId }, include: { stage: true } });
  if (!lead || lead.stage.key === SEND_ERROR_STAGE.key || isClosed(lead)) return;
  const failed = await db.message.findMany({
    where: { leadId, channel: "WHATSAPP", direction: "OUT", status: "FAILED" },
    select: { template: true, errorCode: true },
  });
  const denied = failed.filter((m) => isUndelivered(m.errorCode, lead.phone));
  if (!denied.length) return;
  await enqueue("whatsapp.undelivered_emails", { leadId, dedupeKey: `undelivered_emails:${leadId}` });
  const names = denied.flatMap((m) => (m.template ? [m.template] : []));
  const tried = new Set((await db.whatsAppTemplate.findMany({ where: { name: { in: names } }, select: { category: true } })).map((t) => t.category));
  const next = UNDELIVERED_CATEGORIES.find((c) => !tried.has(c));
  if (next) {
    await enqueue("whatsapp.other_category", { leadId, payload: { category: next }, dedupeKey: `other_category:${leadId}:${next}`, maxAttempts: 2 });
    return;
  }
  await moveToSendError(leadId, `marketing e utilidade não chegaram (${lastError})`);
}

/** Stops writing to this contact (AI and automations) and moves it to "Erro no WhatsApp". */
export async function moveToSendError(leadId: string, reason: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  if (lead.stage.key === SEND_ERROR_STAGE.key || isClosed(lead)) return false;
  const stage =
    (await db.stage.findUnique({ where: { pipelineId_key: { pipelineId: lead.pipelineId, key: SEND_ERROR_STAGE.key } } })) ??
    (await db.stage.create({
      data: {
        ...SEND_ERROR_STAGE,
        pipelineId: lead.pipelineId,
        kind: "LOST",
        position: ((await db.stage.aggregate({ where: { pipelineId: lead.pipelineId }, _max: { position: true } }))._max.position ?? 0) + 1,
      },
    }));
  // Imported here: leads.ts sends WhatsApp through this file
  const { moveLead } = await import("./leads");
  await moveLead(lead.id, stage.id, "WhatsApp", { aiPaused: true, lostReason: `WhatsApp não chega neste contato: ${reason}` });
  return true;
}
