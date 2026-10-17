import { db } from "./db";
import { googleAgendaFor } from "./google";
import type { BusinessHours } from "./settings";

// Brazil has had no daylight saving time since 2019, so São Paulo is a fixed UTC-3.
const SP_OFFSET_HOURS = -3;

export type Slot = { startsAt: Date; endsAt: Date };

function localParts(d: Date) {
  const shifted = new Date(d.getTime() + SP_OFFSET_HOURS * 3600_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

/** Free slots for a seller over the next `days` days, skipping busy meetings. Pure: easy to test. */
export function computeSlots(opts: {
  now: Date;
  hours: BusinessHours;
  minutes: number;
  busy: Slot[];
  days?: number;
  limit?: number;
}): Slot[] {
  const { now, hours, minutes, busy } = opts;
  const days = opts.days ?? 5;
  const limit = opts.limit ?? 6;
  const step = minutes * 60_000;
  // Earliest slot: 2 hours from now, rounded up to the next slot boundary
  let t = Math.ceil((now.getTime() + 2 * 3600_000) / step) * step;
  const end = now.getTime() + days * 86_400_000;
  const out: Slot[] = [];
  while (t < end && out.length < limit) {
    const s = new Date(t);
    const e = new Date(t + step);
    const p = localParts(s);
    const startMin = p.hour * 60 + p.minute;
    const endMin = startMin + minutes;
    const inHours = hours.days.includes(p.day) && startMin >= hours.start * 60 && endMin <= hours.end * 60;
    const clash = busy.some((b) => s < b.endsAt && e > b.startsAt);
    if (inHours && !clash) out.push({ startsAt: s, endsAt: e });
    t += step;
  }
  return out;
}

export const formatDay = (d: Date) =>
  d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" });
export const formatTime = (d: Date) => d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

export function formatSlot(d: Date) {
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The business manager who receives the next meeting: the one with the fewest upcoming meetings. */
export async function pickOwner() {
  const users = await db.user.findMany({
    where: { role: { in: ["MANAGER", "OWNER"] } },
    include: { _count: { select: { meetings: { where: { startsAt: { gte: new Date() } } } } } },
  });
  users.sort((a, b) => a._count.meetings - b._count.meetings);
  return users[0] ?? null;
}

export async function freeSlotsFor(userId: string, hours: BusinessHours, minutes: number, now = new Date()) {
  const [user, meetings] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, calendarId: true } }),
    db.meeting.findMany({
      where: { userId, status: "scheduled", endsAt: { gte: now } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  // The manager's real Google agenda counts too, so the AI never offers a time already taken
  let google: { startsAt: Date; endsAt: Date }[] = [];
  if (user) {
    try {
      google = await googleBusy(user, now, new Date(now.getTime() + 8 * 86_400_000));
    } catch {
      // Without Google, the CRM's own meetings are enough to avoid double booking
    }
  }
  // A whole week of free times, so the AI can book the day and time the lead asks for
  return computeSlots({ now, hours, minutes, busy: [...meetings, ...google], days: 7, limit: 120 });
}

type AgendaUser = { id: string; email: string; calendarId: string | null };

/** Busy periods on the manager's Google agenda; empty when nobody connected Google. */
export async function googleBusy(user: AgendaUser, from: Date, to: Date) {
  const agenda = await googleAgendaFor(user);
  if (!agenda) return [];
  // Booked through someone else's Google: ask for the manager's own calendar (visible inside the same company)
  const calendarId = agenda.invite ?? agenda.calendarId;
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${agenda.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] }),
  });
  if (!res.ok) throw new Error(`Google Agenda (disponibilidade): HTTP ${res.status}`);
  const json = (await res.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> };
  const cal = json.calendars?.[calendarId];
  if (cal?.errors?.length) throw new Error(`Google Agenda sem acesso ao calendário ${calendarId} (${cal.errors[0].reason}).`);
  return (cal?.busy ?? []).map((b) => ({ startsAt: new Date(b.start), endsAt: new Date(b.end) }));
}

/**
 * Creates the event with a Meet link on the manager's Google agenda (or on the connected one, with the
 * manager invited). Google e-mails the invitation to the lead when the lead has an e-mail.
 */
export async function createCalendarEvent(input: {
  user: AgendaUser;
  summary: string;
  description: string;
  slot: Slot;
  attendeeEmail?: string | null;
}) {
  const agenda = await googleAgendaFor(input.user);
  if (!agenda) return null;
  const attendees = [input.attendeeEmail, agenda.invite].filter((e): e is string => !!e).map((email) => ({ email }));
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(agenda.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${agenda.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.slot.startsAt.toISOString(), timeZone: "America/Sao_Paulo" },
        end: { dateTime: input.slot.endsAt.toISOString(), timeZone: "America/Sao_Paulo" },
        attendees,
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
        reminders: { useDefault: true },
      }),
    },
  );
  if (!res.ok) throw new Error(`Google Agenda recusou o evento: HTTP ${res.status} ${await res.text()}`);
  const ev = (await res.json()) as { id: string; hangoutLink?: string; htmlLink?: string };
  return { id: ev.id, meetLink: ev.hangoutLink ?? null, account: agenda.account };
}
