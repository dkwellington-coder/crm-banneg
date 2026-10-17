import type { Job, Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { backoffMs, cancelJobs, enqueue } from "./queue";
import { sendWhatsApp } from "./messaging";
import { getSettings, isTestContact, messageVars } from "./settings";
import { createCalendarEvent, formatSlot, freeSlotsFor, pickOwner, type Slot } from "./calendar";
import { runSdrTurn } from "./sdr";
import { planFromDecision, STAGE_KEYS } from "./plan";
import { ensureTask, moveLead, pickSdr, stageByKey } from "./leads";
import { fillVariables, type RuleConfig } from "./rules";
import type { RuleJobPayload } from "./automations";
import { attachMaterials, renderTemplate, sendEmail } from "./email";

type Handler = (job: Job, lead: Lead | null) => Promise<string>;

function needLead(lead: Lead | null): Lead {
  if (!lead) throw new Error("Lead não encontrado.");
  return lead;
}

async function sdrContext(lead: Lead) {
  const settings = await getSettings();
  const [agent, knowledge, messages, pipeline] = await Promise.all([
    lead.sdrId ? db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null,
    db.knowledgeItem.findMany({ orderBy: { title: "asc" } }),
    db.message.findMany({ where: { leadId: lead.id, channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, take: 40 }),
    db.pipeline.findUnique({ where: { id: lead.pipelineId } }),
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
      funnel: pipeline ? { name: pipeline.name, goal: pipeline.aiGoal, questions: pipeline.aiQuestions } : undefined,
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
    const body = `Olá${firstName ? `, ${firstName}` : ""}! Aqui é a ${agent.name}, do time de expansão do ${settings.companyName}. Recebi seu interesse na nossa franquia de seguros e separei um vídeo de 1 minuto que mostra como o franqueado ganha dinheiro. Posso te enviar?`;
    const res = await sendWhatsApp(lead, body, agent.name, { automatic: true, purpose: "first_contact", buttons: ["Pode enviar", "Agora não"] });
    if (res.skipped) {
      await ensureTask(lead.id, lead.ownerId, "Fazer o primeiro contato: o modelo da Meta ainda não foi aprovado");
      return res.skipped;
    }
    if (!res.ok) throw new Error(res.error);
    const next = await stageByKey(STAGE_KEYS.AI_QUALIFYING, lead.pipelineId);
    if (next) await moveLead(lead.id, next.id, agent.name);
    else await db.lead.update({ where: { id: lead.id }, data: { status: "AI_QUALIFYING" } });
    return `Primeiro contato ${sentHow(res)}.`;
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
      // The time comes from the booking itself, so the lead never gets one the AI misread
      reply = `${reply}\n\nReunião: ${formatSlot(plan.slot.startsAt)} (horário de Brasília)${meeting.meetLink ? `\nLink da reunião: ${meeting.meetLink}` : ""}`;
    }
    if (reply) {
      const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      const res = await sendWhatsApp(fresh, reply, agent.name);
      if (!res.ok) throw new Error(res.error);
      if (res.skipped) await logEvent(lead.id, "whatsapp.skipped", agent.name, res.skipped);
    }
    // Funnels the team built may not have the AI's stage: try the funnel this one hands leads to
    // (old leads go on to Vendas de Franquias once qualified), else only the status changes
    const target = await aiTargetStage(plan.stageKey, lead.pipelineId);
    if (target) await moveLead(lead.id, target.id, agent.name);
    else await db.lead.update({ where: { id: lead.id }, data: { status: plan.status } });
    if (plan.handoffTask) await ensureTask(lead.id, lead.ownerId ?? owner?.id ?? null, plan.handoffTask);
    return `${decisionLabel[decision.decision]} (score ${decision.score})`;
  },

  async "rule.run"(job, l) {
    const lead = needLead(l);
    const p = job.payload as RuleJobPayload;
    const rule = await db.automationRule.findUnique({ where: { id: p.ruleId }, include: { stage: true } });
    if (!rule || !rule.active) return "Ignorado: automação desligada ou removida.";
    const stillThere = lead.stageId === p.stageId && lead.stageEnteredAt.toISOString() === p.enteredAt;
    if (!p.keep && !stillThere) return "Ignorado: o lead já saiu da etapa.";
    if (p.idle && lead.lastInboundAt && lead.lastInboundAt > new Date(p.since)) return "Ignorado: o lead respondeu.";
    const result = await runAction(lead, rule.action, rule.config as RuleConfig);
    await logEvent(lead.id, "automation.ran", "Automação", `${rule.stage.name}: ${result}`, { ruleId: rule.id });
    return result;
  },

  async "email.send"(job, l) {
    const { templateKey } = job.payload as { templateKey: string };
    return sendTemplateEmail(needLead(l), templateKey);
  },

  async "meeting.reminder"(job, l) {
    const lead = needLead(l);
    const { meetingId, label } = job.payload as { meetingId: string; label: string };
    const meeting = await db.meeting.findUnique({ where: { id: meetingId } });
    if (!meeting || meeting.status !== "scheduled") return "Ignorado: reunião cancelada.";
    const text = `Lembrete: nossa reunião é ${label}, ${formatSlot(meeting.startsAt)}.${meeting.meetLink ? ` Link: ${meeting.meetLink}` : ""} Até lá!`;
    // An hour before, with the window closed, the approved template that carries the time and the Meet link
    const withLink = label === "daqui a 1 hora" && meeting.meetLink;
    const res = await sendWhatsApp(lead, text, "Automação", {
      automatic: true,
      purpose: "reminder",
      ...(withLink && { templateName: MEETING_TEMPLATES.reminder, params: [firstName(lead), timeOf(meeting.startsAt), meeting.meetLink!] }),
    });
    if (res.skipped) return res.skipped;
    if (!res.ok) throw new Error(res.error);
    return `Lembrete ${sentHow(res)}.`;
  },
};

async function aiTargetStage(key: string, pipelineId: string) {
  const own = await stageByKey(key, pipelineId);
  if (own) return own;
  const pipeline = await db.pipeline.findUnique({ where: { id: pipelineId } });
  return pipeline?.nextPipelineId ? stageByKey(key, pipeline.nextPipelineId) : null;
}

/** "enviado", "simulado (modo teste)", "enviado pelo modelo da Meta"... for the job history. */
function sentHow(res: { usedTemplate?: boolean; simulated?: boolean }) {
  const how = res.simulated ? "simulado (modo teste)" : "enviado";
  return res.usedTemplate ? `${how} pelo modelo da Meta (janela de 24 h fechada)` : how;
}

const decisionLabel: Record<string, string> = {
  continue: "Qualificando",
  offer_meeting: "Ofereceu reunião",
  book_meeting: "Marcou reunião",
  handoff: "Passou para o gerente",
  nurture: "Enviou para nutrição",
  disqualify: "Descartou",
};

async function sendTemplateEmail(lead: Lead, templateKey: string) {
  if (!lead.email) return "Ignorado: lead sem e-mail.";
  if (lead.emailOptOut) return "Ignorado: lead pediu para não receber e-mails.";
  if (["DISQUALIFIED", "WON", "LOST"].includes(lead.status)) return "Ignorado: lead encerrado.";
  const t = await db.emailTemplate.findUnique({ where: { key: templateKey } });
  if (!t || !t.active) return "Ignorado: modelo de e-mail inativo.";
  const settings = await getSettings();
  // "A {{sdr}}, do nosso time de expansão": the e-mail names the SDR who is talking to this lead
  const sdr = lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null;
  const vars = messageVars(settings, lead, sdr?.name ?? "Duda");
  const subject = renderTemplate(t.subject, vars);
  const { text: body, attachments } = attachMaterials(renderTemplate(t.body, vars), Object.values(settings.materials));
  const simulated = settings.testMode && !isTestContact(settings, lead.email);
  if (!simulated) await sendEmail(lead.email, subject, body, attachments);
  await db.message.create({
    data: {
      leadId: lead.id,
      channel: "EMAIL",
      direction: "OUT",
      body: `${subject}\n\n${body}`,
      author: "E-mail automático",
      status: simulated ? "SIMULATED" : "SENT",
    },
  });
  return simulated ? `E-mail "${t.name}" simulado (modo teste).` : `E-mail "${t.name}" enviado.`;
}

/** Does what a rule says. Throws on a failure worth retrying (WhatsApp down, SMTP error). */
export async function runAction(lead: Lead, action: string, config: RuleConfig): Promise<string> {
  switch (action) {
    case "whatsapp": {
      if (!lead.phone) return "Ignorado: lead sem telefone.";
      const settings = await getSettings();
      const sdr = lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null;
      const text = fillVariables(config.text ?? "", messageVars(settings, lead, sdr?.name ?? ""));
      if (!text) return "Ignorado: mensagem vazia.";
      const res = await sendWhatsApp(lead, text, sdr?.name ?? "Automação", {
        automatic: true,
        templateName: config.templateName,
        buttons: config.buttons,
      });
      if (res.skipped) return res.skipped;
      if (!res.ok) throw new Error(res.error);
      return `WhatsApp ${sentHow(res)}.`;
    }
    case "email":
      return sendTemplateEmail(lead, config.templateKey ?? "");
    case "task": {
      await ensureTask(lead.id, lead.ownerId, config.title || "Falar com o lead");
      return `Tarefa criada: ${config.title}`;
    }
    case "move": {
      const to = config.toStageId ? await db.stage.findUnique({ where: { id: config.toStageId } }) : null;
      if (!to) return "Ignorado: a etapa de destino foi removida.";
      await moveLead(lead.id, to.id, "Automação");
      return `Movido para ${to.name}.`;
    }
    case "ai_on": {
      const sdrId = config.sdrId || lead.sdrId || (await pickSdr())?.id;
      if (!sdrId) return "Ignorado: nenhuma SDR de IA ativa.";
      await db.lead.update({ where: { id: lead.id }, data: { aiPaused: false, sdrId } });
      if (!lead.lastInboundAt && !lead.lastContactAt && lead.phone) {
        await enqueue("sdr.first_contact", { leadId: lead.id, dedupeKey: `first_contact:${lead.id}` });
        return "IA ativada; primeiro contato a caminho.";
      }
      return "IA ativada.";
    }
    case "ai_off":
      await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
      await cancelJobs(lead.id, ["sdr.first_contact", "sdr.reply"]);
      return "IA pausada.";
    default:
      throw new Error(`Ação desconhecida: ${action}`);
  }
}

export async function bookMeeting(lead: Lead, userId: string, slot: Slot, actor: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  let calendar: { id: string; meetLink: string | null } | null = null;
  try {
    calendar = await createCalendarEvent({
      user,
      summary: `Reunião Banneg · ${lead.name ?? lead.phone}`,
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

// Approved by Meta (they came over from the old CRM): they carry the date, the time and the Meet link
export const MEETING_TEMPLATES = { confirmed: "banneg_reuniao_confirmada_v1", reminder: "banneg_lembrete_reuniao_v1" } as const;

const firstName = (lead: Pick<Lead, "name">) => (lead.name ?? "").split(" ")[0] || "tudo bem";
const timeOf = (d: Date) => d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
const dayOf = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" });

/**
 * A meeting booked by someone on the team, from the lead's page: on the Google agenda with a Meet link,
 * the lead moves to "Reunião marcada" (that stage's automations run, as when the AI books) and gets the link.
 */
export async function scheduleMeeting(lead: Lead, opts: { userId: string; slot: Slot; actor: string; notify: boolean }) {
  const meeting = await bookMeeting(lead, opts.userId, opts.slot, opts.actor);
  const target = await aiTargetStage(STAGE_KEYS.MEETING_BOOKED, lead.pipelineId);
  if (target) await moveLead(lead.id, target.id, opts.actor, { ownerId: lead.ownerId ?? opts.userId });
  else await db.lead.update({ where: { id: lead.id }, data: { status: "MEETING_BOOKED", ownerId: lead.ownerId ?? opts.userId } });
  const sent = opts.notify ? await sendMeetingLink(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), meeting, opts.actor) : null;
  return { meeting, sent };
}

/** Sends the date and the Meet link: free text inside the 24-hour window, the approved template outside it. */
export async function sendMeetingLink(lead: Lead, meeting: { startsAt: Date; meetLink: string | null }, actor: string) {
  if (!lead.phone) return lead.email && meeting.meetLink ? "Lead sem WhatsApp: o convite foi pelo e-mail do Google." : "Lead sem WhatsApp: avise o lead por outro meio.";
  const when = `${dayOf(meeting.startsAt)}, às ${timeOf(meeting.startsAt)}`;
  const text = `Olá, ${firstName(lead)}! Sua reunião com o Banneg está confirmada para ${when} (horário de Brasília).${
    meeting.meetLink ? `\n\nLink do Google Meet: ${meeting.meetLink}` : ""
  }\n\nSe precisar remarcar, é só responder esta mensagem.`;
  // Without a link there is no approved template to carry the meeting: it waits for the lead to write
  const res = await sendWhatsApp(lead, text, actor, {
    automatic: !meeting.meetLink,
    ...(meeting.meetLink && { templateName: MEETING_TEMPLATES.confirmed, params: [firstName(lead), dayOf(meeting.startsAt), timeOf(meeting.startsAt), meeting.meetLink] }),
  });
  if (res.skipped) {
    await logEvent(lead.id, "whatsapp.skipped", actor, res.skipped);
    return res.skipped;
  }
  const what = meeting.meetLink ? "Link da reunião" : "Aviso da reunião";
  if (!res.ok) return `${what} não enviado: ${res.error}`;
  return `${what} ${sentHow(res)}.`;
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
  return results;
}
