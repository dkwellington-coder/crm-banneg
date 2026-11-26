import { db } from "./db";
import { googleAgendaFor } from "./google";
import { createCalendarEvent, deleteCalendarEvent, moveCalendarEvent } from "./calendar";

/**
 * The secretary works on Wellington's Google agenda (wellington@banneg.com.br, the owner's: every CRM meeting goes there,
 * Wellington 2026-10-17). Meetings of CRM leads are booked, moved and canceled through the CRM itself (lib/jobs), so the
 * lead's page, the reminders and the team group stay right; anything else goes straight to Google.
 */

export async function agendaOwner() {
  const owner = await db.user.findFirst({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" }, select: { id: true, email: true, calendarId: true, name: true } });
  if (!owner) throw new Error("Nenhum dono cadastrado no CRM para usar a agenda.");
  return owner;
}

// free: shown as "livre" on Google (a collaborator's meeting), so it does not block his own times
export type AgendaEvent = { id: string; startsAt: Date; endsAt: Date; title: string; meet: string | null; guests: string[]; leadId: string | null; allDay: boolean; free: boolean };

type RawEvent = {
  id: string;
  status?: string;
  summary?: string;
  transparency?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string }[];
};

/** Everything on his agenda between two moments (also what he booked on the phone in that calendar). */
export async function listAgenda(from: Date, to: Date): Promise<AgendaEvent[]> {
  const owner = await agendaOwner();
  const agenda = await googleAgendaFor(owner);
  if (!agenda) throw new Error("A Agenda Google não está conectada no CRM (Integrações > Google Agenda).");
  const calendarId = agenda.invite ?? agenda.calendarId;
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", from.toISOString());
  url.searchParams.set("timeMax", to.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "100");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${agenda.accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Google Agenda (eventos): HTTP ${res.status}`);
  const items = ((await res.json()) as { items?: RawEvent[] }).items ?? [];
  const ids = items.map((e) => e.id);
  const crm = ids.length ? await db.meeting.findMany({ where: { calendarEventId: { in: ids } }, select: { calendarEventId: true, leadId: true } }) : [];
  return items
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const allDay = !e.start?.dateTime;
      return {
        id: e.id,
        startsAt: new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00-03:00`),
        endsAt: new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00-03:00`),
        title: e.summary || "(sem título)",
        meet: e.hangoutLink ?? null,
        guests: (e.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
        leadId: crm.find((m) => m.calendarEventId === e.id)?.leadId ?? null,
        allDay,
        free: e.transparency === "transparent",
      };
    });
}

/** "Camila · Reunião com a Porto": every meeting of the team on his agenda starts with whose it is (Wellington, 2026-11-26). */
export function ownerTitle(owner: string, title: string) {
  const t = title.trim() || "Reunião";
  const o = owner.trim();
  if (!o) return t;
  return t.toLowerCase().startsWith(o.toLowerCase()) ? t : `${o} · ${t}`;
}

/** Whether an event of the agenda is this person's ("Camila · …"). */
export function ownedBy(title: string, owner: string) {
  const o = owner.trim().toLowerCase();
  return !!o && title.trim().toLowerCase().startsWith(`${o} ·`);
}

/**
 * What on the agenda overlaps a time (all-day events do not block). For his own time, the collaborators' meetings
 * ("livre") do not count; for a collaborator's meeting, only that person's own meetings do.
 */
export function overlapping(events: AgendaEvent[], startsAt: Date, endsAt: Date, opts: { ignoreId?: string; owner?: string | null } = {}) {
  return events.filter(
    (e) =>
      !e.allDay &&
      e.id !== opts.ignoreId &&
      e.startsAt < endsAt &&
      e.endsAt > startsAt &&
      (opts.owner ? ownedBy(e.title, opts.owner) : !e.free),
  );
}

export async function conflictsWith(startsAt: Date, endsAt: Date, ignoreId?: string, owner?: string | null) {
  const events = await listAgenda(new Date(startsAt.getTime() - 12 * 3_600_000), new Date(endsAt.getTime() + 12 * 3_600_000));
  return overlapping(events, startsAt, endsAt, { ignoreId, owner });
}

/** One event of his agenda by id (title and time), or null when it is gone. */
export async function agendaEvent(eventId: string) {
  const owner = await agendaOwner();
  const agenda = await googleAgendaFor(owner);
  if (!agenda) throw new Error("A Agenda Google não está conectada no CRM (Integrações > Google Agenda).");
  const calendarId = agenda.invite ?? agenda.calendarId;
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    headers: { Authorization: `Bearer ${agenda.accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Google Agenda (evento): HTTP ${res.status}`);
  const e = (await res.json()) as RawEvent;
  return e.status === "cancelled" ? null : { id: e.id, title: e.summary || "(sem título)", free: e.transparency === "transparent" };
}

/** A meeting that is not with a CRM lead: on his agenda with a Meet link, the guests invited by Google. */
export async function bookOnAgenda(input: { title: string; description: string; startsAt: Date; endsAt: Date; guests: string[]; free?: boolean }) {
  const owner = await agendaOwner();
  const ev = await createCalendarEvent({
    user: owner,
    summary: input.title,
    description: input.description,
    slot: { startsAt: input.startsAt, endsAt: input.endsAt },
    guests: input.guests,
    free: input.free,
  });
  if (!ev) throw new Error("A Agenda Google não está conectada no CRM (Integrações > Google Agenda).");
  return ev;
}

export async function moveOnAgenda(eventId: string, startsAt: Date, endsAt: Date) {
  const ev = await moveCalendarEvent(await agendaOwner(), eventId, { startsAt, endsAt });
  if (!ev) throw new Error("A Agenda Google não está conectada no CRM.");
  return ev;
}

export async function deleteOnAgenda(eventId: string) {
  if (!(await deleteCalendarEvent(await agendaOwner(), eventId))) throw new Error("A Agenda Google não está conectada no CRM.");
}
