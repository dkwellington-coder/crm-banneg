import Link from "next/link";
import { Suspense } from "react";
import { Bell, Check, CornerDownLeft, X } from "lucide-react";
import { requireOwnerPage } from "@/lib/access";
import { db } from "@/lib/db";
import { getSecretary } from "@/lib/secretary";
import { taskGroup, type TaskGroup as Group, TASK_GROUPS as GROUPS } from "@/lib/task-groups";
import { Card, Loading, PageHeader, Tabs, btnCls, inputCls, relTime, tabCls } from "@/components/ui";
import { addTaskAction, setTaskStatusAction } from "../secretaria/actions";
import type { SecretaryTask } from "@prisma/client";

/**
 * Tarefas (Wellington, 2026-11-26): the tasks Jessica keeps, as a short checklist. Grouped by when they are due
 * (late, today, tomorrow, next days, later, no date), filtered by when and by person; one tap marks it done.
 */
type Search = { ver?: string; quem?: string };

export default function TarefasPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <>
      <PageHeader title="Tarefas" subtitle="Tudo o que a Jessica anotou e cobra, em uma lista." />
      <Suspense fallback={<Loading />}>
        <Tarefas searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const VIEWS = [
  { key: "todas", label: "Todas" },
  { key: "atrasadas", label: "Atrasadas" },
  { key: "hoje", label: "Hoje" },
  { key: "semana", label: "7 dias" },
] as const;
type View = (typeof VIEWS)[number]["key"];

const VIEW_GROUPS: Record<View, readonly Group[]> = {
  todas: GROUPS,
  atrasadas: ["Atrasadas"],
  hoje: ["Atrasadas", "Hoje"],
  semana: ["Atrasadas", "Hoje", "Amanhã", "Próximos dias"],
};

function when(d: Date, group: Group) {
  const time = d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  if (group === "Hoje" || group === "Amanhã") return time;
  const day = d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit" });
  return `${day} ${time}`;
}

async function Tarefas({ searchParams }: { searchParams: Promise<Search> }) {
  await requireOwnerPage();
  const q = await searchParams;
  const view: View = VIEWS.some((v) => v.key === q.ver) ? (q.ver as View) : "todas";
  const who = q.quem ?? "";
  const [open, done, s] = await Promise.all([
    db.secretaryTask.findMany({ where: { status: "aberta" }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], take: 300 }),
    db.secretaryTask.findMany({ where: { status: "feita" }, orderBy: { doneAt: "desc" }, take: 10 }),
    getSecretary(),
  ]);
  const now = new Date();
  const people = [...new Set(open.map((t) => t.assignee).filter((a): a is string => !!a))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const mine = open.filter((t) => !who || (who === "-" ? !t.assignee : t.assignee === who));
  const byGroup = new Map<Group, SecretaryTask[]>();
  for (const t of mine) {
    const g = taskGroup(t.dueAt, now);
    byGroup.set(g, [...(byGroup.get(g) ?? []), t]);
  }
  const count = (v: View) => mine.filter((t) => VIEW_GROUPS[v].includes(taskGroup(t.dueAt, now))).length;
  const href = (p: Search) => {
    const u = new URLSearchParams();
    const ver = p.ver ?? view;
    const quem = p.quem ?? who;
    if (ver !== "todas") u.set("ver", ver);
    if (quem) u.set("quem", quem);
    return `/tarefas${u.size ? `?${u}` : ""}`;
  };
  const shown = VIEW_GROUPS[view].filter((g) => byGroup.get(g)?.length);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 pb-8 md:px-6">
      <Tabs>
        {VIEWS.map((v) => (
          <Link key={v.key} href={href({ ver: v.key })} className={tabCls(view === v.key)}>
            {v.label}
            <span className={`rounded-full px-1.5 text-[11px] font-semibold ${v.key === "atrasadas" && count(v.key) ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
              {count(v.key)}
            </span>
          </Link>
        ))}
      </Tabs>

      {people.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {[{ key: "", label: "Todos" }, ...people.map((p) => ({ key: p, label: p })), { key: "-", label: "Sem responsável" }].map((p) => (
            <Link
              key={p.key || "all"}
              href={href({ quem: p.key })}
              className={`rounded-full border px-2.5 py-1 font-medium transition ${who === p.key ? "border-brand bg-brand text-white" : "border-slate-300 text-slate-600 hover:border-brand"}`}
            >
              {p.label}
            </Link>
          ))}
        </div>
      )}

      <Card className="space-y-1 p-0!">
        <form action={addTaskAction} className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <input name="title" required placeholder="+ Nova tarefa" className={`${inputCls} min-w-0 flex-[2_1_14rem]`} aria-label="Nova tarefa" />
          <input name="assignee" placeholder="Quem" list="tarefas-people" defaultValue={who && who !== "-" ? who : ""} className={`${inputCls} flex-[1_1_7rem]`} aria-label="Responsável" />
          <input name="dueAt" type="datetime-local" className={`${inputCls} flex-[1_1_11rem]`} aria-label="Prazo" />
          <button className={btnCls}>Anotar</button>
          <datalist id="tarefas-people">
            {s.members.map((m) => (
              <option key={m.name} value={m.name} />
            ))}
          </datalist>
        </form>

        {shown.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">Nada por aqui. 🎉</p>
        ) : (
          shown.map((g) => (
            <section key={g} className="px-1 pb-1">
              <h2 className={`px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide ${g === "Atrasadas" ? "text-red-600" : "text-slate-400"}`}>
                {g} · {byGroup.get(g)!.length}
              </h2>
              <ul>
                {byGroup.get(g)!.map((t) => (
                  <li key={t.id} className="group flex items-start gap-2.5 rounded-lg px-3 py-2 hover:bg-slate-50">
                    <form action={setTaskStatusAction.bind(null, t.id, "feita")} className="pt-0.5">
                      <button
                        title="Marcar como feita"
                        aria-label={`Marcar "${t.title}" como feita`}
                        className="flex size-5 items-center justify-center rounded-full border-2 border-slate-300 text-transparent transition hover:border-emerald-500 hover:text-emerald-500"
                      >
                        <Check size={12} strokeWidth={3} />
                      </button>
                    </form>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug text-slate-800">
                        {t.kind === "retorno" && <CornerDownLeft size={13} className="mr-1 inline text-sky-600" aria-label="Retorno" />}
                        {t.kind === "lembrete" && <Bell size={13} className="mr-1 inline text-amber-600" aria-label="Lembrete" />}
                        {t.title}
                      </p>
                      <p className="text-xs text-slate-500">
                        {[t.assignee, t.dueAt && when(t.dueAt, g), t.nudges > 0 && `cobrada ${t.nudges}x`].filter(Boolean).join(" · ") || "sem prazo"}
                      </p>
                    </div>
                    <form action={setTaskStatusAction.bind(null, t.id, "cancelada")}>
                      <button title="Cancelar tarefa" aria-label={`Cancelar "${t.title}"`} className="p-1 text-slate-300 transition hover:text-red-600">
                        <X size={14} />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </Card>

      {done.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500">Feitas por último ({done.length})</summary>
          <ul className="mt-2 space-y-1.5 text-slate-500">
            {done.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2">
                <span className="line-through decoration-slate-300">
                  {t.title}
                  {t.doneBy && ` · ${t.doneBy}`} {t.doneAt && `· ${relTime(t.doneAt)}`}
                </span>
                <form action={setTaskStatusAction.bind(null, t.id, "aberta")}>
                  <button className="text-xs underline">Reabrir</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
