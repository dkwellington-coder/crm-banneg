import type { Lead, LeadStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { cancelJobs, enqueue, enqueueDebounced } from "./queue";
import { normalizePhone } from "./whatsapp";
import { STAGE_KEYS } from "./plan";

export async function stageByKey(key: string) {
  const stage = await db.stage.findUnique({ where: { key } });
  if (!stage) throw new Error(`Etapa "${key}" não existe. Rode o seed (npm run db:seed).`);
  return stage;
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
  // Old leads from Kommo go to reactivation instead of getting a welcome message right away
  reactivation?: boolean;
};

export async function createLead(input: NewLeadInput, actor: string) {
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone) {
    const existing = await db.lead.findUnique({ where: { phone } });
    if (existing) {
      await logEvent(existing.id, "lead.duplicate", actor, `Entrou de novo pela origem "${input.source}".`);
      return { lead: existing, created: false };
    }
  }
  const stage = await stageByKey(STAGE_KEYS.NEW);
  const sdr = await pickSdr();
  const lead = await db.lead.create({
    data: {
      name: input.name?.trim() || null,
      phone,
      email: input.email?.trim().toLowerCase() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      source: input.source,
      campaign: input.campaign ?? null,
      externalId: input.externalId ?? null,
      stageId: stage.id,
      sdrId: sdr?.id,
    },
  });
  await logEvent(lead.id, "lead.created", actor, `Lead criado (origem: ${input.source}).`);
  if (!input.reactivation) await startAutomations(lead);
  return { lead, created: true };
}

/** What happens to every new lead: AI first contact on WhatsApp and the welcome email sequence. */
export async function startAutomations(lead: Lead) {
  if (lead.phone && lead.sdrId) {
    await enqueue("sdr.first_contact", { leadId: lead.id, dedupeKey: `first_contact:${lead.id}` });
  }
  await startEmailSequence(lead.id, "boas_vindas");
}

export async function startEmailSequence(leadId: string, prefix: string) {
  const templates = await db.emailTemplate.findMany({
    where: { active: true, key: { startsWith: prefix }, sequenceDay: { not: null } },
  });
  for (const t of templates) {
    await enqueue("email.send", {
      leadId,
      payload: { templateKey: t.key },
      runAt: new Date(Date.now() + (t.sequenceDay ?? 0) * 86_400_000 + 5 * 60_000),
      dedupeKey: `email:${leadId}:${t.key}`,
    });
  }
}

export async function handleInbound(input: { phone: string; profileName?: string; body: string; externalId: string; at: Date }) {
  const phone = normalizePhone(input.phone);
  const dup = await db.message.findUnique({ where: { externalId: input.externalId } });
  if (dup) return null;
  let lead = await db.lead.findUnique({ where: { phone } });
  if (!lead) {
    lead = (await createLead({ phone, name: input.profileName, source: "whatsapp" }, "WhatsApp")).lead;
    // The lead wrote first, so the SDR answers the message instead of sending a cold opening
    await cancelJobs(lead.id, ["sdr.first_contact"]);
  }
  await db.message.create({
    data: {
      leadId: lead.id,
      channel: "WHATSAPP",
      direction: "IN",
      body: input.body,
      author: lead.name ?? "Lead",
      status: "RECEIVED",
      externalId: input.externalId,
      createdAt: input.at,
    },
  });
  lead = await db.lead.update({
    where: { id: lead.id },
    data: { lastInboundAt: input.at, followUpStep: 0, name: lead.name ?? input.profileName ?? null },
  });
  await cancelJobs(lead.id, ["followup.check"]);
  if (lead.sdrId && !lead.aiPaused && ["NEW", "AI_QUALIFYING", "QUALIFIED", "NURTURING"].includes(lead.status)) {
    // Wait a few seconds so several short messages get one answer
    await enqueueDebounced("sdr.reply", lead.id, Number(process.env.SDR_DEBOUNCE_MS ?? 15_000));
  } else {
    await ensureTask(lead.id, lead.ownerId, "Responder mensagem do lead no WhatsApp");
  }
  return lead;
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

/** Moves a lead (drag and drop or automation) and runs the stage's automations. */
export async function moveLead(leadId: string, stageId: string, actor: string, extra: Prisma.LeadUncheckedUpdateInput = {}) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  if (lead.stageId === stageId && Object.keys(extra).length === 0) return lead;
  const status = (stage.key && STATUS_BY_STAGE_KEY[stage.key]) || (stage.kind === "WON" ? "WON" : stage.kind === "LOST" ? "LOST" : lead.status);
  const updated = await db.lead.update({
    where: { id: leadId },
    data: { stageId, status, stageEnteredAt: lead.stageId === stageId ? undefined : new Date(), ...extra },
  });
  if (lead.stageId !== stageId) {
    await logEvent(leadId, "stage.changed", actor, `${lead.stage.name} → ${stage.name}`);
    await onStageEntered(updated, stage.key);
  }
  return updated;
}

async function onStageEntered(lead: Lead, key: string | null) {
  if (key === STAGE_KEYS.NURTURING) await startEmailSequence(lead.id, "nutricao");
  if (key === "proposta") {
    await enqueue("followup.check", {
      leadId: lead.id,
      payload: { kind: "proposal" },
      runAt: new Date(Date.now() + 2 * 86_400_000),
      dedupeKey: `proposal_followup:${lead.id}:${Date.now()}`,
    });
  }
  if (key === STAGE_KEYS.WON) {
    await cancelJobs(lead.id, ["followup.check", "email.send", "sdr.reply"]);
    await ensureTask(lead.id, lead.ownerId, "Iniciar onboarding do novo franqueado");
  }
  if (key === STAGE_KEYS.LOST || key === STAGE_KEYS.DISQUALIFIED) {
    await cancelJobs(lead.id, ["followup.check", "email.send", "sdr.reply", "meeting.reminder"]);
    if (key === STAGE_KEYS.LOST) {
      // Reactivation in 90 days
      await enqueue("followup.check", {
        leadId: lead.id,
        payload: { kind: "reactivation" },
        runAt: new Date(Date.now() + 90 * 86_400_000),
        dedupeKey: `reactivation:${lead.id}:${new Date().toISOString().slice(0, 10)}`,
      });
    }
  }
}
