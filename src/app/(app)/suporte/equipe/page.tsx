import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { supportViewer } from "@/lib/support-access";
import {
  clock,
  dayStart,
  dayWork,
  DEFAULT_HOURS,
  duration,
  human,
  replies,
  summarize,
  whoOf,
  type DayWork,
  type MetricMessage,
  type PersonSummary,
  type WorkHours,
} from "@/lib/support-metrics";
import { Avatar, Card, Loading, PageHeader, Tabs, tabCls } from "@/components/ui";
import { phoneLabel, SupportTabs, WaitBadge } from "../parts";

const DAY = 86_400_000;
const PERIODS = [
  { key: "hoje", label: "Hoje", days: 1, back: 0 },
  { key: "ontem", label: "Ontem", days: 1, back: 1 },
  { key: "7", label: "7 dias", days: 7, back: 0 },
  { key: "30", label: "30 dias", days: 30, back: 0 },
] as const;

export default function EquipePage({ searchParams }: PageProps<"/suporte/equipe">) {
  return (
    <>
      <PageHeader title="Suporte" subtitle="Tempo de resposta, volume e horas de trabalho de cada atendente, medidos pelo WhatsApp." />
      <Suspense fallback={<Loading />}>
        <Team searchParams={searchParams} />
      </Suspense>
    </>
  );
}

type Person = { key: string; name: string; hours: WorkHours; registered: boolean };

