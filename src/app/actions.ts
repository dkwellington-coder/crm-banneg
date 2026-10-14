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
      emailOptOut: form.get("emailOptOut") === "on",
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
  const stage = await db.stage.findUniqueOrThrow({ where: { key: "perdido" } });
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
    const res = await createLead({ ...input, source: input.source ?? "importação", reactivation: true }, user.name);
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
    followUpDays: lines("followUpDays").flatMap((s) => s.split(/[,\s]+/)).map(Number).filter((n) => n > 0),
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
