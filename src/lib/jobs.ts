import type { Job, Lead } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { backoffMs, cancelJobs, enqueue } from "./queue";
import { isClosed, moveToSendError, SEND_ERROR_STAGE, sendWhatsApp, type SendOutcome } from "./messaging";
import { isUndelivered, isWindowOpen } from "./whatsapp";
import { whatsappNumberFor } from "./integrations";
import { getSettings, isTestContact, messageVars } from "./settings";
import { createCalendarEvent, deleteCalendarEvent, formatSlot, freeSlotsFor, pickOwner, type Slot } from "./calendar";
import { runSdrTurn } from "./sdr";
import { NO_SHOW_STAGE, planFromDecision, STAGE_KEYS } from "./plan";
import { ensureTask, funnelStart, moveLead, sdrFor, stageByKey } from "./leads";
import { fillVariables, templateSlots, type RuleConfig } from "./rules";
import { isGreeting, type RuleJobPayload } from "./automations";
import { attachMaterials, emailHtml, renderTemplate, sendEmail, withButton } from "./email";
import { cofDocuments, sendCof } from "./cof";
import { blockedByAccount, resendSame } from "./resend";
import { aiAccountProblem, aiAnswered, setAiHealth } from "./ai-health";
import { sendPortalStatus, type PortalBody } from "./portal";

type Handler = (job: Job, lead: Lead | null) => Promise<string>;

function needLead(lead: Lead | null): Lead {
  if (!lead) throw new Error("Lead não encontrado.");
  return lead;
}

async function sdrContext(lead: Lead) {
  const settings = await getSettings();
  const [agent, knowledge, messages, pipeline, meetings] = await Promise.all([
    lead.sdrId ? db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null,
    db.knowledgeItem.findMany({ orderBy: { title: "asc" } }),
    // What never reached the lead stays out: the AI must not take a message lost to an account block as said
    db.message.findMany({ where: { leadId: lead.id, channel: "WHATSAPP", NOT: { direction: "OUT", status: "FAILED" } }, orderBy: { createdAt: "desc" }, take: 40 }),
    db.pipeline.findUnique({ where: { id: lead.pipelineId } }),
    db.meeting.findMany({ where: { leadId: lead.id }, orderBy: { startsAt: "desc" }, take: 3, select: { startsAt: true, status: true } }),
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
      funnel: pipeline ? { id: pipeline.id, name: pipeline.name, goal: pipeline.aiGoal, questions: pipeline.aiQuestions } : undefined,
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
      meetings: meetings.reverse(),
      slots,
      now: new Date(),
      cofReady: (await cofDocuments()).length > 0,
    },
  };
}

