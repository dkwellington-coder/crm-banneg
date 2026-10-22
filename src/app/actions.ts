"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, login, logout, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { createLead, defaultPipeline, moveLead } from "@/lib/leads";
import { sendWhatsApp } from "@/lib/messaging";
import { clearAlerts } from "@/lib/alerts";
import { enqueue } from "@/lib/queue";
import { getSettings, saveSettings } from "@/lib/settings";
import { getHealth, savedWhatsAppNumbers } from "@/lib/whatsapp";
import { importLeads, importSummary } from "@/lib/import";
import { ACTIONS, UNITS, type RuleConfig } from "@/lib/rules";
import { METRICS } from "@/lib/goals";
import { sendCof } from "@/lib/cof";
import { inviteGuestsToUpcoming } from "@/lib/calendar";
import { scheduleResends } from "@/lib/resend";

export async function loginAction(_: unknown, form: FormData) {
  const user = await login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (user === "locked") return { error: "Muitas tentativas erradas com este e-mail. Espere 15 minutos e tente de novo." };
  if (!user) return { error: "E-mail ou senha incorretos." };
  redirect("/funil");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}

export async function moveLeadAction(leadId: string, stageId: string) {
  const user = await requireUser();
  await moveLead(leadId, stageId, user.name);
  await clearAlerts(leadId);
  revalidatePath("/funil");
}

/** "Marcar como visto": the lead stops alerting until it writes again. */
export async function markAlertSeenAction(leadId: string) {
  const user = await requireUser();
  await clearAlerts(leadId);
  await logEvent(leadId, "alert.seen", user.name, "Aviso marcado como visto.");
  revalidatePath("/funil");
  revalidatePath("/conversas");
  revalidatePath(`/leads/${leadId}`);
}

/** The team's "Enviar COF agora": always sends, even if the lead already got these files. */
export async function sendCofAction(leadId: string) {
  const user = await requireUser();
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const result = await sendCof(lead, user.name);
  await logEvent(leadId, "cof.button", user.name, result);
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/configuracoes");
}

/** Takes a document out of the next COFs. The file stays saved: COFs already sent point to it. */
export async function removeDocumentAction(id: string) {
  await requireManager();
  await db.franchiseDocument.update({ where: { id }, data: { active: false } });
  revalidatePath("/configuracoes");
}

export async function createLeadAction(form: FormData) {
  const user = await requireUser();
  const { lead } = await createLead(
    {
      name: String(form.get("name") ?? ""),
      phone: String(form.get("phone") ?? "") || null,
      email: String(form.get("email") ?? "") || null,
      city: String(form.get("city") ?? "") || null,
      source: "manual",
      pipelineId: String(form.get("pipelineId") ?? "") || null,
      seen: true,
    },
    user.name,
  );
  redirect(`/leads/${lead.id}`);
}

export async function sendMessageAction(leadId: string, form: FormData) {
  const user = await requireUser();
  const body = String(form.get("body") ?? "").trim();
  if (!body) return;
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const res = await sendWhatsApp(lead, body, user.name);
  if (res.ok) await clearAlerts(leadId);
  if (res.ok && !lead.aiPaused) {
    // A person answered: the AI steps back so the two never talk over each other
    await db.lead.update({ where: { id: leadId }, data: { aiPaused: true } });
    await logEvent(leadId, "ai.paused", user.name, "IA pausada: atendimento humano assumiu.");
  }
  revalidatePath(`/leads/${leadId}`);
}

export async function addNoteAction(leadId: string, form: FormData) {
  const user = await requireUser();
  const body = String(form.get("note") ?? "").trim();
  if (!body) return;
  await db.message.create({ data: { leadId, channel: "NOTE", direction: "OUT", body, author: user.name, status: "SENT" } });
  revalidatePath(`/leads/${leadId}`);
}

export async function toggleAiAction(leadId: string) {
  const user = await requireUser();
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const aiPaused = !lead.aiPaused;
  await db.lead.update({ where: { id: leadId }, data: { aiPaused } });
  await logEvent(leadId, aiPaused ? "ai.paused" : "ai.resumed", user.name, aiPaused ? "IA pausada." : "IA retomou o atendimento.");
  if (!aiPaused && lead.lastInboundAt) {
    await enqueue("sdr.reply", { leadId, dedupeKey: `sdr.reply:${leadId}:resume:${Date.now()}` });
  }
  revalidatePath(`/leads/${leadId}`);
}

