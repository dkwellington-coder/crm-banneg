import type { Lead, LeadStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { cancelJobs, enqueueDebounced } from "./queue";
import { cancelRuleJobs, scheduleAnswerRules, scheduleStageRules } from "./automations";
import { normalizePhone, phoneVariants } from "./whatsapp";
import { AUDIO_MARK, downloadWhatsAppMedia, transcribe } from "./audio";
import { SEND_ERROR_STAGE, sendWhatsApp } from "./messaging";
import { STAGE_KEYS } from "./plan";
import { queueCapi } from "./meta-capi";

/** A stage of the given funnel by its AI key; null when that funnel has no such stage. */
export async function stageByKey(key: string, pipelineId: string) {
  return db.stage.findUnique({ where: { pipelineId_key: { pipelineId, key } } });
}

/** A funnel by its short name ("sindicatos") or its name, ignoring accents and case. */
export async function pipelineByRef(ref: string | null | undefined) {
  const key = slugify(ref ?? "");
  if (!key) return null;
  const all = await db.pipeline.findMany({ select: { id: true, slug: true, name: true } });
  return all.find((p) => p.slug === key) ?? all.find((p) => slugify(p.name) === key) ?? null;
}

export function slugify(s: string) {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function defaultPipeline() {
  const p = (await db.pipeline.findFirst({ where: { isDefault: true } })) ?? (await db.pipeline.findFirst({ orderBy: { position: "asc" } }));
  if (!p) throw new Error("Nenhum funil cadastrado. Rode o seed (npm run db:seed).");
  return p;
}

/** Picks the active SDR with the fewest leads in qualification, so Duda and Alice share the load. */
export async function pickSdr() {
  const agents = await db.sdrAgent.findMany({
    where: { active: true },
    include: { _count: { select: { leads: { where: { status: { in: ["NEW", "AI_QUALIFYING"] } } } } } },
  });
  agents.sort((a, b) => a._count.leads - b._count.leads);
  return agents[0] ?? null;
}

export type NewLeadInput = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  source: string;
  campaign?: string | null;
  externalId?: string | null;
  pipelineId?: string | null;
  // Old leads from Kommo go to reactivation instead of getting a welcome message right away
  reactivation?: boolean;
  // Extra answers the form already collected (produto, empresa...), shown to the AI
  qualification?: Record<string, string>;
  // Imports keep the date the lead first came in, so "newest first" means something
  createdAt?: Date | null;
  stageId?: string | null;
  // Created by someone on the team: they know it exists, so it does not light the "new lead" alert
  seen?: boolean;
};

/** The lead with this number, or else the oldest one with it written with or without the 9. */
async function leadByPhone(phone: string) {
  return (
    (await db.lead.findUnique({ where: { phone } })) ??
    (await db.lead.findFirst({ where: { phone: { in: phoneVariants(phone) } }, orderBy: { createdAt: "asc" } }))
  );
}

export async function createLead(input: NewLeadInput, actor: string) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone) {
    const existing = await leadByPhone(phone);
    if (existing) {
      await logEvent(existing.id, "lead.duplicate", actor, `Entrou de novo pela origem "${input.source}".`);
      return { lead: existing, created: false };
    }
  }
  const chosen = input.stageId ? await db.stage.findUnique({ where: { id: input.stageId } }) : null;
  const pipelineId = chosen?.pipelineId ?? (input.pipelineId || (await defaultPipeline()).id);
  const stage =
    chosen ??
    (await stageByKey(STAGE_KEYS.NEW, pipelineId)) ??
    (await db.stage.findFirstOrThrow({ where: { pipelineId }, orderBy: { position: "asc" } }));
  const sdr = await pickSdr();
  let lead: Lead;
  try {
    lead = await db.lead.create({
      data: {
        name: input.name?.trim() || null,
        phone,
        email: input.email?.trim().toLowerCase() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        source: input.source,
        campaign: input.campaign ?? null,
        externalId: input.externalId ?? null,
        pipelineId,
        stageId: stage.id,
        sdrId: sdr?.id,
        ...(input.qualification && { qualification: input.qualification }),
        ...(input.createdAt && { createdAt: input.createdAt, stageEnteredAt: input.createdAt }),
        ...(input.seen && { seenAt: new Date() }),
      },
    });
  } catch (e) {
    // Two posts with the same number at the same moment: the second gets the lead the first one created
    const existing = (e as { code?: string }).code === "P2002" && phone ? await leadByPhone(phone) : null;
    if (!existing) throw e;
    return { lead: existing, created: false };
  }
  await logEvent(lead.id, "lead.created", actor, `Lead criado (origem: ${input.source}).`);
  await queueCapi(db, lead, stage).catch(() => console.error("Meta CAPI: falha ao registrar evento na fila."));
  if (!input.reactivation) await startAutomations(lead);
  return { lead, created: true };
}

