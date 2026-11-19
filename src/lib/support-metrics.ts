// Suporte: how fast and how much each attendant works, from the WhatsApp messages alone. No database here, so it
// is easy to test: the screens load the messages and these functions count.

const BRT = -3 * 3_600_000; // Brasília has no daylight saving since 2019
const DAY = 86_400_000;
const MIN = 60_000;

export type WorkHours = { workDays: number[]; workStart: string; workEnd: string };
export const DEFAULT_HOURS: WorkHours = { workDays: [1, 2, 3, 4, 5], workStart: "08:00", workEnd: "18:00" };

/** A client message after this long without any message opens a new subject: its answer is a "first response". */
export const NEW_SUBJECT_GAP = 6 * 3_600_000;
/** Messages closer than this belong to the same stretch of work. */
export const ACTIVITY_GAP = 15 * MIN;
/** Time given to a stretch for reading and typing before its first message. */
export const ACTIVITY_LEAD_IN = 5 * MIN;

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Midnight (Brasília) of the day `at` falls on, as a UTC instant. */
export function dayStart(at: Date | number) {
  const t = typeof at === "number" ? at : at.getTime();
  return Math.floor((t + BRT) / DAY) * DAY - BRT;
}

/** "2026-11-19" in Brasília. */
export function dayKey(at: Date | number) {
  return new Date(dayStart(at) + BRT).toISOString().slice(0, 10);
}

/** 0 = Sunday, Brasília time. */
export function weekday(at: Date | number) {
  return new Date(dayStart(at) + BRT).getUTCDay();
}

/** The agreed working window of that day, or null on a day off. */
export function shiftOf(day: Date | number, hours: WorkHours): { start: number; end: number } | null {
  const d0 = dayStart(day);
  if (!hours.workDays.includes(weekday(d0))) return null;
  const start = d0 + minutesOf(hours.workStart) * MIN;
  const end = d0 + minutesOf(hours.workEnd) * MIN;
  return end > start ? { start, end } : null;
}

/** How much of [from, to] falls inside working hours: a message at 23h answered at 8h05 waited 5 minutes. */
export function businessMs(from: Date | number, to: Date | number, hours: WorkHours = DEFAULT_HOURS) {
  const a = +from;
  const b = +to;
  if (!(b > a)) return 0;
  let total = 0;
  // At most 60 days are walked: a wait longer than that is counted up to there
  for (let d = dayStart(a), n = 0; d < b && n < 60; d += DAY, n++) {
    const shift = shiftOf(d, hours);
    if (!shift) continue;
    total += Math.max(0, Math.min(b, shift.end) - Math.max(a, shift.start));
  }
  return total;
}

export type MetricMessage = {
  chatId: string;
  at: Date;
  direction: "IN" | "OUT";
  // phone / crm = a person; api = automatic: it does not answer anyone
  via: string;
  attendantId: string | null;
  author?: string | null;
};

export type Reply = {
  chatId: string;
  waitStart: Date;
  answeredAt: Date;
  // Waiting time inside working hours, and the plain clock time
  ms: number;
  clockMs: number;
  // Who answered: the attendant, or "autor:<name>" for someone who is not one
  who: string;
  first: boolean;
};

export const human = (m: Pick<MetricMessage, "direction" | "via">) => m.direction === "OUT" && m.via !== "api";
export const whoOf = (m: Pick<MetricMessage, "attendantId" | "author">) => m.attendantId ?? `autor:${m.author || "Sem nome"}`;

/**
 * Every time a client waited for a person: from their first unanswered message to the next message a person sent.
 * Messages must be of one or many chats, in any order. Waits still open come back in `waiting`.
 */
export function replies(messages: MetricMessage[], hoursOf: (chatId: string) => WorkHours = () => DEFAULT_HOURS) {
  const byChat = new Map<string, MetricMessage[]>();
  for (const m of messages) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
  const done: Reply[] = [];
  const waiting: { chatId: string; since: Date }[] = [];
  for (const [chatId, list] of byChat) {
    list.sort((x, y) => +x.at - +y.at);
    let waitStart: Date | null = null;
    let first = false;
    let previous: Date | null = null;
    for (const m of list) {
      if (m.direction === "IN") {
        if (!waitStart) {
          waitStart = m.at;
          first = !previous || +m.at - +previous >= NEW_SUBJECT_GAP;
        }
      } else if (human(m) && waitStart) {
        done.push({
          chatId,
          waitStart,
          answeredAt: m.at,
          ms: businessMs(waitStart, m.at, hoursOf(chatId)),
          clockMs: +m.at - +waitStart,
          who: whoOf(m),
          first,
        });
        waitStart = null;
      }
      previous = m.at;
    }
    if (waitStart) waiting.push({ chatId, since: waitStart });
  }
  return { done, waiting };
}

export type Stretch = { start: number; end: number; messages: number };