async function Team({ searchParams }: { searchParams: PageProps<"/suporte/equipe">["searchParams"] }) {
  const [viewer, sp] = await Promise.all([supportViewer(), searchParams]);
  if (!viewer.monitor) redirect("/suporte");
  const period = PERIODS.find((p) => p.key === sp.p) ?? PERIODS[0];
  const now = new Date().getTime();
  const today = dayStart(now);
  const from = today - (period.back + period.days - 1) * DAY;
  const to = period.back ? today - (period.back - 1) * DAY : now;

  const [attendants, numbers, rows, waitingChats] = await Promise.all([
    db.supportAttendant.findMany({ orderBy: { name: "asc" }, include: { numbers: { select: { id: true } } } }),
    db.supportNumber.findMany({ include: { attendants: { select: { workDays: true, workStart: true, workEnd: true } } } }),
    // From two days before: a wait that began the night before still counts on the day it was answered
    db.supportMessage.findMany({
      where: { createdAt: { gte: new Date(from - 2 * DAY), lt: new Date(to) }, chat: { number: { active: true } } },
      select: { chatId: true, createdAt: true, direction: true, via: true, attendantId: true, author: true, chat: { select: { numberId: true } } },
    }),
    db.supportChat.findMany({
      where: { ...viewer.chatWhere, waitingSince: { not: null } },
      orderBy: { waitingSince: "asc" },
      take: 30,
      include: { number: { select: { name: true } } },
    }),
  ]);

  // A chat follows the hours of its number's attendant (one person); shared numbers use 8h-18h, Mon-Fri
  const numberHours = new Map(numbers.map((n) => [n.id, n.attendants.length === 1 ? n.attendants[0] : DEFAULT_HOURS]));
  const chatNumber = new Map(rows.map((r) => [r.chatId, r.chat.numberId]));
  const hoursOf = (chatId: string) => numberHours.get(chatNumber.get(chatId) ?? "") ?? DEFAULT_HOURS;
  const messages: MetricMessage[] = rows.map((r) => ({ chatId: r.chatId, at: r.createdAt, direction: r.direction, via: r.via, attendantId: r.attendantId, author: r.author }));

  const summaries = new Map(summarize(messages, hoursOf, from).map((s) => [s.who, s]));
  const people: Person[] = [
    ...attendants.filter((a) => a.active || summaries.has(a.id)).map((a) => ({ key: a.id, name: a.name, hours: a, registered: true })),
    ...[...summaries.keys()]
      .filter((k) => k.startsWith("autor:"))
      .map((k) => ({ key: k, name: k.slice(6), hours: DEFAULT_HOURS, registered: false })),
  ];
  const sentTimes = (who: string) => messages.filter((m) => human(m) && whoOf(m) === who && +m.at >= from).map((m) => m.at);

  // The whole team
  const all = replies(messages, hoursOf).done.filter((r) => +r.answeredAt >= from);
  const avgAll = all.length ? all.reduce((s, r) => s + r.ms, 0) / all.length : null;
  const in5 = all.length ? all.filter((r) => r.ms <= 5 * 60_000).length / all.length : null;
  const received = messages.filter((m) => m.direction === "IN" && +m.at >= from).length;
  const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

  const days: number[] = [];
  for (let d = from; d < to; d += DAY) days.push(d);
  const single = period.days === 1;

  return (
    <div className="space-y-4 px-4 pb-6 md:px-6">
      <div>
        <SupportTabs active="equipe" monitor owner={viewer.owner} waiting={waitingChats.length} />
        <Tabs>
          {PERIODS.map((p) => (
            <Link key={p.key} href={`/suporte/equipe?p=${p.key}`} className={tabCls(p.key === period.key)}>
              {p.label}
            </Link>
          ))}
        </Tabs>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Mensagens de clientes" value={received} hint={`${all.length} respondidas por uma pessoa`} />
        <Kpi label="Tempo médio de resposta" value={duration(avgAll)} hint="só dentro do expediente" gold />
        <Kpi label="Respondidas em até 5 min" value={pct(in5)} hint={all.length ? `de ${all.length} respostas` : "sem respostas no período"} />
        <Kpi
          label="Esperando agora"
          value={waitingChats.length}
          hint={waitingChats[0]?.waitingSince ? `a mais antiga há ${duration(now - waitingChats[0].waitingSince.getTime())}` : "ninguém na fila"}
          alert={waitingChats.some((c) => c.waitingSince && now - c.waitingSince.getTime() > 15 * 60_000)}
        />
      </div>

      {people.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500">
            Nenhum atendente cadastrado e nenhuma resposta no período.{" "}
            {viewer.owner && (
              <Link href="/suporte/numeros" className="font-medium text-brand underline">
                Cadastre os atendentes
              </Link>
            )}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {people.map((p) => (
            <PersonCard key={p.key} person={p} s={summaries.get(p.key)} work={single ? dayWork(from, sentTimes(p.key), p.hours) : null} now={now} />
          ))}
        </div>
      )}

      {people.length > 0 && (
        <Card>
          <h2 className="mb-1 font-semibold">{single ? `Linha do tempo · ${period.label.toLowerCase()}` : "Jornada dia a dia"}</h2>
          <p className="mb-3 text-xs text-slate-500">
            {single
              ? "Faixa clara = expediente combinado. Blocos dourados = trechos em que a pessoa estava respondendo (mensagens com até 15 min entre elas)."
              : "Entrada e saída = primeira e última mensagem do dia. Horas ativas somam os trechos com mensagens até 15 min uma da outra."}
          </p>
          {single ? (
            <div className="space-y-3">
              <HourScale />
              {people.map((p) => (
                <TimelineRow key={p.key} name={p.name} work={dayWork(from, sentTimes(p.key), p.hours)} />
              ))}
            </div>
          ) : (
            <DayTable people={people} days={days} sentTimes={sentTimes} />
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-2 font-semibold">Fila agora</h2>
        {waitingChats.length === 0 ? (
          <p className="text-sm text-slate-400">Ninguém esperando resposta.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {waitingChats.map((c) => (
              <Link key={c.id} href={`/suporte/c/${c.id}`} className="flex items-center gap-3 py-2 hover:bg-slate-50">
                <Avatar name={c.name ?? c.phone ?? "?"} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{c.name || phoneLabel(c.phone)}</div>
                  <div className="truncate text-xs text-slate-500">
                    {c.number.name} · {c.lastBody}
                  </div>
                </div>
                {c.waitingSince && <WaitBadge since={c.waitingSince} now={now} />}
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// No message that day: nothing worked, not "less than a minute"
const active = (ms: number | null | undefined) => (ms ? duration(ms) : "0");

function Kpi({ label, value, hint, gold, alert }: { label: string; value: string | number; hint?: string; gold?: boolean; alert?: boolean }) {
  return (
    <Card className={alert ? "ring-2 ring-red-300" : gold ? "ring-1 ring-gold/40" : ""}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${alert ? "text-red-700" : gold ? "text-gold-ink" : ""}`}>{value}</div>
      {hint && <div className="text-xs text-slate-400">{hint}</div>}
    </Card>
  );
}

function PersonCard({ person, s, work, now }: { person: Person; s?: PersonSummary; work: DayWork | null; now: number }) {
  const activeNow = work?.lastAt && now - work.lastAt < 15 * 60_000;
  const stat = (label: string, value: string | number) => (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="font-semibold">{value}</div>
    </div>
  );
  const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
  return (
    <Card>
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={person.name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{person.name}</div>
          <div className="text-xs text-slate-500">
            {person.registered ? `Expediente ${person.hours.workStart}–${person.hours.workEnd}` : "Respondeu pelo CRM (não é atendente cadastrado)"}
          </div>
        </div>
        {work && (
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              activeNow ? "bg-emerald-100 text-emerald-700" : work.firstAt ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-800"
            }`}
          >
            <span className={`size-1.5 rounded-full ${activeNow ? "bg-emerald-500" : work.firstAt ? "bg-slate-400" : "bg-amber-500"}`} />
            {activeNow ? "Ativo agora" : work.firstAt ? `Última às ${clock(work.lastAt)}` : "Sem atividade"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        {stat("1ª resposta (média)", duration(s?.avgFirstMs))}
        {stat("Resposta (mediana)", duration(s?.medianMs))}
        {stat("Em até 5 min", pct(s?.within5))}
        {stat("Conversas", s?.chats ?? 0)}
        {stat("Mensagens", s?.sent ?? 0)}
        {stat("Horas ativas", active(s?.activeMs))}
      </div>
      {work && (work.firstAt || work.shift) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-xs text-slate-600">
          <span>
            Entrada <b>{clock(work.firstAt)}</b>
          </span>
          <span>
            Saída <b>{clock(work.lastAt)}</b>
          </span>
          {work.lateMs > 0 && <span className="font-semibold text-amber-700">Começou {duration(work.lateMs)} depois</span>}
          {work.longestGapMs > 60 * 60_000 && <span className="text-slate-500">Maior intervalo {duration(work.longestGapMs)}</span>}
        </div>
      )}
      {!work && s && <div className="mt-3 border-t border-slate-100 pt-2 text-xs text-slate-500">{s.daysWorked} dia(s) com atividade no período</div>}
    </Card>
  );
}

// The day's bar runs from 6h to 22h
const BAR_FROM = 6;
const BAR_TO = 22;
const pos = (t: number, d0: number) => Math.min(100, Math.max(0, (((t - d0) / 3_600_000 - BAR_FROM) / (BAR_TO - BAR_FROM)) * 100));

function HourScale() {
  const marks = [6, 8, 10, 12, 14, 16, 18, 20, 22];
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 max-sm:w-20" />
      <div className="relative h-4 flex-1 text-[10px] text-slate-400">
        {marks.map((h) => (
          <span key={h} className="absolute -translate-x-1/2" style={{ left: `${((h - BAR_FROM) / (BAR_TO - BAR_FROM)) * 100}%` }}>
            {h}h
          </span>
        ))}
      </div>
      <div className="w-16 shrink-0" />
    </div>
  );
}

function TimelineRow({ name, work }: { name: string; work: DayWork }) {
  const d0 = dayStart(new Date(`${work.day}T12:00:00-03:00`));
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 shrink-0 truncate text-sm font-medium max-sm:w-20">{name}</div>
      <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-slate-100">
        {work.shift && (
          <div
            className="absolute inset-y-0 bg-gold-soft"
            style={{ left: `${pos(work.shift.start, d0)}%`, width: `${pos(work.shift.end, d0) - pos(work.shift.start, d0)}%` }}
            title={`Expediente ${clock(work.shift.start)}–${clock(work.shift.end)}`}
          />
        )}
        {work.stretches.map((s) => (
          <div
            key={s.start}
            className="absolute inset-y-1 rounded bg-gold"
            style={{ left: `${pos(s.start, d0)}%`, width: `max(3px, ${pos(s.end, d0) - pos(s.start, d0)}%)` }}
            title={`${clock(s.start)}–${clock(s.end)} · ${s.messages} mensagem(ns)`}
          />
        ))}
      </div>
      <div className="w-16 shrink-0 text-right text-xs font-semibold">{active(work.activeMs)}</div>
    </div>
  );
}

function DayTable({ people, days, sentTimes }: { people: Person[]; days: number[]; sentTimes: (who: string) => Date[] }) {
  const rows = people.flatMap((p) => {
    const times = sentTimes(p.key);
    return days
      .map((d) => ({ p, w: dayWork(d, times, p.hours) }))
      // A shift that has not started yet is not an absence
      .filter(({ w }) => w.firstAt !== null || (w.shift && p.registered && w.shift.start < new Date().getTime()));
  });
  if (!rows.length) return <p className="text-sm text-slate-400">Sem atividade no período.</p>;
  rows.sort((a, b) => (a.w.day === b.w.day ? a.p.name.localeCompare(b.p.name) : b.w.day.localeCompare(a.w.day)));
  const dayLabel = (key: string) => {
    const d = new Date(`${key}T12:00:00-03:00`);
    return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" });
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="pb-1 font-medium">Dia</th>
            <th className="pb-1 font-medium">Atendente</th>
            <th className="pb-1 text-right font-medium">Entrada</th>
            <th className="pb-1 text-right font-medium">Saída</th>
            <th className="pb-1 text-right font-medium">Horas ativas</th>
            <th className="pb-1 pl-3 font-medium">Observação</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(({ p, w }) => (
            <tr key={`${p.key}-${w.day}`}>
              <td className="py-1.5 capitalize text-slate-600">{dayLabel(w.day)}</td>
              <td className="py-1.5 font-medium">{p.name}</td>
              <td className="py-1.5 text-right">{clock(w.firstAt)}</td>
              <td className="py-1.5 text-right">{clock(w.lastAt)}</td>
              <td className="py-1.5 text-right font-semibold">{active(w.activeMs)}</td>
              <td className="py-1.5 pl-3 text-xs">
                {w.firstAt === null ? (
                  <span className="font-semibold text-red-700">Sem atividade no expediente</span>
                ) : (
                  [
                    w.lateMs > 0 && <span key="l" className="text-amber-700">começou {duration(w.lateMs)} depois</span>,
                    w.earlyMs > 0 && <span key="e" className="text-amber-700">parou {duration(w.earlyMs)} antes</span>,
                    !w.shift && <span key="o" className="text-slate-500">fora dos dias combinados</span>,
                  ]
                    .filter(Boolean)
                    .reduce<ReactNode[]>((acc, x, i) => (i ? [...acc, " · ", x] : [x]), [])
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

