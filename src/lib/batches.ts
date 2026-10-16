import { db } from "./db";
import { moveLead } from "./leads";
import { getSettings, isTestContact } from "./settings";
import type { RuleConfig } from "./rules";
import { getHealth } from "./whatsapp";

const TZ = "America/Sao_Paulo";
// Spread over the day so Meta never sees a burst from the number
const PER_TICK = 5;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 18;

/** Day, weekday and hour in São Paulo, whatever the server's clock. */
export function localClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday as string, hour: Number(parts.hour) };
}

export function isSendingWindow(now = new Date()) {
  const { weekday, hour } = localClock(now);
  return !["Sat", "Sun"].includes(weekday) && hour >= OPEN_HOUR && hour < CLOSE_HOUR;
}

// Leads with WhatsApp leave first (e-mail only ones after), never contacted before the ones the
// old CRM already messaged, then newest first
const QUEUE_ORDER = [{ lastContactAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }] as const;

async function nextInQueue(stageId: string, take: number) {
  const where = { stageId, whatsappOptOut: false };
  const withPhone = await db.lead.findMany({ where: { ...where, phone: { not: null } }, orderBy: [...QUEUE_ORDER], take, select: { id: true } });
  if (withPhone.length === take) return withPhone;
  const emailOnly = await db.lead.findMany({ where: { ...where, phone: null }, orderBy: [...QUEUE_ORDER], take: take - withPhone.length, select: { id: true } });
  return [...withPhone, ...emailOnly];
}

/**
 * Queue stages ("Na fila"): each business day, a "daily" rule moves up to perDay leads to the
 * stage that does the contact (order in QUEUE_ORDER). In test mode only test contacts leave the
 * queue, so thousands of old leads are not used up by simulated messages.
 */
export async function runDailyBatches(now = new Date()) {
  const rules = await db.automationRule.findMany({ where: { trigger: "daily", active: true, action: "move" } });
  if (!rules.length || !isSendingWindow(now)) return { released: 0 };
  // Account blocked at Meta (payment pending, banned, expired token): keep everyone in the queue.
  // After 2 hours a few leads go out again as a probe; a success clears the block, a failure renews it.
  const health = await getHealth();
  if (health && now.getTime() - Date.parse(health.at) < 2 * 3600_000) return { released: 0, paused: health.message };
  const settings = await getSettings();
  const { day } = localClock(now);
  let released = 0;
  for (const rule of rules) {
    const config = rule.config as RuleConfig;
    if (!config.toStageId) continue;
    const key = `batch:${rule.id}:${day}`;
    const row = await db.setting.findUnique({ where: { key } });
    const done = (row?.value as { count?: number } | undefined)?.count ?? 0;
    const perDay = Math.max(1, config.perDay ?? 100);
    if (done >= perDay) continue;
    const take = Math.min(PER_TICK, perDay - done);
    const leads = settings.testMode
      ? (
          await db.lead.findMany({
            where: { stageId: rule.stageId, whatsappOptOut: false, OR: [{ phone: { not: null } }, { email: { not: null } }] },
            select: { id: true, phone: true, email: true },
          })
        )
          .filter((l) => (l.phone && isTestContact(settings, l.phone)) || (l.email && isTestContact(settings, l.email)))
          .slice(0, take)
      : await nextInQueue(rule.stageId, take);
    for (const lead of leads) await moveLead(lead.id, config.toStageId, "Automação (lote do dia)");
    if (leads.length) {
      const value = { count: done + leads.length };
      await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      released += leads.length;
    }
  }
  return { released };
}
