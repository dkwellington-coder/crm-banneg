import { db } from "./db";
import { formatSlot } from "./calendar";

export type Alert = {
  // Changes when there is something new to warn about (a new message from the same lead rings again)
  key: string;
  kind: "new" | "waiting" | "meeting";
  leadId: string;
  pipelineId: string;
  name: string;
  text: string;
  at: string;
};

const WEEK = 7 * 86_400_000;

/**
 * Only what needs a person (Wellington, 2026-11-05): a lead the AI is taking care of does not light up.
 * - waiting: the lead wrote and no AI is answering, or the AI handed it over with a task that is due;
 * - meeting: a meeting was booked (by the AI) after the last time someone opened or handled the lead;
 * - new: a new lead no AI takes (none in the funnel, or paused) that nobody on the team opened yet
 *   (not the ones waiting in a queue or already closed).
 */
export async function teamAlerts(now = new Date()) {
  const [fresh, wrote, tasks, booked] = await Promise.all([
    db.lead.findMany({
      where: {
        seenAt: null,
        createdAt: { gte: new Date(now.getTime() - WEEK) },
        stage: { kind: "OPEN", NOT: { key: "fila" } },
        OR: [{ sdrId: null }, { aiPaused: true }],
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, pipelineId: true, name: true, phone: true, email: true, source: true, createdAt: true },
    }),
    // Same rule as Conversas > "Aguardando uma pessoa": the lead's last WhatsApp message is theirs and no AI is on it
    db.$queryRaw<{ id: string; pipelineId: string; name: string | null; phone: string | null; body: string; at: Date }[]>`
      SELECT l.id, l."pipelineId", l.name, l.phone, m.body, m."createdAt" AS at
      FROM "Lead" l
      -- Only the few leads no AI answers, each read through its (leadId, createdAt) index: runs every 15 s on every open screen
      CROSS JOIN LATERAL (SELECT direction, body, "createdAt" FROM "Message"
            WHERE "leadId" = l.id AND channel = 'WHATSAPP' ORDER BY "createdAt" DESC LIMIT 1) m
      WHERE m.direction = 'IN' AND (l."sdrId" IS NULL OR l."aiPaused")
        AND (l."alertsClearedAt" IS NULL OR m."createdAt" > l."alertsClearedAt")
      ORDER BY m."createdAt" DESC LIMIT 100`,
    db.task.findMany({
      where: { doneAt: null, dueAt: { lte: now }, leadId: { not: null } },
      orderBy: { dueAt: "desc" },
      take: 100,
      select: { id: true, title: true, dueAt: true, lead: { select: { id: true, pipelineId: true, name: true, phone: true, alertsClearedAt: true } } },
    }),
    // Booked and not over yet; whoever booked it by hand already cleared the alert (scheduleMeetingAction)
    db.meeting.findMany({
      where: { status: "scheduled", createdAt: { gte: new Date(now.getTime() - WEEK) }, endsAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        startsAt: true,
        createdAt: true,
        lead: { select: { id: true, pipelineId: true, name: true, phone: true, email: true, seenAt: true, alertsClearedAt: true } },
      },
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
  const after = (d: Date, mark: Date | null) => !mark || d > mark;
  const meetings: Alert[] = [];
  for (const m of booked) {
    const l = m.lead;
    if (waitingIds.has(l.id) || meetings.some((x) => x.leadId === l.id) || !after(m.createdAt, l.seenAt) || !after(m.createdAt, l.alertsClearedAt)) continue;
    meetings.push({
      key: `meeting:${m.id}`,
      kind: "meeting",
      leadId: l.id,
      pipelineId: l.pipelineId,
      name: label(l),
      text: `Reunião marcada: ${formatSlot(m.startsAt)}`,
      at: m.createdAt.toISOString(),
    });
  }
  // One mark per lead: an answer it waits for first, then the meeting, then "new"
  const marked = new Set([...waitingIds, ...meetings.map((m) => m.leadId)]);
  const items = [...waiting, ...meetings, ...newLeads.filter((n) => !marked.has(n.leadId))];
  return {
    newLeads: items.filter((i) => i.kind === "new").length,
    waiting: waiting.length,
    meetings: meetings.length,
    items,
  };
}

export type TeamAlerts = Awaited<ReturnType<typeof teamAlerts>>;

/**
 * The lead was opened by someone on the team: it stops counting as new. `again` moves the mark forward
 * (the lead page does it when a meeting was booked since the last time someone opened it).
 */
export function markSeen(leadId: string, again = false) {
  return db.lead.updateMany({ where: { id: leadId, ...(!again && { seenAt: null }) }, data: { seenAt: new Date() } });
}

/**
 * Someone answered the lead, moved it, booked or marked the alert as seen: the alert goes away.
 * A new message from the lead, or a task that falls due later, alerts again.
 */
export async function clearAlerts(leadId: string) {
  await db.lead.update({ where: { id: leadId }, data: { alertsClearedAt: new Date() } });
  await markSeen(leadId);
}