/** Runs the automations of the stage the lead is in, as if it had just arrived there. */
export async function startAutomations(lead: Lead) {
  await scheduleStageRules(lead);
}

/**
 * A lead's audio: kept so the team can listen in the CRM, and written out so the AI can read it.
 * Returns what the lead said, or null when it could not be heard (the team then listens).
 */
export async function receiveAudio(messageId: string, mediaId: string) {
  try {
    const file = await downloadWhatsAppMedia(mediaId);
    await db.messageMedia.create({ data: { messageId, mimeType: file.mimeType, data: Buffer.from(file.data) } });
    await db.message.update({ where: { id: messageId }, data: { mediaType: file.mimeType } });
    const text = await transcribe(file.data, file.mimeType);
    if (!text) throw new Error("O áudio não tem fala que dê para entender.");
    await db.message.update({ where: { id: messageId }, data: { body: `${AUDIO_MARK} ${text}` } });
    return text;
  } catch (e) {
    const msg = await db.message.update({ where: { id: messageId }, data: { body: `${AUDIO_MARK} Áudio sem transcrição` } });
    await logEvent(msg.leadId, "audio.failed", "WhatsApp", `Não deu para transcrever o áudio: ${(e as Error).message}`);
    return null;
  }
}

export async function handleInbound(input: {
  phone: string;
  profileName?: string;
  body: string;
  externalId: string;
  at: Date;
  audio?: { id: string; mimeType?: string };
}) {
  const phone = normalizePhone(input.phone);
  const dup = await db.message.findUnique({ where: { externalId: input.externalId } });
  if (dup) return null;
  let lead = (await leadByPhone(phone)) ?? (await leadByEmailCode(input.body, phone));
  if (!lead) {
    lead = (await createLead({ phone, name: input.profileName, source: "whatsapp" }, "WhatsApp")).lead;
    // The lead wrote first, so the SDR answers the message instead of sending a cold opening
    await cancelJobs(lead.id, ["sdr.first_contact"]);
  }
  lead = await backFromSendError(lead);
  const msg = await db.message.create({
    data: {
      leadId: lead.id,
      channel: "WHATSAPP",
      direction: "IN",
      body: input.audio ? `${AUDIO_MARK} Áudio` : input.body,
      author: lead.name ?? "Lead",
      status: "RECEIVED",
      externalId: input.externalId,
      createdAt: input.at,
      ...(input.audio && { mediaKind: "audio", mediaType: input.audio.mimeType ?? null }),
    },
  });
  lead = await db.lead.update({
    where: { id: lead.id },
    data: { lastInboundAt: input.at, name: lead.name ?? input.profileName ?? null },
  });
  const said = input.audio ? await receiveAudio(msg.id, input.audio.id) : input.body;
  if (said !== null && isStopRequest(said)) return optOut(lead);
  // The lead answered: the "sem resposta" clock starts over
  await cancelRuleJobs(lead.id, "idle");
  await scheduleStageRules(lead, "idle");
  if (said === null) {
    await ensureTask(lead.id, lead.ownerId, "Ouvir o áudio do lead: não deu para transcrever");
    return lead;
  }
  // A tapped button ("Quero ver") moves the lead on and the next stage's message answers it
  const answered = await scheduleAnswerRules(lead, said, input.externalId);
  if (answered.matched && !answered.aiReplies) return lead;
  if (lead.sdrId && !lead.aiPaused && ["NEW", "AI_QUALIFYING", "QUALIFIED", "NURTURING"].includes(lead.status)) {
    // Wait a few seconds so several short messages get one answer
    await enqueueDebounced("sdr.reply", lead.id, Number(process.env.SDR_DEBOUNCE_MS ?? 15_000));
  } else {
    await ensureTask(lead.id, lead.ownerId, "Responder mensagem do lead no WhatsApp");
  }
  return lead;
}

/**
 * The "Chamar no WhatsApp" button of the e-mail writes the lead's code. A lead whose number WhatsApp could
 * not reach comes back from another number: the number is fixed and the conversation stays in its history.
 */
async function leadByEmailCode(body: string, phone: string) {
  const code = body.match(/c[oó]digo:?\s*([a-z0-9]{6})\b/i)?.[1];
  if (!code) return null;
  const lead = await db.lead.findFirst({ where: { id: { endsWith: code.toLowerCase() } } });
  if (!lead) return null;
  await logEvent(lead.id, "lead.phone_changed", "WhatsApp", `Chamou no WhatsApp pelo botão do e-mail, de outro número: ${lead.phone ?? "sem número"} → ${phone}.`);
  return db.lead.update({ where: { id: lead.id }, data: { phone } });
}

