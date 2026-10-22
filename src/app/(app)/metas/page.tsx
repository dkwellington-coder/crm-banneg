import { Suspense } from "react";
import Link from "next/link";
import { CalendarCheck, ChevronLeft, ChevronRight, CircleDollarSign, Handshake, MessagesSquare, TrendingDown, TrendingUp } from "lucide-react";
import { connection } from "next/server";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { METRICS, actuals, actualsBetween, currentPeriod, money, pace, periodLabel, shiftPeriod, todayRange, workingDays, type MetricKey } from "@/lib/goals";
import { Avatar, Card, Loading, PageHeader, btnGhostCls } from "@/components/ui";
import { GoalsForm } from "./GoalsForm";

export default function MetasPage({ searchParams }: PageProps<"/metas">) {
  return (
    <>
      <PageHeader title="Metas" subtitle="Atendimentos, reuniões e vendas do mês: da equipe e de cada pessoa, com o ritmo para bater." />
      <Suspense fallback={<Loading />}>
        <Goals searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const ICON = { atendimentos: MessagesSquare, reunioes: CalendarCheck, vendas: Handshake, receita: CircleDollarSign };
const TINT: Record<MetricKey, string> = {
  atendimentos: "#0ea5e9",
  reunioes: "#f59e0b",
  vendas: "#16a34a",
  receita: "#7c3aed",
};

async function Goals({ searchParams }: { searchParams: PageProps<"/metas">["searchParams"] }) {
  const user = await requireUser();
  await connection();
  const sp = await searchParams;
  const now = new Date();
  const period = typeof sp.p === "string" && /^\d{4}-\d{2}$/.test(sp.p) ? sp.p : currentPeriod(now);
  const today = todayRange(now);
  const [goals, users, get, getToday] = await Promise.all([
    db.goal.findMany({ where: { period } }),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }),
    actuals(period),
    actualsBetween(today.start, today.end),
  ]);
  // Saturday and Sunday have no daily goal
  const workingToday = ![0, 6].includes(new Date(now.getTime() - 3 * 3600_000).getUTCDay());
  const target = (metric: string, userId: string | null) => goals.find((g) => g.metric === metric && g.userId === userId)?.target ?? 0;
  const fmtValue = (metric: MetricKey, v: number) => (METRICS.find((m) => m.key === metric)!.money ? money(v) : v.toLocaleString("pt-BR"));
  const editing = sp.editar === "1" && user.role !== "SELLER";
  const isCurrent = period === currentPeriod(now);

  return (
    <div className="space-y-5 px-4 pb-10 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center rounded-xl bg-white p-1 shadow-sm ring-1 ring-slate-200">
          <Link href={`/metas?p=${shiftPeriod(period, -1)}`} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" title="Mês anterior">
            <ChevronLeft size={18} />
          </Link>
          <span className="min-w-36 px-2 text-center text-sm font-semibold">{periodLabel(period)}</span>
          <Link href={`/metas?p=${shiftPeriod(period, 1)}`} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" title="Próximo mês">
            <ChevronRight size={18} />
          </Link>
        </div>
        {!isCurrent && (
          <Link href="/metas" className="text-sm text-brand hover:underline">
            Voltar para o mês atual
          </Link>
        )}
        {user.role !== "SELLER" && !editing && (
          <Link href={`/metas?p=${period}&editar=1`} className={`${btnGhostCls} ml-auto`}>
            Definir metas
          </Link>
        )}
      </div>

      {editing ? (
        <GoalsForm
          period={period}
          workingDays={workingDays(period)}
          users={users.map((u) => ({ id: u.id, name: u.name }))}
          metrics={METRICS.map((m) => ({ key: m.key, label: m.label, money: m.money }))}
          values={Object.fromEntries(
            [null, ...users.map((u) => u.id)].flatMap((who) => METRICS.map((m) => [`${m.key}:${who ?? "team"}`, target(m.key, who) || ""])),
          )}
        />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {METRICS.map((m) => {
              const actual = get(m.key, null);
              const t = target(m.key, null);
              const p = pace(actual, t, period, now);
              const Icon = ICON[m.key];
              return (
                <Card key={m.key} className="relative overflow-hidden">
                  <div className="flex items-center gap-2">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: TINT[m.key] }}>
                      <Icon size={18} />
                    </span>
                    <div>
                      <div className="text-sm font-semibold">{m.label}</div>
                      <div className="text-[11px] text-slate-500">{m.hint}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-end justify-between gap-2">
                    <div className="text-3xl font-bold tracking-tight">{fmtValue(m.key, actual)}</div>
                    {t > 0 && <div className="pb-1 text-sm text-slate-500">de {fmtValue(m.key, t)}</div>}
                  </div>
                  {t > 0 ? (
                    <>
                      <Ring percent={p.percent} color={TINT[m.key]} expected={t ? (p.expectedByNow / t) * 100 : 0} />
                      <div className="mt-2 flex items-center justify-between text-xs">
                        <span className={`inline-flex items-center gap-1 font-semibold ${p.onTrack ? "text-emerald-600" : "text-amber-600"}`}>
                          {p.onTrack ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                          {p.percent}% da meta · {p.onTrack ? "no ritmo" : "abaixo do ritmo"}
                        </span>
                        {isCurrent && actual < t && (
                          <span className="text-slate-500">
                            faltam {m.money ? money(Math.ceil(p.perDay)) : (Math.ceil(p.perDay * 10) / 10).toLocaleString("pt-BR")} por dia útil
                          </span>
                        )}
                      </div>
                      {isCurrent && workingToday && (
                        <div className="mt-2 flex items-center justify-between rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs">
                          <span className="font-medium text-slate-600">Hoje</span>
                          <span className={getToday(m.key, null) >= p.dailyTarget ? "font-semibold text-emerald-600" : "font-semibold text-slate-700"}>
                            {fmtValue(m.key, getToday(m.key, null))} de{" "}
                            {m.money ? money(Math.ceil(p.dailyTarget)) : (Math.round(p.dailyTarget * 10) / 10).toLocaleString("pt-BR")}
                          </span>
                        </div>
                      )}
                      {isCurrent && <div className="mt-1 text-[11px] text-slate-400">Projeção do mês: {fmtValue(m.key, p.projected)}</div>}
                    </>
                  ) : (
                    <p className="mt-3 text-xs text-slate-400">Sem meta para este mês.</p>
                  )}
                </Card>
              );
            })}
          </div>

          <Card className="p-0">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Por pessoa</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th className="px-4 py-2 font-medium">Pessoa</th>
                    {METRICS.map((m) => (
                      <th key={m.key} className="px-4 py-2 font-medium">
                        {m.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Avatar name={u.name} size={28} />
                          <span className="font-medium">{u.name}</span>
                        </div>
                      </td>
                      {METRICS.map((m) => {
                        const actual = get(m.key, u.id);
                        const t = target(m.key, u.id);
                        const pct = t ? Math.min(100, Math.round((actual / t) * 100)) : 0;
                        return (
                          <td key={m.key} className="min-w-40 px-4 py-3">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="font-semibold">{fmtValue(m.key, actual)}</span>
                              {t > 0 && <span className="text-xs text-slate-400">/ {fmtValue(m.key, t)}</span>}
                            </div>
                            {t > 0 && (
                              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: TINT[m.key] }} />
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
              Atendimentos e vendas contam para o responsável do lead; reuniões, para quem vai conduzir. Para a receita contar, preencha o valor
              do negócio no lead.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

/** Progress bar with a tick where the team should be by today. */
function Ring({ percent, color, expected }: { percent: number; color: string; expected: number }) {
  return (
    <div className="relative mt-3 h-2.5 rounded-full bg-slate-100">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, percent)}%`, background: color }} />
      {expected > 0 && expected < 100 && (
        <span className="absolute -top-1 h-4.5 w-0.5 rounded bg-slate-400" style={{ left: `${expected}%` }} title="Onde deveria estar hoje" />
      )}
    </div>
  );
}
