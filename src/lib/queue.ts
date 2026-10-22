import type { Prisma } from "@prisma/client";
import { db } from "./db";

export type JobType =
  | "sdr.first_contact"
  | "sdr.reply"
  | "rule.run"
  | "email.send"
  | "meeting.reminder"
  | "whatsapp.retry"
  | "whatsapp.undelivered_emails"
  | "whatsapp.other_category"
  | "whatsapp.resend"
  | "portal.status";

/**
 * Schedules work. A dedupeKey makes the call idempotent: scheduling the same step twice
 * (two webhooks, a double click) keeps one job.
 */
export async function enqueue(
  type: JobType,
  opts: { leadId?: string; payload?: Prisma.InputJsonValue; runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
) {
  const data = {
    type,
    leadId: opts.leadId,
    payload: opts.payload ?? {},
    runAt: opts.runAt ?? new Date(),
    dedupeKey: opts.dedupeKey,
    maxAttempts: opts.maxAttempts ?? 5,
  };
  if (!opts.dedupeKey) return db.job.create({ data });
  return db.job.upsert({ where: { dedupeKey: opts.dedupeKey }, create: data, update: {} });
}

/** Postpones a pending job (used to wait for the lead to finish typing before the SDR answers). */
export async function enqueueDebounced(type: JobType, leadId: string, delayMs: number) {
  const dedupeKey = `${type}:${leadId}:pending`;
  const runAt = new Date(Date.now() + delayMs);
  const existing = await db.job.findUnique({ where: { dedupeKey } });
  if (existing && existing.status === "PENDING") {
    return db.job.update({ where: { id: existing.id }, data: { runAt } });
  }
  if (existing) await db.job.update({ where: { id: existing.id }, data: { dedupeKey: null } });
  return db.job.create({ data: { type, leadId, runAt, dedupeKey } });
}

export async function cancelJobs(leadId: string, types: JobType[]) {
  await db.job.updateMany({
    where: { leadId, type: { in: types }, status: "PENDING" },
    data: { status: "CANCELLED", finishedAt: new Date(), dedupeKey: null, result: "Cancelado: o lead mudou de etapa ou respondeu." },
  });
}

export function backoffMs(attempt: number) {
  // 1 min, 4 min, 16 min, 64 min...
  return 60_000 * 4 ** Math.max(0, attempt - 1);
}