/** Stretches of work from the times a person sent messages: gaps up to 15 minutes are the same stretch. */
export function stretches(times: (Date | number)[]): Stretch[] {
  const sorted = times.map(Number).sort((a, b) => a - b);
  const out: Stretch[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t - last.end <= ACTIVITY_GAP) {
      last.end = t;
      last.messages++;
    } else out.push({ start: t - ACTIVITY_LEAD_IN, end: t, messages: 1 });
  }
  return out;
}

export type DayWork = {
  day: string;
  firstAt: number | null;
  lastAt: number | null;
  activeMs: number;
  stretches: Stretch[];
  shift: { start: number; end: number } | null;
  // Started after the agreed time (more than 15 min) / left before it (more than 15 min)
  lateMs: number;
  earlyMs: number;
  // Longest gap inside the agreed hours with nothing sent
  longestGapMs: number;
};

/** One person's day: first and last message, active hours and how it compares with the agreed hours. */
export function dayWork(day: Date | number, sentTimes: (Date | number)[], hours: WorkHours, now: number = Date.now()): DayWork {
  const d0 = dayStart(day);
  const mine = sentTimes.map(Number).filter((t) => t >= d0 && t < d0 + DAY);
  const list = stretches(mine);
  const shift = shiftOf(d0, hours);
  const firstAt = mine.length ? Math.min(...mine) : null;
  const lastAt = mine.length ? Math.max(...mine) : null;
  const tolerance = 15 * MIN;
  let longestGapMs = 0;
  if (shift && list.length) {
    // Gaps between stretches, plus the start and the end of the shift, clipped to the shift
    const edges = [shift.start, ...list.flatMap((s) => [s.start, s.end]), Math.min(shift.end, now)];
    for (let i = 0; i < edges.length; i += 2) {
      const from = Math.max(edges[i], shift.start);
      const to = Math.min(edges[i + 1], shift.end);
      longestGapMs = Math.max(longestGapMs, to - from);
    }
  }
  const late = shift && firstAt !== null ? firstAt - shift.start : 0;
  // Leaving early only counts once the shift is over
  const early = shift && lastAt !== null && lastAt < shift.end && now > shift.end ? shift.end - lastAt : 0;
  return {
    day: dayKey(d0),
    firstAt,
    lastAt,
    activeMs: list.reduce((s, x) => s + (x.end - x.start), 0),
    stretches: list,
    shift,
    lateMs: late > tolerance ? late : 0,
    earlyMs: early > tolerance ? early : 0,
    longestGapMs,
  };
}

export type PersonSummary = {
  who: string;
  replies: number;
  firstReplies: number;
  avgMs: number | null;
  medianMs: number | null;
  avgFirstMs: number | null;
  within5: number | null; // share of replies in up to 5 min (0..1)
  within15: number | null;
  sent: number;
  chats: number;
  activeMs: number;
  daysWorked: number;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The numbers on each person's card. Pass the messages from a little before `since` too: a client who wrote
 * the night before and was answered in the morning counts on the morning's day.
 */
export function summarize(
  messages: MetricMessage[],
  hoursOf: (chatId: string) => WorkHours = () => DEFAULT_HOURS,
  since: Date | number = 0,
): PersonSummary[] {
  const done = replies(messages, hoursOf).done.filter((r) => +r.answeredAt >= +since);
  const sentBy = new Map<string, MetricMessage[]>();
  for (const m of messages) if (human(m) && +m.at >= +since) sentBy.set(whoOf(m), [...(sentBy.get(whoOf(m)) ?? []), m]);
  const people = new Set([...sentBy.keys(), ...done.map((r) => r.who)]);
  return [...people].map((who) => {
    const mine = done.filter((r) => r.who === who);
    const ms = mine.map((r) => r.ms);
    const firsts = mine.filter((r) => r.first).map((r) => r.ms);
    const sent = sentBy.get(who) ?? [];
    const days = new Set(sent.map((m) => dayKey(m.at)));
    const activeMs = [...days].reduce((s, d) => {
      const times = sent.filter((m) => dayKey(m.at) === d).map((m) => m.at);
      return s + stretches(times).reduce((t, x) => t + (x.end - x.start), 0);
    }, 0);
    return {
      who,
      replies: mine.length,
      firstReplies: firsts.length,
      avgMs: avg(ms),
      medianMs: median(ms),
      avgFirstMs: avg(firsts),
      within5: ms.length ? ms.filter((x) => x <= 5 * MIN).length / ms.length : null,
      within15: ms.length ? ms.filter((x) => x <= 15 * MIN).length / ms.length : null,
      sent: sent.length,
      chats: new Set(sent.map((m) => m.chatId)).size,
      activeMs,
      daysWorked: days.size,
    };
  });
}

/** "4 min", "1 h 20", "2 d 3 h". */
export function duration(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—";
  const min = Math.round(ms / MIN);
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${String(min % 60).padStart(2, "0")}` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** "08:42" in Brasília. */
export function clock(t: number | Date | null | undefined) {
  if (t === null || t === undefined) return "—";
  const d = new Date(+t + BRT);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
