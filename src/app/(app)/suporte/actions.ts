"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireArea } from "@/lib/access";
import { connectWebhook, createInstance, instanceQr, newWebhookKey, numberStatus, sealToken, sendSupportText } from "@/lib/support";

export type SupportState = { ok?: boolean; error?: string; message?: string };

async function requireOwner() {
  const user = await requireArea("suporte");
  if (user.role !== "OWNER") throw new Error("Só o proprietário configura os números e os atendentes.");
  return user;
}

const ids = (form: FormData, name: string) => form.getAll(name).map(String).filter(Boolean);

/** Connects a support number: keeps the token encrypted, checks it with Uazapi and points the webhook here. */
export async function saveNumberAction(_: SupportState, form: FormData): Promise<SupportState> {
  await requireOwner();
  const id = String(form.get("id") ?? "") || null;
  const name = String(form.get("name") ?? "").trim();
  const token = String(form.get("token") ?? "").trim();
  const server = String(form.get("server") ?? "").trim().replace(/\/+$/, "") || null;
  const attendants = ids(form, "attendants");
  if (!name) return { error: "Dê um nome ao número (por exemplo, Suporte Franqueados)." };
  if (server && !/^https:\/\/[^\s/]+$/.test(server)) return { error: "O servidor é o endereço da Uazapi, como https://banneg.uazapi.com" };
  if (!id && !token) return { error: "Cole o token da instância da Uazapi deste número." };
  const data = {
    name,
    server,
    ...(token && { token: sealToken(token) }),
    attendants: { set: attendants.map((a) => ({ id: a })) },
  };
  const saved = id
    ? await db.supportNumber.update({ where: { id }, data })
    : await db.supportNumber.create({
        data: { name, server, token: sealToken(token), webhookKey: newWebhookKey(), attendants: { connect: attendants.map((a) => ({ id: a })) } },
      });
  revalidatePath("/suporte", "layout");
  // Only a new token needs Uazapi again; renaming or changing attendants is saved as is
  if (!token) return { ok: true, message: "Número salvo." };
  return checkNumber(saved.id, "Número salvo.");
}

async function checkNumber(id: string, prefix = "") {
  const n = await db.supportNumber.findUniqueOrThrow({ where: { id } });
  try {
    const status = await numberStatus(n);
    await db.supportNumber.update({
      where: { id },
      data: { status: status.status, statusAt: new Date(), ...(status.phone && { phone: status.phone }) },
    });
    if (!status.connected)
      return { error: `${prefix} Este número está desconectado (${status.status}). Use "Conectar com QR code" e leia com o celular dele.`.trim() };
    await connectWebhook(n);
    revalidatePath("/suporte", "layout");
    return { ok: true, message: `${prefix} Conectado${status.phone ? ` (${status.phone})` : ""}. As mensagens deste número já chegam no Suporte.`.trim() };
  } catch (e) {
    await db.supportNumber.update({ where: { id }, data: { status: "erro", statusAt: new Date() } });
    revalidatePath("/suporte", "layout");
    return { error: `${prefix} ${(e as Error).message}`.trim() };
  }
}

export async function checkNumberAction(id: string): Promise<SupportState> {
  await requireOwner();
  return checkNumber(id);
}

/** Stops listening to a number: its conversations stay, so the history and the numbers of the past stay. */
export async function toggleNumberAction(id: string, active: boolean) {
  await requireOwner();
  await db.supportNumber.update({ where: { id }, data: { active } });
  revalidatePath("/suporte", "layout");
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveAttendantAction(_: SupportState, form: FormData): Promise<SupportState> {
  await requireOwner();
  const id = String(form.get("id") ?? "") || null;
  const name = String(form.get("name") ?? "").trim();
  const userId = String(form.get("userId") ?? "") || null;
  const workDays = ids(form, "workDays").map(Number).filter((d) => d >= 0 && d <= 6);
  const workStart = String(form.get("workStart") ?? "");
  const workEnd = String(form.get("workEnd") ?? "");
  const numbers = ids(form, "numbers");
  if (!name) return { error: "Escreva o nome do atendente." };
  if (!HHMM.test(workStart) || !HHMM.test(workEnd) || workEnd <= workStart) return { error: "O expediente precisa de início e fim, como 08:00 e 18:00." };
  if (!workDays.length) return { error: "Marque os dias de trabalho." };
  if (userId) {
    const taken = await db.supportAttendant.findUnique({ where: { userId } });
    if (taken && taken.id !== id) return { error: `Esse acesso do CRM já é de ${taken.name}.` };
  }
  const data = { name, userId, workDays, workStart, workEnd, numbers: { set: numbers.map((n) => ({ id: n })) } };
  if (id) await db.supportAttendant.update({ where: { id }, data });
  else await db.supportAttendant.create({ data: { ...data, numbers: { connect: numbers.map((n) => ({ id: n })) } } });
  revalidatePath("/suporte", "layout");
  return { ok: true, message: id ? "Atendente salvo." : "Atendente incluído." };
}

/** Takes the person off the team: what they answered stays in the history under their name. */
export async function toggleAttendantAction(id: string, active: boolean) {
  await requireOwner();
  await db.supportAttendant.update({ where: { id }, data: { active, ...(!active && { numbers: { set: [] } }) } });
  revalidatePath("/suporte", "layout");
}

export async function sendSupportAction(chatId: string, form: FormData): Promise<SupportState> {
  const user = await requireArea("suporte");
  const text = String(form.get("body") ?? "").trim();
  if (!text) return { error: "Escreva a mensagem." };
  try {
    await sendSupportText(chatId, text, user);
  } catch (e) {
    return { error: `Não foi enviada: ${(e as Error).message}` };
  }
  revalidatePath(`/suporte/c/${chatId}`);
  return { ok: true };
}

export type QrState = { error?: string; id?: string; qr?: string | null; connected?: boolean; phone?: string | null };

/** "Conectar com QR code": creates the number's Uazapi instance and brings the first QR code. */
export async function createNumberByQrAction(form: FormData): Promise<QrState> {
  await requireOwner();
  const name = String(form.get("name") ?? "").trim();
  const attendants = ids(form, "attendants");
  if (!name) return { error: "Dê um nome ao número (por exemplo, Suporte Seguros)." };
  try {
    const token = await createInstance(name);
    const n = await db.supportNumber.create({
      data: { name, token: sealToken(token), webhookKey: newWebhookKey(), status: "aguardando QR", attendants: { connect: attendants.map((a) => ({ id: a })) } },
    });
    revalidatePath("/suporte", "layout");
    return { id: n.id, ...(await qrStep(n.id, true)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** The QR code of a number not connected yet; once read, the webhook is set and the number starts arriving. */
export async function numberQrAction(id: string, start = false): Promise<QrState> {
  await requireOwner();
  try {
    return { id, ...(await qrStep(id, start)) };
  } catch (e) {
    return { id, error: (e as Error).message };
  }
}

async function qrStep(id: string, start: boolean) {
  const n = await db.supportNumber.findUniqueOrThrow({ where: { id } });
  const step = await instanceQr(n, start);
  if (step.connected) {
    await connectWebhook(n);
    await db.supportNumber.update({ where: { id }, data: { status: "connected", statusAt: new Date(), ...(step.phone && { phone: step.phone }) } });
    revalidatePath("/suporte", "layout");
  }
  return { qr: step.qr, connected: step.connected, phone: step.phone };
}
