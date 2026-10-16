"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser, login, logout, hashPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { createLead, moveLead, startAutomations } from "@/lib/leads";
import { sendWhatsApp } from "@/lib/messaging";
import { enqueue } from "@/lib/queue";
import { getSettings, saveSettings } from "@/lib/settings";
import { parseCsv, mapRow } from "@/lib/csv";
import { ACTIONS, UNITS, type RuleConfig } from "@/lib/rules";
import { METRICS } from "@/lib/goals";

export async function loginAction(_: unknown, form: FormData) {
  const user = await login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
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
  revalidatePath("/funil");
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
  revalidatePath(`/leads/${leadId}`);
}

export async function importCsvAction(_: unknown, form: FormData) {
  const user = await requireUser();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { message: "Escolha um arquivo CSV." };
  const startAi = form.get("startAi") === "on";
  const rows = parseCsv(await file.text());
  let created = 0;
  let duplicates = 0;
  let skipped = 0;
  for (const row of rows) {
    const input = mapRow(row);
    if (!input.phone && !input.email) {
      skipped++;
      continue;
    }
    const res = await createLead(
      { ...input, source: input.source ?? "importação", pipelineId: String(form.get("pipelineId") ?? "") || null, reactivation: true },
      user.name,
    );
    if (!res.created) {
      duplicates++;
      continue;
    }
    created++;
    if (startAi) await startAutomations(res.lead);
  }
  revalidatePath("/funil");
  return { message: `${created} leads importados, ${duplicates} já existiam, ${skipped} sem telefone nem e-mail.` };
}

export async function saveSettingsAction(form: FormData) {
  await requireOwner();
  const current = await getSettings();
  const lines = (k: string) =>
    String(form.get(k) ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  await saveSettings({
    companyName: String(form.get("companyName") ?? current.companyName),
    presentationUrl: String(form.get("presentationUrl") ?? ""),
    qualificationQuestions: lines("qualificationQuestions"),
    qualifyScore: Number(form.get("qualifyScore") ?? current.qualifyScore),
    meetingMinutes: Number(form.get("meetingMinutes") ?? current.meetingMinutes),
    businessHours: {
      ...current.businessHours,
      start: Number(form.get("hoursStart") ?? current.businessHours.start),
      end: Number(form.get("hoursEnd") ?? current.businessHours.end),
    },
  });
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
    await db.user.update({ where: { email }, data: { ...data, ...(password ? { passwordHash: await hashPassword(password) } : {}) } });
  } else if (password) {
    await db.user.create({ data: { ...data, email, passwordHash: await hashPassword(password) } });
  }
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
  await requireUser();
  const id = String(form.get("id") ?? "");
  const title = String(form.get("title") ?? "").trim();
  const body = String(form.get("body") ?? "").trim();
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
  for (const l of leads) await moveLead(l.id, fallback.id, user.name);
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
      const target = m.money ? parseMoney(raw) : raw ? Math.round(Number(raw)) : null;
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
    email: () => integrations.sendEmailTest(String(form.get("to") || user.email)),
    calendar: () => integrations.checkCalendar(String(form.get("userId") || user.id)),
    meta_forms: () => integrations.checkMetaLeads(),
    meta_ads: () => integrations.checkMetaAds(),
  }[kind];
  if (!run) return { kind, ok: false, message: "Teste desconhecido." };
  const res = await run();
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
