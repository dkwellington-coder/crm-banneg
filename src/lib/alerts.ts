import { db } from "./db";

export type Alert = {
  // Changes when there is something new to warn about (a new message from the same lead rings again)
  key: string;
  kind: "new" | "waiting";
  leadId: string;
  pipelineId: string;
  name: string;
  text: string;
  at: string;
};

const WEEK = 7 * 86_400_000;

/**
 * What needs a person right now: new leads nobody on the team has opened yet (not the ones waiting
 * in a queue or already closed), and leads waiting for an answer: they wrote and no AI is answering,
 * or the AI handed them over with a task that is due.
 */
export async function teamAlerts(now = new Date()) {
  const [fresh, wrote, tasks] = await Promise.all([
    db.lead.findMany({
      where: { seenAt: null, createdAt: { gte: new Date(now.getTime() - WEEK) }, stage: { kind: "OPEN", NOT: { key: "fila" } } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, pipelineId: true, name: true, phone: true, email: true, source: true, createdAt: true },
    }),
    // Same rule as Conversas > "Aguardando uma pessoa": the lead's last WhatsApp message is theirs and no AI is on it
    db.$queryRaw<{ id: string; pipelineId: string; name: string | null; phone: string | null; body: string; at: Date }[]>`
      SELECT l.id, l."pipelineId", l.name, l.phone, m.body, m."createdAt" AS at
      FROM (SELECT DISTINCT ON ("leadId") "leadId", direction, body, "createdAt" FROM "Message"
            WHERE channel = 'WHATSAPP' ORDER BY "leadId", "createdAt" DESC) m
      JOIN "Lead" l ON l.id = m."leadId"
      WHERE m.direction = 'IN' AND (l."sdrId" IS NULL OR l."aiPaused")
        AND (l."alertsClearedAt" IS NULL OR m."createdAt" > l."alertsClearedAt")
      ORDER BY m."createdAt" DESC LIMIT 100`,
    db.task.findMany({
      where: { doneAt: null, dueAt: { lte: now }, leadId: { not: null } },
      orderBy: { dueAt: "desc" },
      take: 100,
      select: { id: true, title: true, dueAt: true, lead: { select: { id: true, pipelineId: true, name: true, phone: true, alertsClearedAt: true } } },
    }),
  ]);
  const label = (l: { name: string | null; phone?: string | null; email?: string | null }) => l.name ?? l.phone ?? l.email ?? "Lead sem nome";
  const newLeads: Alert[] = fresh.map((l) => ({
    key: `new:${l.id}`,
    kind: "new",
    leadId: l.id,
    pipelineId: l.pipelineId,
    name: label(l),
    text: `Lead novo (${l.source})`,
    at: l.createdAt.toISOString(),
  }));
  const waiting: Alert[] = wrote.map((l) => ({
    key: `msg:${l.id}:${l.at.getTime()}`,
    kind: "waiting",
    leadId: l.id,
    pipelineId: l.pipelineId,
    name: label(l),
    text: l.body.length > 120 ? `${l.body.slice(0, 117)}...` : l.body,
    at: l.at.toISOString(),
  }));
  const waitingIds = new Set(waiting.map((w) => w.leadId));
  for (const t of tasks) {
    if (!t.lead || waitingIds.has(t.lead.id)) continue;
    // Already handled: a later task still rings when it falls due
    if (t.lead.alertsClearedAt && t.dueAt <= t.lead.alertsClearedAt) continue;
    waitingIds.add(t.lead.id);
    waiting.push({
      key: `task:${t.id}`,
      kind: "waiting",
      leadId: t.lead.id,
      pipelineId: t.lead.pipelineId,
      name: label(t.lead),
      text: t.title,
      at: t.dueAt.toISOString(),
    });
  }
  // A new lead that already wrote shows once, as waiting
  const items = [...waiting, ...newLeads.filter((n) => !waitingIds.has(n.leadId))];
  return {
    newLeads: items.filter((i) => i.kind === "new").length,
    waiting: waiting.length,
    items,
  };
}

export type TeamAlerts = Awaited<ReturnType<typeof teamAlerts>>;

/** The lead was opened by someone on the team: it stops counting as new. */
export function markSeen(leadId: string) {
  return db.lead.updateMany({ where: { id: leadId, seenAt: null }, data: { seenAt: new Date() } });
}

/**
 * Someone answered the lead, moved it, booked or marked the alert as seen: the alert goes away.
 * A new message from the lead, or a task that falls due later, alerts again.
 */
export async function clearAlerts(leadId: string) {
  await db.lead.update({ where: { id: leadId }, data: { alertsClearedAt: new Date() } });
  await markSeen(leadId);
}