const handlers: Record<string, Handler> = {
  async "sdr.first_contact"(_job, l) {
    const lead = needLead(l);
    if (lead.aiPaused || lead.status !== "NEW") return "Ignorado: lead já em atendimento.";
    // It wrote in the minute before this ran: the AI is answering what it said, no canned opener on top
    if (lead.lastInboundAt) return "Ignorado: o lead já escreveu; a IA responde.";
    const { agent, settings } = await sdrContext(lead);
    const firstName = lead.name?.split(" ")[0];
    const body = `Olá${firstName ? `, ${firstName}` : ""}! Aqui é a ${agent.name}, do time de expansão do ${settings.companyName}. Recebi seu interesse na nossa franquia de seguros e separei um vídeo de 1 minuto que mostra como o franqueado ganha dinheiro. Posso te enviar?`;
    const res = await sendWhatsApp(lead, body, agent.name, { automatic: true, purpose: "first_contact", buttons: ["Pode enviar", "Agora não"] });
    if (res.skipped) {
      await ensureTask(lead.id, lead.ownerId, "Fazer o primeiro contato: o modelo da Meta ainda não foi aprovado");
      return res.skipped;
    }
    if (!res.ok && undelivered(res, lead)) return `Não chegou: ${res.error}`;
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
    // After a stop (no credit), the first answer clears the banner and answers the leads who waited
    await aiAnswered({ answering: lead.id });
    // Claude takes a while: meanwhile someone may have answered (which pauses the AI), closed or moved the lead,
    // or the lead asked to stop. Then this answer is stale and does not go
    const current = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    if (current.aiPaused || current.whatsappOptOut || isClosed(current) || current.stageId !== lead.stageId)
      return "Ignorado: o lead mudou enquanto a IA respondia (atendido, pausado, encerrado, movido ou pediu para parar).";
    const plan = planFromDecision(decision, slots, settings.qualifyScore);

    await db.lead.update({
      where: { id: lead.id },
      data: {
        ...plan.fields,
        score: decision.score,
        temperature: decision.temperature,
        aiSummary: decision.summary,
        qualification: { ...(lead.qualification as object), ...plan.qualification },
        ownerId: lead.ownerId ?? (["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"].includes(plan.status) ? owner?.id : undefined),
      },
    });
    await logEvent(lead.id, "ai.decision", agent.name, `${decisionLabel[decision.decision]} · score ${decision.score} · ${decision.reason}`, {
      decision: decision.decision,
      score: decision.score,
      extracted: decision.extracted,
    });

    let reply = plan.reply;
    let booked = false;
    if (plan.slot && owner) {
      const meeting = await bookMeeting(lead, owner.id, plan.slot, agent.name);
      // The time comes from the booking itself, so the lead never gets one the AI misread
      reply = `${reply}\n\nReunião: ${formatSlot(plan.slot.startsAt)} (horário de Brasília)${meeting.meetLink ? `\nLink da reunião: ${meeting.meetLink}` : ""}`;
      booked = true;
    }
    if (reply) {
      const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      const res = await sendWhatsApp(fresh, reply, agent.name);
      if (!res.ok) {
        // Nothing went yet: the turn runs again later. A meeting already booked stays booked and a person tells
        // the lead, so a retry never books a second one
        if (!booked) throw new Error(res.error);
        await ensureTask(lead.id, lead.ownerId ?? owner?.id ?? null, `Avisar o lead da reunião marcada: o WhatsApp não saiu (${res.error})`);
      }
      if (res.skipped) await logEvent(lead.id, "whatsapp.skipped", agent.name, res.skipped);
    }
    // From here the answer went out: a failure below must never run the turn again (a second, different answer)
    try {
      if (plan.stopAi) await db.lead.update({ where: { id: lead.id }, data: { aiPaused: true } });
      // The lead asked for the COF before the meeting: it goes by e-mail now, once for the same files
      if (decision.sendCof) {
        const result = await sendCof(await db.lead.findUniqueOrThrow({ where: { id: lead.id } }), agent.name, { once: true });
        await logEvent(lead.id, "cof.requested", agent.name, `O lead pediu a COF: ${result}`);
      }
      // Funnels the team built may not have the AI's stage: try the funnel this one hands leads to
      // (old leads go on to Vendas de Franquias once qualified), else only the status changes
      const target = await aiTargetStage(plan.stageKey, lead.pipelineId);
      const discarded = target?.kind === "LOST" && target.id !== lead.stageId;
      if (target) await moveLead(lead.id, target.id, agent.name, discarded ? { lostReason: discardReason(decision) } : {});
      else await db.lead.update({ where: { id: lead.id }, data: { status: plan.status } });
      if (plan.handoffTask) await ensureTask(lead.id, lead.ownerId ?? owner?.id ?? null, plan.handoffTask);
    } catch (e) {
      await logEvent(lead.id, "ai.after_reply_failed", agent.name, `A IA respondeu, mas o passo seguinte falhou: ${(e as Error).message}`);
      await ensureTask(lead.id, lead.ownerId ?? owner?.id ?? null, "Conferir o lead: a IA respondeu, mas a COF, a etapa ou a passagem para o time falhou");
    }
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
    // The greeting waits a few minutes for the lead to write first: it did, so the AI is already answering
    if (lead.lastInboundAt && lead.lastInboundAt > new Date(p.since) && (await isGreeting(rule, lead))) return "Ignorado: o lead já escreveu.";
    const origin = rule.trigger === "idle" ? `sem resposta em ${rule.stage.name}` : rule.stage.name;
    const result = await runAction(lead, rule.action, rule.config as RuleConfig, origin);
    await logEvent(lead.id, "automation.ran", "Automação", `${rule.stage.name}: ${result}`, { ruleId: rule.id });
    return result;
  },

  async "email.send"(job, l) {
    const { templateKey } = job.payload as { templateKey: string };
    return sendTemplateEmail(needLead(l), templateKey);
  },

  async "whatsapp.undelivered_emails"(_job, l) {
    return sendUndeliveredEmails(needLead(l));
  },

  async "whatsapp.other_category"(job, l) {
    const lead = needLead(l);
    const { category } = job.payload as { category: "UTILITY" | "MARKETING" };
    const label = category === "UTILITY" ? "utilidade" : "marketing";
    if (lead.lastInboundAt && lead.lastInboundAt > job.createdAt) return "Ignorado: o lead respondeu.";
    if (isClosed(lead)) return "Ignorado: lead encerrado.";
    const pipeline = await db.pipeline.findUniqueOrThrow({ where: { id: lead.pipelineId } });
    const name = sameMessage(pipeline.name)?.[category];
    const template = name ? await db.whatsAppTemplate.findFirst({ where: { name, category, active: true } }) : null;
    if (!template) {
      await moveToSendError(lead.id, `não chegou e este funil não tem mensagem de ${label} aprovada para tentar`);
      return `Sem mensagem de ${label} para tentar: lead movido para ${SEND_ERROR_STAGE.name}.`;
    }
    const sdr = (lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null) ?? (await funnelStart(lead.pipelineId)).sdr;
    const text = template.body.replace("{{1}}", firstName(lead)).replace("{{2}}", sdr?.name ?? "Duda");
    const res = await sendWhatsApp(lead, text, sdr?.name ?? "Automação", { automatic: true, templateName: template.name });
    if (res.skipped) return res.skipped;
    await logEvent(lead.id, "whatsapp.other_category", "WhatsApp", `Nova tentativa como ${label} (${template.name}): ${res.ok ? "enviada" : res.error}.`);
    return res.ok ? `Tentativa como ${label} ${sentHow(res)}.` : `Tentativa como ${label} não chegou: ${res.error}`;
  },

  async "whatsapp.resend"(job, l) {
    const lead = needLead(l);
    const [blocked] = await blockedByAccount(new Date((job.payload as { since: string }).since), lead.id);
    if (!blocked) return "Ignorado: nada para reenviar (outra mensagem já chegou ao lead ou ele saiu do atendimento).";
    const agents = await db.sdrAgent.findMany({ select: { name: true } });
    const result = blocked.waitingForAi
      ? `a IA respondeu de novo (${await handlers["sdr.reply"](job, lead)})`
      : await resendSame(blocked, new Set(agents.map((a) => a.name)));
    await logEvent(lead.id, "whatsapp.resent", "WhatsApp", `Mensagem que não saiu com a conta bloqueada: ${result}.`);
    return result;
  },

  async "portal.status"(job, l) {
    // A close queued as it was (referralClosure) goes as it is; any other notice says the lead's stage now
    return sendPortalStatus(needLead(l), (job.payload as { body?: PortalBody } | null)?.body);
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

/**
 * The reason a lead the AI discarded closes with (the store reads it in the portal): its justification, kept short.
 * Never the summary, which is written for the manager and may carry what the lead told in private.
 */
export function discardReason(decision: { reason?: string }) {
  const why = (decision.reason || "").replace(/\s+/g, " ").trim();
  return why ? `Descartado pela IA: ${why.length > 200 ? `${why.slice(0, 199)}…` : why}` : "Descartado pela IA";
}

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

type EmailOptions = {
  vars?: Record<string, string>;
  button?: { label: string; url: string };
  // The e-mails for a lead WhatsApp can't reach still go after it was moved to "Erro no WhatsApp"
  evenInSendError?: boolean;
};

async function sendTemplateEmail(lead: Lead, templateKey: string, opts: EmailOptions = {}) {
  if (!lead.email) return "Ignorado: lead sem e-mail.";
  if (lead.emailOptOut) return "Ignorado: lead pediu para não receber e-mails.";
  const sendError = opts.evenInSendError && (await db.stage.count({ where: { id: lead.stageId, key: SEND_ERROR_STAGE.key } })) > 0;
  if (isClosed(lead) && !sendError) return "Ignorado: lead encerrado.";
  const t = await db.emailTemplate.findUnique({ where: { key: templateKey } });
  if (!t || !t.active) return "Ignorado: modelo de e-mail inativo.";
  // The same e-mail never goes twice to a lead, even when two automations ask for it
  if (await db.message.count({ where: { leadId: lead.id, channel: "EMAIL", template: templateKey, status: { not: "FAILED" } } }))
    return `Ignorado: o e-mail "${t.name}" já foi enviado para este lead.`;
  const settings = await getSettings();
  // "A {{sdr}}, do nosso time de expansão": the e-mail names the SDR who is talking to this lead (or the funnel's own)
  const sdr = (lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null) ?? (await funnelStart(lead.pipelineId)).sdr;
  const vars = { ...messageVars(settings, lead, sdr?.name ?? "Duda"), ...opts.vars };
  const subject = renderTemplate(t.subject, vars);
  const { text: body, attachments } = attachMaterials(renderTemplate(t.body, vars).replace("Olá, !", "Olá!"), Object.values(settings.materials));
  const simulated = settings.testMode && !isTestContact(settings, lead.email);
  if (!simulated) await sendEmail(lead.email, subject, body, attachments, opts.button ? withButton(emailHtml(body), opts.button) : undefined);
  await db.message.create({
    data: {
      leadId: lead.id,
      channel: "EMAIL",
      direction: "OUT",
      body: `${subject}\n\n${body}`,
      author: "E-mail automático",
      status: simulated ? "SIMULATED" : "SENT",
      template: templateKey,
    },
  });
  return simulated ? `E-mail "${t.name}" simulado (modo teste).` : `E-mail "${t.name}" enviado.`;
}

// The same first message, approved by Meta as utility and as marketing, for each kind of funnel (by its name).
// When one is denied the other goes. Captação writes to people who never asked: no "we got your request".
const SAME_MESSAGE = [
  { funnel: /capta/i, UTILITY: null, MARKETING: null, welcome: null },
  { funnel: /sindicat/i, UTILITY: "banneg_sindicato_pedido", MARKETING: "banneg_sindicato_contato", welcome: null },
  { funnel: /cota|produto|seguro|cons[oó]rcio/i, UTILITY: "banneg_cotacao_recebida", MARKETING: "banneg_produtos_contato", welcome: null },
  { funnel: /franquia|expans/i, UTILITY: "banneg_cadastro_recebido", MARKETING: "banneg_primeiro_contato", welcome: "boas_vindas_0" },
];
const sameMessage = (pipelineName: string) => SAME_MESSAGE.find((m) => m.funnel.test(pipelineName));

function undelivered(res: Extract<SendOutcome, { ok: false }>, lead: Lead) {
  return isUndelivered(res.code, lead.phone);
}

/** The code the "Chamar no WhatsApp" button writes, so a lead who calls from another number keeps its history. */
export const emailCode = (leadId: string) => leadId.slice(-6).toUpperCase();
export const CONTACT_EMAIL = "whatsapp_nao_chegou";

/**
 * WhatsApp did not reach the lead: the welcome e-mail (if the funnel has one and it has not gone) and the
 * e-mail with a button that opens our WhatsApp with a message ready, so the lead can call us.
 */
async function sendUndeliveredEmails(lead: Lead) {
  if (!lead.email) return "Ignorado: lead sem e-mail.";
  const results: string[] = [];
  const pipeline = await db.pipeline.findUniqueOrThrow({ where: { id: lead.pipelineId } });
  const welcome = sameMessage(pipeline.name)?.welcome;
  if (welcome) {
    // An automation of the stage may already have the welcome on its way: that one goes, not two
    const rules = await db.automationRule.findMany({ where: { action: "email", config: { path: ["templateKey"], equals: welcome } }, select: { id: true } });
    const coming = rules.length
      ? await db.job.count({ where: { leadId: lead.id, status: "PENDING", OR: rules.map((r) => ({ payload: { path: ["ruleId"], equals: r.id } })) } })
      : 0;
    if (!coming) results.push(await sendTemplateEmail(lead, welcome, { evenInSendError: true }));
  }
  // The lead's own number: a client of the referral funnel calls Alice's number, not the main one
  const number = await whatsappNumberFor(lead);
  if (!number) return [...results, "E-mail de contato não enviado: o número do WhatsApp do CRM não foi encontrado na Meta."].join(" ");
  const settings = await getSettings();
  const text = `Oi! Recebi o e-mail do ${settings.companyName} e quero conversar. (código ${emailCode(lead.id)})`;
  const url = `https://wa.me/${number.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
  results.push(
    await sendTemplateEmail(lead, CONTACT_EMAIL, {
      vars: { link_whatsapp: url, numero_whatsapp: number },
      button: { label: "Chamar no WhatsApp", url },
      evenInSendError: true,
    }),
  );
  return results.join(" ");
}

/**
 * Does what a rule says. Throws on a failure worth retrying (WhatsApp down, SMTP error). origin names the rule (its
 * stage) in the reason of a lead it closes as lost.
 */
export async function runAction(lead: Lead, action: string, config: RuleConfig, origin?: string): Promise<string> {
  switch (action) {
    case "whatsapp": {
      if (!lead.phone) return "Ignorado: lead sem telefone.";
      const settings = await getSettings();
      const sdr = lead.sdrId ? await db.sdrAgent.findUnique({ where: { id: lead.sdrId } }) : null;
      const vars = messageVars(settings, lead, sdr?.name ?? "");
      const text = fillVariables(config.text ?? "", vars);
      if (!text) return "Ignorado: mensagem vazia.";
      const open = isWindowOpen(lead.lastInboundAt);
      // A referral's store and product have no stand-in: without them the sentence breaks ("corretora oficial da.")
      let missing = open ? [...new Set([...(config.text ?? "").matchAll(/\{\{\s*(parceiro|produto)\s*\}\}/g)].map((m) => m[1]))].filter((v) => !vars[v as "parceiro"]) : [];
      // Outside the 24 h window the template goes, each {{n}} filled with the variable the rule chose
      // (built even inside it: the window may close in the instant before sendWhatsApp looks again)
      let params: string[] | undefined;
      const template = config.templateName && config.templateParams?.length
        ? await db.whatsAppTemplate.findUnique({ where: { name: config.templateName }, select: { body: true } })
        : null;
      if (template) {
        // The template may have changed since the rule was saved, and Meta refuses a different number of variables
        const slots = templateSlots(template.body);
        const chosen = config.templateParams!.slice(0, slots);
        // Meta refuses a variable with a line break, a tab or a run of spaces
        // The name and the SDR have stand-ins, as in the rest of the CRM; the store and the product do not
        const sdrName = vars.sdr || (await sdrFor(lead.pipelineId))?.name || "";
        params = chosen.map((v) => (v === "nome" ? vars.nome || "tudo bem" : v === "sdr" ? sdrName : String(vars[v as keyof typeof vars] ?? "")).replace(/\s+/g, " ").trim());
        if (!open && chosen.length < slots)
          return `Ignorado: o modelo ${config.templateName} pede ${slots} variáveis e a automação preenche ${chosen.length}. Abra a automação e salve de novo.`;
        if (!open) missing = chosen.filter((_, i) => !params![i]);
      }
      if (missing.length) return `Ignorado: ${template && !open ? `o modelo ${config.templateName}` : "a mensagem"} usa {{${missing.join("}}, {{")}}} e este lead não tem.`;
      const res = await sendWhatsApp(lead, text, sdr?.name ?? "Automação", {
        automatic: true,
        templateName: config.templateName,
        buttons: config.buttons,
        params,
      });
      if (res.skipped) return res.skipped;
      if (!res.ok && undelivered(res, lead)) return `WhatsApp não chegou: ${res.error}`;
      if (!res.ok) throw new Error(res.error);
      return `WhatsApp ${sentHow(res)}.`;
    }
    case "email":
      return sendTemplateEmail(lead, config.templateKey ?? "");
    case "cof":
      return sendCof(lead, "Automação", { once: true });
    case "task": {
      await ensureTask(lead.id, lead.ownerId, config.title || "Falar com o lead");
      return `Tarefa criada: ${config.title}`;
    }
    case "move": {
      const to = config.toStageId ? await db.stage.findUnique({ where: { id: config.toStageId } }) : null;
      if (!to) return "Ignorado: a etapa de destino foi removida.";
      // Only a close says why: a lead already in a lost stage (this one or another) keeps the reason it was closed with,
      // maybe typed by a person
      const closed = !!lead.lostReason && (await db.stage.findUnique({ where: { id: lead.stageId }, select: { kind: true } }))?.kind === "LOST";
      const closing = to.kind === "LOST" && to.id !== lead.stageId && !closed;
      await moveLead(lead.id, to.id, "Automação", closing ? { lostReason: `Automação: ${origin ?? to.name}` } : {});
      return `Movido para ${to.name}.`;
    }
    case "ai_on": {
      const sdrId = config.sdrId || lead.sdrId || (await sdrFor(lead.pipelineId))?.id;
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
      guests: (await getSettings()).meetingGuests,
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

/** "Desmarcar" on the lead's page: off the Google agenda, reminders stopped, the time free again for the AI. */
export async function cancelMeeting(meetingId: string, actor: string) {
  const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { user: true } });
  if (!meeting || meeting.status !== "scheduled") return "Essa reunião já não estava marcada.";
  let google = "";
  if (meeting.calendarEventId && meeting.user) {
    try {
      if (await deleteCalendarEvent(meeting.user, meeting.calendarEventId)) google = " Saiu do Google Agenda.";
    } catch (e) {
      google = ` O Google Agenda falhou (${(e as Error).message}): apague o evento por lá.`;
    }
  }
  await db.meeting.update({ where: { id: meeting.id }, data: { status: "canceled" } });
  await db.job.updateMany({
    where: { leadId: meeting.leadId, type: "meeting.reminder", status: "PENDING", dedupeKey: { startsWith: `reminder:${meeting.id}:` } },
    data: { status: "CANCELLED", finishedAt: new Date(), dedupeKey: null, result: "Cancelado: reunião desmarcada." },
  });
  await logEvent(meeting.leadId, "meeting.canceled", actor, `Reunião de ${formatSlot(meeting.startsAt)} desmarcada.${google}`);
  return `Reunião desmarcada.${google}`;
}

/**
 * After the meeting began, on the lead's page or the agenda: it happened, or the lead missed it. A missed one moves the
 * lead to its funnel's "Não compareceu", whose automations ask it to book again.
 */
export async function setMeetingOutcome(meetingId: string, outcome: "done" | "no_show", actor: string) {
  const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { lead: true } });
  if (!meeting || meeting.status !== "scheduled") return "Essa reunião já tinha um resultado.";
  if (meeting.startsAt > new Date()) return "A reunião ainda não começou.";
  const when = formatSlot(meeting.startsAt);
  if (outcome === "done") {
    await db.meeting.update({ where: { id: meeting.id }, data: { status: "done" } });
    await logEvent(meeting.leadId, "meeting.done", actor, `Reunião de ${when} realizada.`);
    return "Reunião marcada como realizada.";
  }
  await db.meeting.update({ where: { id: meeting.id }, data: { status: "no_show" } });
  await logEvent(meeting.leadId, "meeting.no_show", actor, `O lead não compareceu à reunião de ${when}.`);
  const stage = await stageByKey(NO_SHOW_STAGE.key, meeting.lead.pipelineId);
  if (!stage) return `Anotado. Este funil não tem a etapa ${NO_SHOW_STAGE.name}, então nenhuma mensagem foi enviada.`;
  await moveLead(meeting.leadId, stage.id, actor);
  return `Lead em ${stage.name}: as automações dessa etapa começam agora.`;
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

// A job RUNNING this long was cut off with its server (a timeout or a deploy)
const STUCK_MS = 15 * 60_000;
// The cron call stops taking jobs after this, so the server is never killed in the middle of one
const RUN_BUDGET_MS = 45_000;
const PORTAL_JOB = "portal.status";
// Each may wait PORTAL_TIMEOUT_MS for the portal
const PORTAL_PER_RUN = 3;

/**
 * Jobs cut off in the middle stay RUNNING with their dedupe key, and block the same job for the lead forever. They
 * fail with a task for the team instead of running again: the message may have gone before the cut. A notice to the
 * portal goes again instead, while it has attempts left: the portal takes the same notice twice harmlessly (by "em").
 */
async function failStuckJobs() {
  const stuck = await db.job.findMany({
    // Meta CAPI jobs have their own recovery (runCapi)
    where: { status: "RUNNING", type: { not: "meta.capi" }, runAt: { lt: new Date(Date.now() - STUCK_MS) } },
    select: { id: true, type: true, leadId: true, attempts: true, maxAttempts: true, lead: { select: { ownerId: true } } },
    take: 50,
  });
  const cut = "Interrompida no meio (o servidor parou).";
  for (const job of stuck) {
    const again = job.type === PORTAL_JOB && job.attempts < job.maxAttempts;
    const done = await db.job.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: again ? { status: "PENDING", lastError: cut, runAt: new Date() } : { status: "FAILED", lastError: cut, finishedAt: new Date(), dedupeKey: null },
    });
    if (done.count && job.leadId && !again) {
      await logEvent(job.leadId, "automation.failed", "Automação", `Interrompida no meio (${job.type}); não roda de novo sozinha.`);
      await ensureTask(job.leadId, job.lead?.ownerId ?? null, `Automação interrompida (${job.type}): verificar`);
    }
  }
}

/** Runs due jobs. Called every minute by the scheduler (cron hitting /api/cron). */
export async function runDueJobs(limit = 20) {
  const deadline = Date.now() + RUN_BUDGET_MS;
  await failStuckJobs();
  const now = new Date();
  // The portal's notices go after the rest, a few per run: a portal that hangs never holds the AI's replies back
  const due = [
    ...(await db.job.findMany({
      where: { status: "PENDING", type: { notIn: ["meta.capi", PORTAL_JOB] }, runAt: { lte: now } },
      orderBy: { runAt: "asc" },
      take: limit,
    })),
    ...(await db.job.findMany({ where: { status: "PENDING", type: PORTAL_JOB, runAt: { lte: now } }, orderBy: { runAt: "asc" }, take: PORTAL_PER_RUN })),
  ];
  const results: { id: string; type: string; ok: boolean; result: string }[] = [];
  for (const job of due) {
    if (Date.now() > deadline) break;
    // Claim the job so two schedulers never run it twice; while RUNNING, runAt is when it started
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "RUNNING", attempts: { increment: 1 }, runAt: new Date() },
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
      // The Anthropic account stopped (no credit, key revoked): every screen says so until the AI answers again
      const aiProblem = job.type.startsWith("sdr.") ? aiAccountProblem(e) : null;
      if (aiProblem) await setAiHealth(aiProblem);
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
