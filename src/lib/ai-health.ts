import { db } from "./db";
import { logEvent } from "./events";
import { isClosed } from "./messaging";
import { enqueueDebounced } from "./queue";
import { isWindowOpen } from "./whatsapp";

/**
 * When the Anthropic account runs out of credit (or its key stops working) Duda and Alice stop answering. The CRM says
 * so on every screen, and as soon as the AI answers again it replies to the leads who wrote meanwhile.
 */

const KEY = "ai_health";
const FAILED_TASK = "Automação falhou (sdr.reply): verificar";
// The leads waiting for the AI get their answers a little apart, as people would
const RESUME_GAP_MS = 20_000;

export type AiHealth = { message: string; at: string } | null;

/** The account problem behind an AI failure, in words for the team; null when it is not the account's (a timeout, a bad answer). */
export function aiAccountProblem(e: unknown): string | null {
  const status = (e as { status?: number } | null)?.status;
  const message = (e as Error | null)?.message ?? "";
  if (status === 402 || /credit balance is too low|billing/i.test(message))
    return "a conta da Anthropic está sem crédito. Coloque crédito em console.anthropic.com > Plans & Billing.";
  if (status === 401 || /authentication_error|invalid x-api-key/i.test(message))
    return "a chave da Anthropic (ANTHROPIC_API_KEY) não vale mais. Gere outra em console.anthropic.com > API Keys e troque no Vercel.";
  if (status === 403 || /permission_error/i.test(message)) return "a chave da Anthropic não tem permissão para usar a IA. Confira a conta em console.anthropic.com.";
  return null;
}

export async function getAiHealth(): Promise<AiHealth> {
  const v = (await db.setting.findUnique({ where: { key: KEY } }))?.value as { message?: string; at?: string } | undefined;
  return v?.message && v.at ? { message: v.message, at: v.at } : null;
}

/** Keeps the first moment the AI stopped, so the leads who wrote since then are the ones answered when it is back. */
export async function setAiHealth(message: string, now = new Date()) {
  const at = (await getAiHealth())?.at ?? now.toISOString();
  const value = { message, at };
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

/**
 * The AI answered again: the banner goes away, and every lead whose AI answer failed while it was down (and who is still
 * waiting: nobody answered by hand, AI on, WhatsApp window open) gets one now. Returns how many.
 */
export async function aiAnswered(opts: { now?: Date; answering?: string } = {}) {
  const now = opts.now ?? new Date();
  const health = await getAiHealth();
  if (!health) return 0;
  await db.setting.update({ where: { key: KEY }, data: { value: {} } });
  const failed = await db.job.findMany({
    where: { type: "sdr.reply", status: "FAILED", finishedAt: { gte: new Date(Date.parse(health.at) - 3600_000) } },
    select: { leadId: true },
  });
  const ids = [...new Set(failed.map((j) => j.leadId).filter((id): id is string => !!id))];
  let resumed = 0;
  // The lead the AI is answering right now already gets its answer
  for (const id of ids.filter((i) => i !== opts.answering)) {
    const lead = await db.lead.findUnique({ where: { id } });
    if (!lead?.sdrId || lead.aiPaused || lead.whatsappOptOut || isClosed(lead) || !isWindowOpen(lead.lastInboundAt, now)) continue;
    if (!["NEW", "AI_QUALIFYING", "QUALIFIED", "NURTURING"].includes(lead.status)) continue;
    // Someone answered by hand meanwhile: the conversation is theirs
    const last = await db.message.findFirst({ where: { leadId: id, channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, select: { direction: true } });
    if (last?.direction !== "IN") continue;
    await enqueueDebounced("sdr.reply", id, resumed * RESUME_GAP_MS);
    await db.task.updateMany({ where: { leadId: id, title: FAILED_TASK, doneAt: null }, data: { doneAt: now } });
    await logEvent(id, "ai.resumed", "IA", "A IA voltou a funcionar e vai responder a mensagem que ficou sem resposta.");
    resumed++;
  }
  return resumed;
}
