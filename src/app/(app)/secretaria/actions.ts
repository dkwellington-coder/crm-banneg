"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  connectSecretary,
  firstNudge,
  getSecretary,
  memberByName,
  parseBr,
  pointWebhook,
  removeSecretaryNumber,
  saveSecretary,
  secretaryQr,
  sendToSecretaryGroup,
  setSecretaryGroup,
  type SecretaryMember,
} from "@/lib/secretary";
import { db } from "@/lib/db";
import { disconnectSecretaryDrive, setSecretaryFolder } from "@/lib/secretary-drive";
import { disconnectSecretaryCanva } from "@/lib/secretary-canva";

// The secretary is Wellington's own: only the owner sets her up
async function owner() {
  const user = await requireUser();
  if (user.role !== "OWNER") throw new Error("Só o dono do CRM mexe na secretária.");
  return user;
}

const PATH = "/secretaria";

export async function connectSecretaryAction(fresh = false) {
  await owner();
  return connectSecretary(fresh);
}

export async function secretaryQrAction() {
  await owner();
  const step = await secretaryQr();
  if (step.connected) revalidatePath(PATH);
  return step;
}

export async function removeSecretaryAction() {
  await owner();
  await removeSecretaryNumber();
  revalidatePath(PATH);
}

export type SaveState = { ok?: boolean; message?: string };

/** Group, people, checklist, instructions and switches, in one form. */
export async function saveSecretaryAction(_: SaveState, form: FormData): Promise<SaveState> {
  await owner();
  const members: SecretaryMember[] = [];
  for (let i = 0; i < 12; i++) {
    const name = String(form.get(`name_${i}`) ?? "").trim();
    const phone = String(form.get(`phone_${i}`) ?? "").replace(/\D/g, "");
    const email = String(form.get(`email_${i}`) ?? "").trim().toLowerCase();
    if (!name && !phone && !email) continue;
    if (!name) return { ok: false, message: `Falta o nome da pessoa ${i + 1}.` };
    if (phone && phone.length < 10) return { ok: false, message: `O WhatsApp de ${name} precisa ter DDD e número.` };
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: `O e-mail de ${name} não parece certo.` };
    members.push({ name, phone, email, role: form.get(`role_${i}`) === "socio" ? "socio" : "colaborador" });
  }
  const on = (k: string) => form.get(k) === "on";
  const before = await getSecretary();
  const s = await saveSecretary({
    name: String(form.get("name") ?? "").trim() || "Secretária",
    nicknames: String(form.get("nicknames") ?? "")
      .split(/[,;\n]/)
      .map((n) => n.trim())
      .filter((n) => n.length >= 3)
      .slice(0, 5),
    members,
    checklist: String(form.get("checklist") ?? "").trim(),
    instructions: String(form.get("instructions") ?? "").trim(),
    confirmEmails: on("confirmEmails"),
    weekly: on("weekly"),
    daily: on("daily"),
    privates: on("privates"),
    active: on("active"),
  });
  try {
    const groupId = String(form.get("groupId") ?? "");
    const teamGroupId = String(form.get("teamGroupId") ?? "");
    if (teamGroupId && teamGroupId === groupId) return { ok: false, message: "O grupo da equipe precisa ser outro grupo, não o dos sócios." };
    let pointed = false;
    if (form.has("groupId") && groupId !== (before.group?.id ?? "")) {
      await setSecretaryGroup(groupId || null);
      pointed = true;
    }
    if (form.has("teamGroupId") && teamGroupId !== (before.teamGroup?.id ?? "")) {
      await setSecretaryGroup(teamGroupId || null, "teamGroup");
      pointed = true;
    }
    if (!pointed && before.privates !== s.privates) await pointWebhook(s);
  } catch (e) {
    revalidatePath(PATH);
    return { ok: false, message: `Salvo, mas o grupo não foi trocado: ${(e as Error).message}` };
  }
  revalidatePath(PATH);
  return { ok: true, message: "Salvo." };
}

export async function testSecretaryAction(): Promise<SaveState> {
  await owner();
  const s = await getSecretary();
  try {
    await sendToSecretaryGroup(
      `Oi, pessoal! Eu sou a ${s.name}, secretária do Banneg. A partir de agora é só me pedir aqui: marcar reunião, mandar e-mail, anotar tarefa e cobrar retorno. 😊`,
    );
    return { ok: true, message: "Mensagem enviada no grupo. Confira no WhatsApp." };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function addTaskAction(form: FormData) {
  const user = await owner();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const s = await getSecretary();
  const kind = ["tarefa", "retorno", "lembrete"].includes(String(form.get("kind"))) ? String(form.get("kind")) : "tarefa";
  const dueAt = parseBr(String(form.get("dueAt") ?? ""));
  const assignee = String(form.get("assignee") ?? "").trim();
  const member = memberByName(s.members, assignee);
  await db.secretaryTask.create({
    data: {
      title,
      kind,
      assignee: member?.name ?? (assignee || null),
      assigneePhone: member?.phone ?? null,
      dueAt,
      remindAt: kind === "lembrete" ? dueAt : null,
      nextNudgeAt: firstNudge({ kind, dueAt }),
      createdBy: user.name,
    },
  });
  revalidatePath(PATH);
  revalidatePath("/tarefas");
}

export async function setTaskStatusAction(id: string, status: "feita" | "cancelada" | "aberta") {
  const user = await owner();
  await db.secretaryTask.update({
    where: { id },
    data: status === "aberta" ? { status, doneAt: null, doneBy: null } : { status, doneAt: new Date(), doneBy: user.name, nextNudgeAt: null },
  });
  revalidatePath(PATH);
  revalidatePath("/tarefas");
}

// ---------- Her Google Drive folder (the reports the other Claude tabs save) ----------

export async function setDriveFolderAction(formData: FormData) {
  await owner();
  let to: string;
  try {
    const name = await setSecretaryFolder(String(formData.get("folder") ?? ""));
    to = `${PATH}?drive=pasta&detalhe=${encodeURIComponent(name)}#drive`;
  } catch (e) {
    to = `${PATH}?drive=erro&detalhe=${encodeURIComponent((e as Error).message)}#drive`;
  }
  revalidatePath(PATH);
  redirect(to);
}

export async function disconnectDriveAction() {
  await owner();
  await disconnectSecretaryDrive();
  revalidatePath(PATH);
}

export async function disconnectCanvaAction() {
  await owner();
  await disconnectSecretaryCanva();
  revalidatePath(PATH);
}