export async function assignSdrAction(leadId: string, form: FormData) {
  const user = await requireUser();
  const sdrId = String(form.get("sdrId") ?? "") || null;
  await db.lead.update({ where: { id: leadId }, data: { sdrId } });
  await logEvent(leadId, "ai.assigned", user.name, sdrId ? "SDR de IA trocada." : "SDR de IA removida.");
  revalidatePath(`/leads/${leadId}`);
}

export async function updateLeadAction(leadId: string, form: FormData) {
  const user = await requireUser();
  const pick = (k: string) => String(form.get(k) ?? "").trim() || null;
  await db.lead.update({
    where: { id: leadId },
    data: {
      name: pick("name"),
      email: pick("email")?.toLowerCase() ?? null,
      city: pick("city"),
      state: pick("state"),
      ownerId: pick("ownerId"),
      value: parseMoney(pick("value")),
      emailOptOut: form.get("emailOptOut") === "on",
      whatsappOptOut: form.get("whatsappOptOut") === "on",
    },
  });
  await logEvent(leadId, "lead.updated", user.name, "Dados do lead atualizados.");
  revalidatePath(`/leads/${leadId}`);
}

export async function completeTaskAction(taskId: string) {
  await requireUser();
  const task = await db.task.update({ where: { id: taskId }, data: { doneAt: new Date() } });
  revalidatePath("/agenda");
  if (task.leadId) revalidatePath(`/leads/${task.leadId}`);
}

export async function markLostAction(leadId: string, form: FormData) {
  const user = await requireUser();
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) return;
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const stage =
    (await db.stage.findFirst({ where: { pipelineId: lead.pipelineId, key: "perdido" } })) ??
    (await db.stage.findFirst({ where: { pipelineId: lead.pipelineId, kind: "LOST" }, orderBy: { position: "asc" } }));
  if (!stage) throw new Error("Este funil não tem etapa de perdido.");
  await moveLead(leadId, stage.id, user.name, { lostReason: reason, aiPaused: true });
  await clearAlerts(leadId);
  revalidatePath(`/leads/${leadId}`);
}

export async function importCsvAction(_: unknown, form: FormData) {
  const user = await requireUser();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { message: "Escolha um arquivo CSV." };
  const startAi = form.get("startAi") === "on";
  // Turning the AI on for a whole list sends WhatsApp to every lead in it
  if (startAi && user.role === "SELLER") return { message: "Só gestores podem importar já com a IA ligada. Importe sem marcar a IA, ou peça a um gestor." };
  try {
    const count = await importLeads(await file.text(), {
      pipelineId: String(form.get("pipelineId") ?? "") || (await defaultPipeline()).id,
      startAi,
      actor: user.name,
    });
    revalidatePath("/funil");
    return { message: importSummary(count) };
  } catch (e) {
    return { message: `Não deu para importar: ${(e as Error).message}` };
  }
}