/** A lead in "Erro no WhatsApp" wrote: the number works, so it goes back to the conversation. */
async function backFromSendError(lead: Lead) {
  const stage = await db.stage.findUnique({ where: { id: lead.stageId } });
  if (stage?.key !== SEND_ERROR_STAGE.key) return lead;
  const back =
    (await stageByKey(STAGE_KEYS.AI_QUALIFYING, lead.pipelineId)) ??
    (await db.stage.findFirst({ where: { pipelineId: lead.pipelineId, kind: "OPEN" }, orderBy: { position: "asc" } }));
  if (!back) return lead;
  return moveLead(lead.id, back.id, "WhatsApp", { status: "AI_QUALIFYING", aiPaused: !lead.sdrId, lostReason: null });
}

// The "Parar mensagens" button of the templates, or the lead typing it
const STOP_WORDS = new Set(["parar mensagens", "parar", "pare", "sair", "stop", "cancelar", "descadastrar"]);

export function isStopRequest(body: string) {
  return STOP_WORDS.has(body.trim().toLowerCase().replace(/[.!]+$/, ""));
}

/** The lead asked to stop: no automatic WhatsApp or e-mail from now on, and the AI steps out. */
export async function optOut(lead: Lead) {
  if (lead.whatsappOptOut) return lead;
  const updated = await db.lead.update({
    where: { id: lead.id },
    data: { whatsappOptOut: true, emailOptOut: true, aiPaused: true },
  });
  await cancelRuleJobs(lead.id, "all");
  await cancelJobs(lead.id, ["sdr.first_contact", "sdr.reply", "email.send"]);
  await logEvent(lead.id, "lead.opt_out", "WhatsApp", "O lead pediu para parar as mensagens: automações, e-mails e IA desligados para ele.");
  try {
    await sendWhatsApp(updated, "Tudo certo, não vou mais te mandar mensagens automáticas. Se quiser retomar a conversa, é só escrever aqui.", "Automação");
  } catch (e) {
    await logEvent(lead.id, "whatsapp.failed", "Automação", `Confirmação de saída não enviada: ${(e as Error).message}`);
  }
  return updated;
}

export async function ensureTask(leadId: string, userId: string | null, title: string, dueAt = new Date()) {
  const open = await db.task.findFirst({ where: { leadId, title, doneAt: null } });
  if (open) return open;
  return db.task.create({ data: { leadId, userId, title, dueAt } });
}

const STATUS_BY_STAGE_KEY = Object.fromEntries(Object.entries(STAGE_KEYS).map(([status, key]) => [key, status])) as Record<
  string,
  LeadStatus
>;

/** Moves a lead (drag and drop, the AI or a rule) and starts the new stage's automations. */
export async function moveLead(leadId: string, stageId: string, actor: string, extra: Prisma.LeadUncheckedUpdateInput = {}) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  if (lead.stageId === stageId && Object.keys(extra).length === 0) return lead;
  const entering = lead.stageId !== stageId;
  const status =
    (stage.key && STATUS_BY_STAGE_KEY[stage.key]) || (stage.kind === "WON" ? "WON" : stage.kind === "LOST" ? "LOST" : lead.status);
  const updated = await db.lead.update({
    where: { id: leadId },
    data: {
      stageId,
      pipelineId: stage.pipelineId,
      status,
      ...(entering && { stageEnteredAt: new Date() }),
      ...(entering && stage.kind === "WON" && { wonAt: new Date() }),
      ...(entering && stage.kind !== "WON" && lead.stage.kind === "WON" && { wonAt: null }),
      ...extra,
    },
  });
  if (entering) {
    await queueCapi(db, updated, stage).catch(() => console.error("Meta CAPI: falha ao registrar evento na fila."));
    const crossed = stage.pipelineId !== lead.pipelineId ? " (outro funil)" : "";
    await logEvent(leadId, "stage.changed", actor, `${lead.stage.name} → ${stage.name}${crossed}`);
    if (stage.kind !== "OPEN") {
      // Closing the deal stops everything that was still scheduled for this lead
      await cancelRuleJobs(leadId, "all");
      await cancelJobs(leadId, ["sdr.first_contact", "sdr.reply", "email.send", "meeting.reminder"]);
    } else {
      await cancelRuleJobs(leadId, "stage");
    }
    await scheduleStageRules(updated);
  }
  return updated;
}
