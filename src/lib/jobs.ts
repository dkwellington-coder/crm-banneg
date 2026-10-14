import type { Job, Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { backoffMs, enqueue } from "./queue";
import { sendWhatsApp } from "./messaging";
import { getSettings } from "./settings";
import { createCalendarEvent, formatSlot, freeSlotsFor, pickOwner, type Slot } from "./calendar";
import { runSdrTurn } from "./sdr";
import { planFromDecision, STAGE_KEYS } from "./plan";
import { ensureTask, moveLead, stageByKey, startEmailSequence } from "./leads";
import { renderTemplate, sendEmail } from "./email";

type Handler = (job: Job, lead: Lead | null) => Promise<string>;

function needLead(lead: Lead | null): Lead {
  if (!lead) throw new Error("Lead não encontrado.");
  return lead;
}

async function sdrContext(lead: Lead) {
  const settings = await getSettings();
  const [agent, knowledge, messages] = await Promise.all([
    lead.sdrId ? db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null,
    db.knowledgeItem.findMany({ orderBy: { title: "asc" } }),
    db.message.findMany({ where: { leadId: lead.id, channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, take: 40 }),
  ]);
  if (!agent) throw new Error("Lead sem SDR de IA atribuída.");
  const owner = lead.ownerId ? await db.user.findUnique({ where: { id: lead.ownerId } }) : await pickOwner();
  const slots: Slot[] = owner ? await freeSlotsFor(owner.id, settings.businessHours, settings.meetingMinutes) : [];
  return {
    settings,
    agent,
    owner,
    slots,
    ctx: {
      agentName: agent.name,
      persona: agent.persona,
      settings,
      knowledge,
      lead: {
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        city: lead.city,
        state: lead.state,
        source: lead.source,
        qualification: lead.qualification as Record<string, unknown>,
        summary: lead.aiSummary,
      },
      transcript: messages.reverse().map((m) => ({ direction: m.direction, author: m.author, body: m.body, at: m.createdAt })),
      slots,
      now: new Date(),
    },
  };
}

const handlers: Record<string, Handler> = {
  async "sdr.first_contact"(_job, l) {
    const lead = needLead(l);
    if (lead.aiPaused || lead.status !== "NEW") return "Ignorado: lead já em atendimento.";
    const { agent, settings } = await sdrContext(lead);
    const firstName = lead.name?.split(" ")[0];
    const body = `Olá${firstName ? `, ${firstName}` : ""}! Aqui é a ${agent.name}, da ${settings.companyName}. Recebi seu interesse na nossa franquia e queria entender um pouco do seu momento para te passar as informações certas. Pode falar agora?`;
    const res = await sendWhatsApp(lead, body, agent.name, "first_contact");
    if (!res.ok) throw new Error(res.error);
    await moveLead(lead.id, (await stageByKey(STAGE_KEYS.AI_QUALIFYING)).id, agent.name);
    await scheduleFollowUp(lead.id, 0);
    return res.usedTemplate ? "Primeiro contato enviado por modelo aprovado." : "Primeiro contato enviado.";
  },

  async "sdr.reply"(_job, l) {
    const lead = needLead(l);
    if (lead.aiPaused) return "Ignorado: IA pausada neste lead.";
    const { ctx, slots, settings, agent, owner } = await sdrContext(lead);
    const decision = await runSdrTurn(ctx);
    const plan = planFromDecision(decision, slots, settings.qualifyScore);

    await db.lead.update({
      where: { id: lead.id },
      data: {
        ...plan.fields,
        score: decision.score,
        temperature: decision.temperature,
        aiSummary: decision.summary,
        qualification: { ...(lead.qualification as object), ...plan.qualification },
        aiPaused: plan.stopAi,
        ownerId: lead.ownerId ?? (["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"].includes(plan.status) ? owner?.id : undefined),
      },
    });
    await logEvent(lead.id, "ai.decision", agent.name, `${decisionLabel[decision.decision]} · score ${decision.score} · ${decision.reason}`, {
      decision: decision.decision,
      score: decision.score,
      extracted: decision.extracted,
    });

    let reply = plan.reply;
    if (plan.slot && owner) {
      const meeting = await bookMeeting(lead, owner.id, plan.slot, agent.name);
      if (meeting.meetLink) reply = `${reply}\n\nLink da reunião: ${meeting.meetLink}`;
    }
    if (reply) {
      const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      const res = await sendWhatsApp(fresh, reply, agent.name);
      if (!res.ok) throw new Error(res.error);
    }
    await moveLead(lead.id, (await stageByKey(plan.stageKey)).id, agent.name);
    if (plan.handoffTask) await ensureTask(lead.id, lead.ownerId ?? owner?.id ?? null, plan.handoffTask);
    if (!plan.stopAi) await scheduleFollowUp(lead.id, 0);
    return `${decisionLabel[decision.decision]} (score ${decision.score})`;
  },

  async "followup.check"(job, l) {
    const lead = needLead(l);
    const payload = job.payload as { kind?: string; step?: number; since?: string };
    const settings = await getSettings();
    if (payload.kind === "proposal") {
      const answered = lead.lastInboundAt && lead.lastInboundAt > job.createdAt;
      if (answered) return "Lead respondeu depois da proposta.";
      await ensureTask(lead.id, lead.ownerId, "Cobrar retorno da proposta enviada há 2 dias");
      return "Tarefa de follow-up da proposta criada.";
    }
    if (payload.kind === "reactivation") {
      if (lead.status !== "LOST") return "Lead não está mais perdido.";
      await moveLead(lead.id, (await stageByKey(STAGE_KEYS.NEW)).id, "Automação", { aiPaused: false, followUpStep: 0 });
      await enqueue("sdr.first_contact", { leadId: lead.id, dedupeKey: `first_contact:${lead.id}:${Date.now()}` });
      return "Lead reativado após 90 dias.";
    }
    // No-answer cadence while the SDR is qualifying
    if (lead.aiPaused || !["AI_QUALIFYING", "QUALIFIED"].includes(lead.status)) return "Ignorado: lead fora da qualificação.";
    const since = payload.since ? new Date(payload.since) : job.createdAt;
    if (lead.lastInboundAt && lead.lastInboundAt > since) return "Lead respondeu; follow-up cancelado.";
    const step = payload.step ?? 0;
    const agent = lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null;
    const name = lead.name?.split(" ")[0] ?? "";
    const texts = [
      `Oi${name ? `, ${name}` : ""}! Conseguiu ver minha mensagem? Fico à disposição para tirar suas dúvidas sobre a franquia.`,
      `${name ? `${name}, ` : ""}passando para saber se ainda faz sentido conversarmos sobre a franquia ${settings.companyName}.`,
      `Vou encerrar por aqui para não te incomodar${name ? `, ${name}` : ""}. Se quiser retomar, é só responder esta mensagem.`,
    ];
    const res = await sendWhatsApp(lead, texts[Math.min(step, texts.length - 1)], agent?.name ?? "Automação", "followup");
    if (!res.ok) throw new Error(res.error);
    await db.lead.update({ where: { id: lead.id }, data: { followUpStep: step + 1 } });
    if (step + 1 >= settings.followUpDays.length) {
      await moveLead(lead.id, (await stageByKey(STAGE_KEYS.NURTURING)).id, "Automação");
      return `Follow-up ${step + 1} enviado; sem resposta, lead foi para nutrição.`;
    }
    await scheduleFollowUp(lead.id, step + 1);
    return `Follow-up ${step + 1} enviado.`;
  },

  async "email.send"(job, l) {
    const lead = needLead(l);
    const { templateKey } = job.payload as { templateKey: string };
    if (!lead.email) return "Ignorado: lead sem e-mail.";
    if (lead.emailOptOut) return "Ignorado: lead pediu para não receber e-mails.";
    if (["DISQUALIFIED", "WON", "LOST"].includes(lead.status)) return "Ignorado: lead encerrado.";
    const t = await db.emailTemplate.findUnique({ where: { key: templateKey } });
    if (!t || !t.active) return "Ignorado: modelo de e-mail inativo.";
    const settings = await getSettings();
    const vars = {
      nome: lead.name?.split(" ")[0] ?? "",
      empresa: settings.companyName,
      cidade: lead.city ?? "",
      apresentacao: settings.presentationUrl,
    };
    const subject = renderTemplate(t.subject, vars);
    const body = renderTemplate(t.body, vars);
    await sendEmail(lead.email, subject, body);
    await db.message.create({
      data: { leadId: lead.id, channel: "EMAIL", direction: "OUT", body: `${subject}\n\n${body}`, author: "E-mail automático", status: "SENT" },
    });
    return `E-mail "${t.name}" enviado.`;
  },

  async "meeting.reminder"(job, l) {
    const lead = needLead(l);
    const { meetingId, label } = job.payload as { meetingId: string; label: string };
    const meeting = await db.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting || meeting.status !== "scheduled") return "Ignorado: reunião cancelada.";
    const text = `Lembrete: nossa reunião é ${label}, ${formatSlot(meeting.startsAt)}.${meeting.meetLink ? ` Link: ${meeting.meetLink}` : ""} Até lá!`;
    const res = await sendWhatsApp(lead, text, "Automação", "reminder");
    if (!res.ok) throw new Error(res.error);
    return "Lembrete enviado.";
  },
};

const decisionLabel: Record<string, string> = {
  continue: "Qualificando",
  offer_meeting: "Ofereceu reunião",
  book_meeting: "Marcou reunião",
  handoff: "Passou para o gerente",
  nurture: "Enviou para nutrição",
  disqualify: "Descartou",
};

export async function scheduleFollowUp(leadId: string, step: number) {
  const settings = await getSettings();
  const days = settings.followUpDays[step];
  if (days === undefined) return;
  await enqueue("followup.check", {
    leadId,
    payload: { step, since: new Date().toISOString() },
    runAt: new Date(Date.now() + days * 86_400_000),
    dedupeKey: `followup:${leadId}:${step}:${new Date().toISOString().slice(0, 13)}`,
  });
}

export async function bookMeeting(lead: Lead, userId: string, slot: Slot, actor: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  let calendar: { id: string; meetLink: string | null } | null = null;
  try {
    calendar = await createCalendarEvent({
      calendarId: user.calendarId ?? user.email,
      summary: `Reunião de franquia · ${lead.name ?? lead.phone}`,
      description: `Agendada por ${actor} pelo CRM.\n\n${lead.aiSummary ?? ""}`,
      slot,
      attendeeEmail: lead.email,
    });
  } catch (e) {
    await logEvent(lead.id, "calendar.failed", actor, `Reunião salva no CRM, mas o Google Agenda falhou: ${(e as Error).message}`);
  }
  const meeting = await db.meeting.create({
    data: {
      leadId: lead.id,
      userId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      calendarEventId: calendar?.id,
      meetLink: calendar?.meetLink,
    },
  });
  await logEvent(lead.id, "meeting.booked", actor, `Reunião marcada com ${user.name}: ${formatSlot(slot.startsAt)}.`);
  for (const [hours, label] of [
    [24, "amanhã"],
    [1, "daqui a 1 hora"],
  ] as const) {
    const runAt = new Date(slot.startsAt.getTime() - hours * 3600_000);
    if (runAt > new Date()) {
      await enqueue("meeting.reminder", {
        leadId: lead.id,
        payload: { meetingId: meeting.id, label },
        runAt,
        dedupeKey: `reminder:${meeting.id}:${hours}`,
      });
    }
  }
  return meeting;
}

/** Runs due jobs. Called every minute by the scheduler (cron hitting /api/cron). */
export async function runDueJobs(limit = 20) {
  const due = await db.job.findMany({
    where: { status: "PENDING", runAt: { lte: new Date() } },
    orderBy: { runAt: "asc" },
    take: limit,
  });
  const results: { id: string; type: string; ok: boolean; result: string }[] = [];
  for (const job of due) {
    // Claim the job so two schedulers never run it twice
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "RUNNING", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;
    const handler = handlers[job.type];
    const lead = job.leadId ? await db.lead.findUnique({ where: { id: job.leadId } }) : null;
    try {
      if (!handler) throw new Error(`Tipo de tarefa desconhecido: ${job.type}`);
      const result = await handler(job, lead);
      await db.job.update({ where: { id: job.id }, data: { status: "DONE", result, finishedAt: new Date(), dedupeKey: null } });
      results.push({ id: job.id, type: job.type, ok: true, result });
    } catch (e) {
      const message = (e as Error).message;
      const attempts = job.attempts + 1;
      const failed = attempts >= job.maxAttempts;
      await db.job.update({
        where: { id: job.id },
        data: failed
          ? { status: "FAILED", lastError: message, finishedAt: new Date(), dedupeKey: null }
          : { status: "PENDING", lastError: message, runAt: new Date(Date.now() + backoffMs(attempts)) },
      });
      if (job.leadId && failed) {
        await logEvent(job.leadId, "automation.failed", "Automação", `Falhou depois de ${attempts} tentativas: ${message}`);
        await ensureTask(job.leadId, lead?.ownerId ?? null, `Automação falhou (${job.type}): verificar`);
      }
      results.push({ id: job.id, type: job.type, ok: false, result: message });
    }
  }
  await sweepStaleLeads();
  return results;
}

/** Leads parked longer than their stage allows get a task for the owner. */
async function sweepStaleLeads() {
  const stages = await db.stage.findMany({ where: { staleAfterDays: { not: null } } });
  for (const stage of stages) {
    const cutoff = new Date(Date.now() - stage.staleAfterDays! * 86_400_000);
    const stale = await db.lead.findMany({ where: { stageId: stage.id, stageEnteredAt: { lt: cutoff } }, take: 50 });
    for (const lead of stale) {
      await ensureTask(lead.id, lead.ownerId, `Lead parado há mais de ${stage.staleAfterDays} dias em "${stage.name}"`);
    }
  }
}

export { startEmailSequence };