export async function saveSettingsAction(form: FormData) {
  await requireOwner();
  const current = await getSettings();
  const lines = (k: string) =>
    String(form.get(k) ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const guests = [
    ...new Set(
      String(form.get("meetingGuests") ?? "")
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
    ),
  ];
  // An empty or bad field keeps what was saved, never turns into 0
  const num = (k: string, keep: number, min: number, max: number) => {
    const raw = String(form.get(k) ?? "").trim();
    const n = raw ? Number(raw.replace(",", ".")) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : keep;
  };
  const start = num("hoursStart", current.businessHours.start, 0, 23);
  const end = num("hoursEnd", current.businessHours.end, 1, 24);
  if (end <= start) throw new Error("O fim do expediente precisa ser depois do início.");
  await saveSettings({
    companyName: String(form.get("companyName") ?? current.companyName),
    presentationUrl: String(form.get("presentationUrl") ?? ""),
    qualificationQuestions: lines("qualificationQuestions"),
    qualifyScore: num("qualifyScore", current.qualifyScore, 0, 100),
    meetingMinutes: num("meetingMinutes", current.meetingMinutes, 15, 240),
    meetingGuests: guests,
    businessHours: {
      ...current.businessHours,
      start,
      end,
    },
  });
  // Whoever is on the list also gets the meetings already booked
  await inviteGuestsToUpcoming(guests).catch(() => 0);
  revalidatePath("/configuracoes");
}

export async function saveAgentAction(form: FormData) {
  await requireOwner();
  const id = String(form.get("id") ?? "");
  const data = { name: String(form.get("name")), persona: String(form.get("persona")), active: form.get("active") === "on" };
  if (id) await db.sdrAgent.update({ where: { id }, data });
  else await db.sdrAgent.create({ data });
  revalidatePath("/configuracoes");
}

export async function saveKnowledgeAction(form: FormData) {
  await requireOwner();
  const id = String(form.get("id") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const content = String(form.get("content") ?? "").trim();
  if (id && !title) await db.knowledgeItem.delete({ where: { id } });
  else if (id) await db.knowledgeItem.update({ where: { id }, data: { title, content } });
  else if (title) await db.knowledgeItem.create({ data: { title, content } });
  revalidatePath("/configuracoes");
}

export async function saveEmailTemplateAction(form: FormData) {
  await requireOwner();
  const key = String(form.get("key"));
  const day = String(form.get("sequenceDay") ?? "").trim();
  const data = {
    name: String(form.get("name")),
    subject: String(form.get("subject")),
    body: String(form.get("body")),
    sequenceDay: day === "" ? null : Number(day),
    active: form.get("active") === "on",
  };
  await db.emailTemplate.upsert({ where: { key }, create: { key, ...data }, update: data });
  revalidatePath("/configuracoes");
}

export async function saveWaTemplateAction(form: FormData) {
  await requireOwner();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const data = {
    language: String(form.get("language") || "pt_BR"),
    body: String(form.get("body")),
    purpose: String(form.get("purpose") || "reengagement"),
    active: form.get("active") === "on",
  };
  await db.whatsAppTemplate.upsert({ where: { name }, create: { name, ...data }, update: data });
  revalidatePath("/configuracoes");
}

export async function saveUserAction(form: FormData) {
  await requireOwner();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const data = {
    name: String(form.get("name")),
    role: String(form.get("role")) as "OWNER" | "MANAGER" | "SELLER",
    calendarId: String(form.get("calendarId") ?? "") || null,
  };
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role === "OWNER" && data.role !== "OWNER" && (await db.user.count({ where: { role: "OWNER" } })) <= 1)
      throw new Error("O CRM precisa de pelo menos um proprietário.");
    await db.user.update({ where: { email }, data: { ...data, ...(password ? { passwordHash: await hashPassword(password) } : {}) } });
    // A new password signs the person out everywhere: whoever had the old one loses access now
    if (password) await db.session.deleteMany({ where: { userId: existing.id } });
  } else if (password) {
    await db.user.create({ data: { ...data, email, passwordHash: await hashPassword(password) } });
  }
  revalidatePath("/configuracoes");
}

/**
 * Someone who left the team: signed out everywhere and the password replaced by one nobody knows. The person stays
 * in the history and as owner of their leads; giving a new password in Equipe brings the access back.
 */
export async function removeUserAccessAction(userId: string) {
  const owner = await requireOwner();
  if (userId === owner.id) throw new Error("Você não pode tirar o seu próprio acesso.");
  await db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(randomBytes(32).toString("hex")) } });
  await db.session.deleteMany({ where: { userId } });
  revalidatePath("/configuracoes");
}

export async function retryJobAction(jobId: string) {
  await requireOwner();
  await db.job.update({ where: { id: jobId }, data: { status: "PENDING", runAt: new Date(), attempts: 0, lastError: null } });
  revalidatePath("/configuracoes");
}

async function requireOwner() {
  const user = await requireUser();
  if (user.role !== "OWNER") throw new Error("Apenas o proprietário pode alterar configurações.");
  return user;
}

