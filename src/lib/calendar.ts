import { db } from "./db";
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
  const busy = await db.meeting.findMany({
    where: { userId, status: "scheduled", endsAt: { gte: now } },
    select: { startsAt: true, endsAt: true },
  });
  return computeSlots({ now, hours, minutes, busy });
}

async function googleAccessToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google OAuth falhou: HTTP ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Creates the event (with a Meet link) on the manager's Google Calendar when Google is configured. */
export async function createCalendarEvent(input: {
  calendarId: string;
  summary: string;
  description: string;
  slot: Slot;
  attendeeEmail?: string | null;
}) {
  const token = await googleAccessToken();
  if (!token) return null;
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(input.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.slot.startsAt.toISOString() },
        end: { dateTime: input.slot.endsAt.toISOString() },
        attendees: input.attendeeEmail ? [{ email: input.attendeeEmail }] : [],
        conferenceData: { createRequest: { requestId: crypto.randomUUID() } },
      }),
    },
  );
  if (!res.ok) throw new Error(`Google Agenda recusou o evento: HTTP ${res.status} ${await res.text()}`);
  const ev = (await res.json()) as { id: string; hangoutLink?: string };
  return { id: ev.id, meetLink: ev.hangoutLink ?? null };
}
