import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Loading, PageHeader, fmt } from "@/components/ui";
import { completeTaskAction } from "../../actions";

export default function AgendaPage() {
  return (
    <>
      <PageHeader title="Agenda" subtitle="Reuniões marcadas pela IA e pela equipe, e as tarefas de cada um." />
      <Suspense fallback={<Loading />}>
        <Agenda />
      </Suspense>
    </>
  );
}

/** "2026-10-22" for the day the date falls on in Brasília; these sort like the dates. */
const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

async function Agenda() {
  const user = await requireUser();
  const now = new Date();
  const [meetings, tasks] = await Promise.all([
    db.meeting.findMany({
      where: { startsAt: { gte: new Date(now.getTime() - 3600_000) }, status: "scheduled" },
      orderBy: { startsAt: "asc" },
      take: 50,
      include: { lead: true, user: true },
    }),
    db.task.findMany({
      where: { doneAt: null, OR: [{ userId: user.id }, { userId: null }] },
      orderBy: { dueAt: "asc" },
      take: 200,
      include: { lead: true },
    }),
  ]);
  // Days in Brasília: the server runs in UTC, where "today" ends at 21h
  const today = dayKey(now);
  const groups = [
    ["Atrasadas", tasks.filter((t) => dayKey(t.dueAt) < today)],
    ["Hoje", tasks.filter((t) => dayKey(t.dueAt) === today)],
    ["Próximas", tasks.filter((t) => dayKey(t.dueAt) > today)],
  ] as const;
  return (
    <div className="grid gap-4 px-6 pb-6 lg:grid-cols-2">
      <Card>
        <h2 className="mb-2 font-bold">Reuniões</h2>
        {meetings.length === 0 && <p className="text-sm text-slate-400">Nenhuma reunião marcada.</p>}
        <ul className="divide-y divide-slate-100">
          {meetings.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="w-28 shrink-0 font-semibold">{fmt(m.startsAt)}</span>
              <Link href={`/leads/${m.leadId}`} className="flex-1 truncate hover:underline">
                {m.lead.name ?? m.lead.phone}
              </Link>
              <span className="text-slate-500">{m.user?.name.split(" ")[0]}</span>
              {m.meetLink && (
                <a href={m.meetLink} target="_blank" className="text-brand underline">
                  Meet
                </a>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2 className="mb-2 font-bold">Minhas tarefas</h2>
        {groups.map(([label, list]) =>
          list.length ? (
            <div key={label} className="mb-3">
              <div className={`text-xs font-bold uppercase ${label === "Atrasadas" ? "text-red-600" : "text-slate-500"}`}>
                {label} ({list.length})
              </div>
              <ul>
                {list.map((t) => (
                  <li key={t.id}>
                    <form action={completeTaskAction.bind(null, t.id)} className="flex items-center gap-2 py-1 text-sm">
                      <button className="h-4 w-4 shrink-0 rounded border border-slate-400" title="Concluir" />
                      <span className="flex-1">
                        {t.title}
                        {t.lead && (
                          <Link href={`/leads/${t.leadId}`} className="ml-1 text-brand hover:underline">
                            · {t.lead.name ?? t.lead.phone}
                          </Link>
                        )}
                      </span>
                      <span className="text-xs text-slate-400">{fmt(t.dueAt)}</span>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          ) : null,
        )}
        {tasks.length === 0 && <p className="text-sm text-slate-400">Nenhuma tarefa aberta.</p>}
      </Card>
    </div>
  );
}
