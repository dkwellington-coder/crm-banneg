import type { Lead, Message, Stage } from "@prisma/client";
import { db } from "./db";
import { SEND_ERROR_STAGE, isClosed, sendWhatsApp } from "./messaging";
import { enqueue } from "./queue";
import { isAccountFailure } from "./whatsapp";

// Far enough back to cover a block that started yesterday, close enough that nothing stale goes out
export const RESEND_HOURS = 48;
// One lead every 20 seconds: an account just back from a block should not see a burst
const SPACING_MS = 20_000;
const REACHED = ["SENT", "DELIVERED", "READ"] as const;

export type Blocked = { lead: Lead & { stage: Stage }; messages: Message[]; waitingForAi: boolean };

/** The {{1}}, {{2}}... a sent template carried, read back from its text (the template's body with them filled in). */
export function templateParams(template: string, text: string): string[] | undefined {
  const parts = template.split(/\{\{(\d+)\}\}/);
  const order: number[] = [];
  let pattern = "^";
  parts.forEach((part, i) => {
    if (i % 2) {
      order.push(Number(part));
      pattern += "([\\s\\S]*?)";
    } else pattern += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const match = new RegExp(`${pattern}$`).exec(text);
  if (!match) return undefined;
  const params: string[] = [];
  order.forEach((n, i) => (params[n - 1] = match[i + 1]));
  return params;
}

/** Stages a paused daily queue sends leads to: contact there is on hold, so nothing goes again either. */
async function pausedQueueStages() {
  const rules = await db.automationRule.findMany({ where: { trigger: "daily", active: false }, select: { config: true } });
  return rules.flatMap((r) => (r.config as { toStageId?: string }).toStageId ?? []);
}

const reachedAfter = (leadId: string, at: Date) =>
  db.message.count({ where: { leadId, channel: "WHATSAPP", direction: "OUT", status: { in: [...REACHED] }, createdAt: { gt: at } } });

/**
 * Leads still waiting on WhatsApp messages that never went because the account was blocked (or Meta failed):
 * nothing reached them since, they are open, they can get WhatsApp and their queue is not paused.
 */
export async function blockedByAccount(since: Date, leadId?: string): Promise<Blocked[]> {
  const failed = await db.message.findMany({
    where: { channel: "WHATSAPP", direction: "OUT", status: "FAILED", createdAt: { gte: since }, ...(leadId && { leadId }) },
    orderBy: { createdAt: "asc" },
  });
  const byLead = new Map<string, Message[]>();
  for (const m of failed) if (isAccountFailure(m.errorCode)) byLead.set(m.leadId, [...(byLead.get(m.leadId) ?? []), m]);
  if (!byLead.size) return [];
  const paused = await pausedQueueStages();
  const leads = await db.lead.findMany({
    where: { id: { in: [...byLead.keys()] }, whatsappOptOut: false, phone: { not: null }, stageId: { notIn: paused } },
    include: { stage: true },
    orderBy: { createdAt: "asc" },
  });
  const blocked: Blocked[] = [];
  for (const lead of leads) {
    if (isClosed(lead) || lead.stage.key === SEND_ERROR_STAGE.key) continue;
    const all = byLead.get(lead.id)!;
    if (await reachedAfter(lead.id, all.at(-1)!.createdAt)) continue;
    // The lead wrote and the answer was lost: the AI answers again, with what is true now (free times change)
    const inbound = lead.lastInboundAt;
    const waitingForAi = !!(!lead.aiPaused && lead.sdrId && inbound && all.some((m) => m.createdAt > inbound) && !(await reachedAfter(lead.id, inbound)));
    // Otherwise the same messages, one of each, from the stage the lead is still in (an older stage's follow-up is stale)
    const seen = new Set<string>();
    const messages = all.filter((m) => m.createdAt >= lead.stageEnteredAt && !seen.has(m.body) && seen.add(m.body)).slice(-3);
    if (waitingForAi || messages.length) blocked.push({ lead, messages: waitingForAi ? all.slice(-1) : messages, waitingForAi });
  }
  return blocked;
}

/** What Integrações shows: who is still waiting, and the last time someone pressed the button (within the hour). */
export async function resendState(now = new Date()) {
  const [blocked, row] = await Promise.all([
    blockedByAccount(new Date(now.getTime() - RESEND_HOURS * 3600_000)),
    db.setting.findUnique({ where: { key: "whatsapp_resend" } }),
  ]);
  const last = row?.value as { at: string; by: string; count: number } | undefined;
  return { blocked, last: last && now.getTime() - Date.parse(last.at) < 3600_000 ? last : null };
}

/** Schedules the resend for every lead blockedByAccount finds, spaced out; a double click keeps one job per lead. */
export async function scheduleResends(now = new Date()) {
  const blocked = await blockedByAccount(new Date(now.getTime() - RESEND_HOURS * 3600_000));
  for (const [i, b] of blocked.entries())
    await enqueue("whatsapp.resend", {
      leadId: b.lead.id,
      payload: { since: new Date(now.getTime() - RESEND_HOURS * 3600_000).toISOString() },
      runAt: new Date(now.getTime() + i * SPACING_MS),
      dedupeKey: `resend:${b.lead.id}:${b.messages.at(-1)!.id}`,
      maxAttempts: 1,
    });
  return blocked.length;
}

/** Sends the lead's lost messages again: the same text inside the window, the same template (same values) outside it. */
export async function resendSame(b: Blocked, sdrNames: Set<string>) {
  const results: string[] = [];
  for (const m of b.messages) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: b.lead.id } });
    const template = m.template ? await db.whatsAppTemplate.findUnique({ where: { name: m.template } }) : null;
    const params = template ? templateParams(template.body, m.body) : undefined;
    const res = await sendWhatsApp(lead, m.body, m.author ?? "Automação", {
      automatic: true,
      ...(m.template ? { templateName: m.template, ...(params && { params }) } : sdrNames.has(m.author ?? "") && { purpose: "reengagement" }),
    });
    if (res.skipped) results.push(res.skipped);
    else if (!res.ok) throw new Error(res.error);
    else results.push(res.usedTemplate ? "reenviada pelo modelo da Meta" : "reenviada");
  }
  return results.join(" ");
}