export async function saveMacroAction(form: FormData) {
  const user = await requireUser();
  const id = String(form.get("id") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
  // Anyone adds a reply; changing or deleting the team's replies is for managers
  if (id && user.role === "SELLER") throw new Error("Apenas gestores podem alterar ou apagar respostas prontas.");
  if (id && !title) await db.macro.delete({ where: { id } });
  else if (id) await db.macro.update({ where: { id }, data: { title, body } });
  else if (title) await db.macro.create({ data: { title, body } });
  revalidatePath("/configuracoes");
}

/** "R$ 150.000,00" or "150000" → 150000 (whole reais). */
function parseMoney(v: string | null) {
  if (!v) return null;
  const n = Number(v.replace(/[^\d,]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function requireManager() {
  const user = await requireUser();
  if (user.role === "SELLER") throw new Error("Apenas gestores podem editar funis e metas.");
  return user;
}

// ---------- Funis ----------

const BLANK_STAGES = [
  { name: "Novo", color: "#64748b", kind: "OPEN" as const },
  { name: "Em contato", color: "#0ea5e9", kind: "OPEN" as const },
  { name: "Proposta", color: "#8b5cf6", kind: "OPEN" as const },
  { name: "Ganho", color: "#16a34a", kind: "WON" as const },
  { name: "Perdido", color: "#dc2626", kind: "LOST" as const },
];

export async function createPipelineAction(form: FormData) {
  await requireManager();
  const name = String(form.get("name") ?? "").trim() || "Novo funil";
  const position = await db.pipeline.count();
  const pipeline = await db.pipeline.create({
    data: { name, position, stages: { create: BLANK_STAGES.map((s, i) => ({ ...s, position: i })) } },
  });
  revalidatePath("/funil");
  redirect(`/funis/${pipeline.id}`);
}

export async function renamePipelineAction(pipelineId: string, form: FormData) {
  await requireManager();
  const name = String(form.get("name") ?? "").trim();
  if (name) await db.pipeline.update({ where: { id: pipelineId }, data: { name } });
  revalidatePath(`/funis/${pipelineId}`);
}

/** What the AI does in this funnel, the short name forms use, and where qualified leads go next. */
export async function savePipelineAiAction(pipelineId: string, form: FormData) {
  await requireManager();
  const slug =
    String(form.get("slug") ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || null;
  const nextPipelineId = String(form.get("nextPipelineId") ?? "") || null;
  await db.pipeline.update({
    where: { id: pipelineId },
    data: {
      aiGoal: String(form.get("aiGoal") ?? "").trim() || null,
      aiQuestions: String(form.get("aiQuestions") ?? "")
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean),
      slug,
      nextPipelineId: nextPipelineId === pipelineId ? null : nextPipelineId,
    },
  });
  revalidatePath(`/funis/${pipelineId}`);
}

/** The WhatsApp number new conversations in this funnel start from, and the SDR who takes its new leads. */
export async function savePipelineWhatsAppAction(pipelineId: string, form: FormData) {
  await requireManager();
  const raw = String(form.get("whatsappNumberId") ?? "");
  // The main number is kept as null, so it follows WHATSAPP_PHONE_NUMBER_ID (and inbound messages to it)
  const whatsappNumberId = raw && raw !== process.env.WHATSAPP_PHONE_NUMBER_ID ? raw : null;
  const current = await db.pipeline.findUniqueOrThrow({ where: { id: pipelineId }, select: { whatsappNumberId: true } });
  if (whatsappNumberId && whatsappNumberId !== current.whatsappNumberId && !(await savedWhatsAppNumbers())?.numbers.some((n) => n.id === whatsappNumberId))
    throw new Error("Esse número não está na conta do WhatsApp. Atualize a lista em Integrações > Verificar número.");
  const sdrId = String(form.get("sdrId") ?? "") || null;
  if (sdrId && !(await db.sdrAgent.count({ where: { id: sdrId } }))) throw new Error("SDR não encontrada.");
  await db.pipeline.update({ where: { id: pipelineId }, data: { whatsappNumberId, sdrId } });
  revalidatePath(`/funis/${pipelineId}`);
  revalidatePath("/integracoes");
}

export async function setDefaultPipelineAction(pipelineId: string) {
  await requireManager();
  await db.$transaction([
    db.pipeline.updateMany({ data: { isDefault: false } }),
    db.pipeline.update({ where: { id: pipelineId }, data: { isDefault: true } }),
  ]);
  revalidatePath(`/funis/${pipelineId}`);
}

export async function deletePipelineAction(pipelineId: string) {
  await requireManager();
  const p = await db.pipeline.findUniqueOrThrow({ where: { id: pipelineId }, include: { _count: { select: { leads: true } } } });
  if (p.isDefault) throw new Error("O funil padrão não pode ser excluído.");
  if (p._count.leads > 0) throw new Error("Mova os leads deste funil antes de excluí-lo.");
  await db.pipeline.delete({ where: { id: pipelineId } });
  redirect("/funil");
}

export async function addStageAction(pipelineId: string, form: FormData) {
  await requireManager();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return;
  const stages = await db.stage.findMany({ where: { pipelineId }, orderBy: { position: "asc" } });
  // New stages go before Ganho/Perdido
  const at = stages.findIndex((s) => s.kind !== "OPEN");
  const index = at === -1 ? stages.length : at;
  await db.$transaction([
    ...stages.slice(index).map((s, i) => db.stage.update({ where: { id: s.id }, data: { position: index + i + 1 } })),
    db.stage.create({ data: { pipelineId, name, position: index, color: String(form.get("color") || "#6366f1") } }),
  ]);
  revalidatePath(`/funis/${pipelineId}`);
}

export async function updateStageAction(stageId: string, form: FormData) {
  await requireManager();
  const kind = String(form.get("kind") ?? "OPEN");
  const stage = await db.stage.update({
    where: { id: stageId },
    data: {
      name: String(form.get("name") ?? "").trim() || undefined,
      color: String(form.get("color") || "#64748b"),
      kind: kind === "WON" || kind === "LOST" ? kind : "OPEN",
    },
  });
  revalidatePath(`/funis/${stage.pipelineId}`);
}

export async function moveStageAction(stageId: string, dir: -1 | 1) {
  await requireManager();
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  const stages = await db.stage.findMany({ where: { pipelineId: stage.pipelineId }, orderBy: { position: "asc" } });
  const i = stages.findIndex((s) => s.id === stageId);
  const j = i + dir;
  if (j < 0 || j >= stages.length) return;
  [stages[i], stages[j]] = [stages[j], stages[i]];
  await db.$transaction(stages.map((s, position) => db.stage.update({ where: { id: s.id }, data: { position } })));
  revalidatePath(`/funis/${stage.pipelineId}`);
}

export async function deleteStageAction(stageId: string) {
  const user = await requireManager();
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  if (stage.key) throw new Error("Esta etapa é usada pela SDR de IA e não pode ser excluída. Você pode renomeá-la.");
  const fallback = await db.stage.findFirst({
    where: { pipelineId: stage.pipelineId, id: { not: stageId } },
    orderBy: { position: "asc" },
  });
  if (!fallback) throw new Error("O funil precisa de pelo menos uma etapa.");
  const leads = await db.lead.findMany({ where: { stageId }, select: { id: true } });
  // The first stage's automations are for leads arriving there, not for these: they move without a new welcome
  for (let i = 0; i < leads.length; i += 20)
    await Promise.all(leads.slice(i, i + 20).map((l) => moveLead(l.id, fallback.id, user.name, {}, { rules: false })));
  await db.stage.delete({ where: { id: stageId } });
  revalidatePath(`/funis/${stage.pipelineId}`);
}

// ---------- Automações ----------

export async function saveRuleAction(form: FormData) {
  await requireManager();
  const id = String(form.get("id") ?? "");
  const stageId = String(form.get("stageId"));
  const action = String(form.get("action"));
  if (!(action in ACTIONS)) throw new Error("Ação inválida.");
  const unit = UNITS.find((u) => u.key === form.get("unit")) ?? UNITS[2];
  const amount = Math.max(0, Number(form.get("amount") ?? 0) || 0);
  const pick = (k: string) => String(form.get(k) ?? "").trim() || undefined;
  const config: RuleConfig = {
    text: action === "whatsapp" ? pick("text") : undefined,
    templateName: action === "whatsapp" ? pick("templateName") : undefined,
    templateParams:
      action === "whatsapp" && pick("templateName")
        ? form
            .getAll("templateParams")
            .map((v) => String(v).trim())
            .filter((v) => /^\w+$/.test(v))
        : undefined,
    buttons:
      action === "whatsapp"
        ? String(form.get("buttons") ?? "")
            .split("|")
            .map((b) => b.trim().slice(0, 20))
            .filter(Boolean)
            .slice(0, 3)
        : undefined,
    templateKey: action === "email" ? pick("templateKey") : undefined,
    title: action === "task" ? pick("title") : undefined,
    toStageId: action === "move" ? pick("toStageId") : undefined,
    sdrId: action === "ai_on" ? pick("sdrId") : undefined,
  };
  const rawTrigger = form.get("trigger");
  const trigger =
    rawTrigger === "idle" ? "idle" : rawTrigger === "daily" && action === "move" ? "daily" : rawTrigger === "answer" ? "answer" : "enter";
  if (trigger === "daily") config.perDay = Math.min(1000, Math.max(1, Number(form.get("perDay")) || 100));
  if (trigger === "answer") {
    config.answers = String(form.get("answers") ?? "")
      .split("|")
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (!config.answers.length) throw new Error("Diga qual resposta do lead dispara a automação.");
    config.aiReplies = form.get("aiReplies") === "on" || undefined;
  }
  const data = {
    trigger,
    // "sem resposta por 0 minutos" makes no sense; at least one hour
    delayMinutes: trigger === "idle" ? Math.max(60, amount * unit.minutes) : trigger === "daily" || trigger === "answer" ? 0 : amount * unit.minutes,
    action,
    config: JSON.parse(JSON.stringify(config)),
    runAfterLeaving: form.get("runAfterLeaving") === "on",
  };
  if (id) await db.automationRule.update({ where: { id }, data });
  else {
    const position = await db.automationRule.count({ where: { stageId } });
    await db.automationRule.create({ data: { ...data, stageId, position } });
  }
  const stage = await db.stage.findUniqueOrThrow({ where: { id: stageId } });
  revalidatePath(`/funis/${stage.pipelineId}`);
}

export async function toggleRuleAction(ruleId: string) {
  await requireManager();
  const rule = await db.automationRule.findUniqueOrThrow({ where: { id: ruleId }, include: { stage: true } });
  await db.automationRule.update({ where: { id: ruleId }, data: { active: !rule.active } });
  revalidatePath(`/funis/${rule.stage.pipelineId}`);
}

export async function deleteRuleAction(ruleId: string) {
  await requireManager();
  const rule = await db.automationRule.delete({ where: { id: ruleId }, include: { stage: true } });
  await db.job.updateMany({
    where: { type: "rule.run", status: "PENDING", payload: { path: ["ruleId"], equals: ruleId } },
    data: { status: "CANCELLED", dedupeKey: null, finishedAt: new Date(), result: "Cancelado: automação excluída." },
  });
  revalidatePath(`/funis/${rule.stage.pipelineId}`);
}

// ---------- Metas ----------

export async function saveGoalsAction(form: FormData) {
  await requireManager();
  const period = String(form.get("period"));
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error("Período inválido.");
  const users = await db.user.findMany({ select: { id: true } });
  for (const who of [null, ...users.map((u) => u.id)]) {
    for (const m of METRICS) {
      const raw = String(form.get(`${m.key}:${who ?? "team"}`) ?? "").trim();
      // "1.200" is twelve hundred, as people write it here
      const target = m.money ? parseMoney(raw) : raw ? Number(raw.replace(/\D/g, "")) : null;
      const existing = await db.goal.findFirst({ where: { userId: who, metric: m.key, period } });
      if (target === null || !Number.isFinite(target) || target <= 0) {
        if (existing) await db.goal.delete({ where: { id: existing.id } });
      } else if (existing) {
        await db.goal.update({ where: { id: existing.id }, data: { target } });
      } else {
        await db.goal.create({ data: { userId: who, metric: m.key, period, target } });
      }
    }
  }
  revalidatePath("/metas");
  redirect(`/metas?p=${period}`);
}

// ---------- Integrações e testes ----------

export type TestState = { kind: string; ok: boolean; message: string; details?: string[] } | null;

export async function testIntegrationAction(_: TestState, form: FormData): Promise<TestState> {
  const user = await requireManager();
  const kind = String(form.get("kind"));
  const integrations = await import("@/lib/integrations");
  // Moving where the WhatsApp messages arrive is the owner's call
  if (kind.startsWith("webhook")) await requireOwner();
  const run = {
    ai: () => integrations.checkAi(),
    transcription: () => integrations.checkTranscription(),
    whatsapp: () => integrations.checkWhatsApp(),
    whatsapp_send: () => integrations.sendWhatsAppTest(String(form.get("phone") ?? "")),
    templates: () => integrations.importWhatsAppTemplates(),
    templates_submit: () => integrations.submitWhatsAppTemplates(),
    templates_sync: () => integrations.syncWhatsAppTemplates(),
    webhook_here: () => integrations.receiveWhatsAppHere(),
    webhook_back: () => integrations.giveWhatsAppBack(),
    webhook_copy_off: () => integrations.switchWhatsAppCopy(true, user.name),
    webhook_copy_on: () => integrations.switchWhatsAppCopy(false, user.name),
    email: () => integrations.sendEmailTest(String(form.get("to") || user.email)),
    calendar: () => integrations.checkCalendar(String(form.get("userId") || user.id)),
    meta_forms: () => integrations.checkMetaLeads(),
    meta_audit: () => integrations.checkMissingMetaLeads(),
    meta_bring: () => integrations.bringMissingFormLeads(),
    meta_ads: () => integrations.checkMetaAds(),
  }[kind];
  if (!run) return { kind, ok: false, message: "Teste desconhecido." };
  const res = await run();
  if (kind === "whatsapp" || kind.startsWith("webhook_copy") || kind.startsWith("meta_")) revalidatePath("/integracoes");
  if (kind.startsWith("templates")) {
    revalidatePath("/configuracoes");
    revalidatePath("/integracoes");
  }
  return { kind, ...res };
}

/** Which funnel a Facebook or Instagram form feeds, chosen on the Integrações screen. */
export async function setFormFunnelAction(formId: string, form: FormData) {
  await requireManager();
  const slug = String(form.get("funnel") ?? "");
  const row = await db.setting.findUnique({ where: { key: "meta_leads" } });
  const state = (row?.value ?? {}) as { forms?: Record<string, string>; names?: Record<string, { funnel: string | null }> };
  const forms = { ...state.forms };
  if (slug) forms[formId] = slug;
  else delete forms[formId];
  const names = state.names?.[formId] ? { ...state.names, [formId]: { ...state.names[formId], funnel: slug || null } } : state.names;
  const value = JSON.parse(JSON.stringify({ ...state, forms, names }));
  await db.setting.upsert({ where: { key: "meta_leads" }, create: { key: "meta_leads", value }, update: { value } });
  revalidatePath("/integracoes");
}

/** Sends again what never went while the WhatsApp account was blocked (Integrações). */
export async function resendBlockedAction() {
  const user = await requireManager();
  const health = await getHealth();
  if (health && !health.numberId) throw new Error("A conta do WhatsApp ainda aparece bloqueada; o reenvio libera quando ela voltar a enviar.");
  const count = await scheduleResends();
  // A second click, after everyone was already scheduled, finds no one: the card keeps showing the real one
  if (!count) return revalidatePath("/integracoes");
  const value = { at: new Date().toISOString(), by: user.name, count };
  await db.setting.upsert({ where: { key: "whatsapp_resend" }, create: { key: "whatsapp_resend", value }, update: { value } });
  revalidatePath("/integracoes");
}

export async function saveTestModeAction(form: FormData) {
  await requireOwner();
  await saveSettings({
    testMode: form.get("testMode") === "on",
    answerInbound: form.get("answerInbound") === "on",
    testContacts: String(form.get("testContacts") ?? "")
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
  revalidatePath("/integracoes");
}

export type SimMessage = { direction: "IN" | "OUT"; body: string; author: string };
export type SimResult =
  | {
      ok: true;
      reply: string;
      decision: string;
      score: number;
      temperature: string;
      reason: string;
      summary: string;
      extracted: Record<string, string | null>;
      effects: string[];
      slots: string[];
    }
  | { ok: false; error: string };

/** Runs the real SDR on a made-up conversation. Reads settings and knowledge; writes nothing. */
export async function simulateSdrAction(input: { agentId: string; messages: SimMessage[]; lead: { name?: string; city?: string } }): Promise<SimResult> {
  await requireUser();
  const [{ runSdrTurn }, { planFromDecision }, { pickOwner, freeSlotsFor, formatSlot }] = await Promise.all([
    import("@/lib/sdr"),
    import("@/lib/plan"),
    import("@/lib/calendar"),
  ]);
  const agent = await db.sdrAgent.findUnique({ where: { id: input.agentId } });
  if (!agent) return { ok: false, error: "Escolha uma SDR." };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "A IA ainda não está conectada: falta a ANTHROPIC_API_KEY no servidor." };
  const settings = await getSettings();
  const knowledge = await db.knowledgeItem.findMany({ orderBy: { title: "asc" } });
  const owner = await pickOwner();
  const slots = owner ? await freeSlotsFor(owner.id, settings.businessHours, settings.meetingMinutes) : [];
  const now = new Date();
  try {
    const d = await runSdrTurn({
      agentName: agent.name,
      persona: agent.persona,
      settings,
      knowledge,
      lead: {
        name: input.lead.name || null,
        phone: "simulado",
        email: null,
        city: input.lead.city || null,
        state: null,
        source: "simulador",
        qualification: {},
        summary: null,
      },
      transcript: input.messages.map((m, i) => ({ ...m, at: new Date(now.getTime() - (input.messages.length - i) * 60_000) })),
      slots,
      now,
    });
    const plan = planFromDecision(d, slots, settings.qualifyScore);
    const stage = await db.stage.findFirst({ where: { key: plan.stageKey, pipeline: { isDefault: true } } });
    const effects = [`Lead iria para "${stage?.name ?? plan.stageKey}".`];
    if (plan.slot) effects.push(`Marcaria reunião com ${owner?.name ?? "o gerente"} em ${formatSlot(plan.slot.startsAt)} e mandaria lembretes.`);
    if (plan.handoffTask) effects.push(`Criaria tarefa: ${plan.handoffTask}`);
    if (plan.stopAi) effects.push("A IA pararia de responder este lead.");
    if (d.decision === "offer_meeting" && !plan.slot && plan.stageKey !== "qualificado") {
      effects.push(`A IA quis oferecer reunião, mas o score (${d.score}) está abaixo do mínimo (${settings.qualifyScore}): continua qualificando.`);
    }
    return {
      ok: true,
      reply: plan.reply,
      decision: d.decision,
      score: d.score,
      temperature: d.temperature,
      reason: d.reason,
      summary: d.summary,
      extracted: d.extracted,
      effects,
      slots: slots.slice(0, 5).map((s) => formatSlot(s.startsAt)),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function disconnectGoogleAction() {
  const user = await requireUser();
  const { disconnectGoogle } = await import("@/lib/google");
  await disconnectGoogle(user.id);
  revalidatePath("/integracoes");
}

export async function cancelMeetingAction(meetingId: string) {
  const user = await requireUser();
  const { cancelMeeting } = await import("@/lib/jobs");
  const meeting = await db.meeting.findUnique({ where: { id: meetingId }, select: { leadId: true } });
  if (!meeting) return;
  await cancelMeeting(meetingId, user.name);
  await clearAlerts(meeting.leadId);
  revalidatePath(`/leads/${meeting.leadId}`);
  revalidatePath("/agenda");
}

/** "Agendar reunião" on the lead's page: Google agenda with Meet, lead in "Reunião marcada", link to the lead. */
export async function scheduleMeetingAction(leadId: string, _: unknown, form: FormData) {
  const user = await requireUser();
  const { scheduleMeeting } = await import("@/lib/jobs");
  const date = String(form.get("date") ?? "");
  const time = String(form.get("time") ?? "");
  const minutes = Number(form.get("minutes") ?? 30) || 30;
  const userId = String(form.get("userId") ?? "") || user.id;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return { error: "Escolha o dia e a hora." };
  // The team types São Paulo time
  const startsAt = new Date(`${date}T${time}:00-03:00`);
  if (Number.isNaN(startsAt.getTime())) return { error: "Dia ou hora inválidos." };
  if (startsAt < new Date()) return { error: "Esse horário já passou." };
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  const clash = await db.meeting.findFirst({
    where: { userId, status: "scheduled", startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    include: { lead: { select: { name: true } } },
  });
  if (clash) return { error: `Esse horário já tem reunião marcada no CRM${clash.lead.name ? ` com ${clash.lead.name}` : ""}.` };
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { error: "Lead não encontrado." };
  try {
    const { meeting, sent } = await scheduleMeeting(lead, { userId, slot: { startsAt, endsAt }, actor: user.name, notify: form.get("notify") === "on" });
    await clearAlerts(leadId);
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/agenda");
    const google = meeting.meetLink ? "Entrou no Google Agenda com link do Meet." : "Ficou só no CRM (sem Google Agenda conectado ou o Google falhou; veja o histórico).";
    return { message: `Reunião marcada. ${google}${sent ? ` ${sent}` : ""}` };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
