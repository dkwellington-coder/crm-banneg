import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { teamAlerts } from "@/lib/alerts";
import { lastMessages } from "@/lib/inbox";
import { leadSearch } from "@/lib/leads";
import { Search, UserRound, Workflow } from "lucide-react";
import { Loading, Tabs, btnGhostCls, inputCls, tabCls } from "@/components/ui";
import { NewPipelineButton } from "./NewPipelineButton";
import { Kanban, type KanbanColumn } from "./Kanban";
import { NewLeadButton } from "./NewLeadButton";
import { ImportButton } from "./ImportButton";

const PER_COLUMN = 50;

export default function FunilPage({ searchParams }: PageProps<"/funil">) {
  return (
    <div className="flex h-full flex-col">
      <Suspense fallback={<Loading />}>
        <Board searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Board({ searchParams }: { searchParams: PageProps<"/funil">["searchParams"] }) {
  const sp = await searchParams;
  // The alerts below read the clock, which needs the render marked as per-request first
  await connection();
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const mine = sp.meus === "1";
  // Everything that does not depend on the chosen funnel goes in one round
  const [user, pipelines, allStages, alerts, users, sdrs] = await Promise.all([
    requireUser(),
    db.pipeline.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    db.stage.findMany({ orderBy: { position: "asc" } }),
    teamAlerts(),
    db.user.findMany({ select: { id: true, name: true } }),
    db.sdrAgent.findMany({ select: { id: true, name: true } }),
  ]);
  const where: Prisma.LeadWhereInput = {
    ...(q && leadSearch(q)),
    ...(mine && { ownerId: user.id }),
  };
  // Red marks: which funnel has someone new or waiting, and which card
  const alertBy = new Map(alerts.items.map((a) => [a.leadId, a.kind]));
  const alertsIn = (pipelineId: string) => alerts.items.filter((a) => a.pipelineId === pipelineId).length;
  const pipeline = pipelines.find((p) => p.id === sp.f) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  if (!pipeline) return <p className="p-6 text-sm text-slate-500">Nenhum funil ainda. Rode o seed (npm run db:seed).</p>;
  const stages = allStages.filter((s) => s.pipelineId === pipeline.id);
  const [counts, columns] = await Promise.all([
    db.lead.groupBy({ by: ["stageId"], where: { ...where, pipelineId: pipeline.id }, _count: true, _sum: { value: true } }),
    Promise.all(stages.map((s) => db.lead.findMany({ where: { ...where, stageId: s.id }, orderBy: { updatedAt: "desc" }, take: PER_COLUMN }))),
  ]);
  const last = await lastMessages(columns.flat().map((l) => l.id));
  const nameOf = new Map([...users, ...sdrs].map((x) => [x.id, x.name]));
  const countBy = new Map(counts.map((c) => [c.stageId, c._count]));
  const valueBy = new Map(counts.map((c) => [c.stageId, c._sum.value ?? 0]));
  const link = (extra: Record<string, string | null>) => {
    const params = new URLSearchParams({ f: pipeline.id, ...(q && { q }), ...(mine && { meus: "1" }) });
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    return `/funil?${params}`;
  };
  const data: KanbanColumn[] = stages.map((s, i) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    closed: s.kind !== "OPEN",
    total: countBy.get(s.id) ?? 0,
    value: valueBy.get(s.id) ?? 0,
    leads: columns[i].map((l) => {
      const m = last.get(l.id);
      return {
        id: l.id,
        name: l.name ?? l.phone ?? l.email ?? "Sem nome",
        city: [l.city, l.state].filter(Boolean).join("/") || null,
        temperature: l.temperature,
        score: l.score,
        sdr: (l.sdrId && nameOf.get(l.sdrId)) || null,
        aiActive: !!l.sdrId && !l.aiPaused,
        owner: (l.ownerId && nameOf.get(l.ownerId)) || null,
        lastMessage: m ? `${m.direction === "IN" ? "" : "Você: "}${m.body}` : null,
        failed: m?.status === "FAILED",
        lastActivity: (l.lastInboundAt ?? l.lastContactAt ?? l.createdAt).toISOString(),
        value: l.value,
        alert: alertBy.get(l.id) ?? null,
      };
    }),
  }));
  const total = counts.reduce((n, c) => n + c._count, 0);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 px-6 pb-3 pt-6">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight text-slate-900">{pipeline.name}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {total} {total === 1 ? "lead" : "leads"} neste funil · arraste o card para mudar de etapa
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/funis/${pipeline.id}`} className={btnGhostCls}>
            <Workflow size={16} /> Editar funil e automações
          </Link>
          <ImportButton pipelineId={pipeline.id} />
          <NewLeadButton pipelineId={pipeline.id} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <Tabs>
          {pipelines.map((p) => (
            <Link key={p.id} href={link({ f: p.id })} className={tabCls(p.id === pipeline.id)}>
              {p.name}
              {alertsIn(p.id) > 0 && (
                <span
                  title="Leads novos ou esperando resposta neste funil"
                  className="ml-1 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                >
                  {alertsIn(p.id)}
                </span>
              )}
            </Link>
          ))}
          <NewPipelineButton />
        </Tabs>
        <form className="ml-auto flex gap-2">
          <input type="hidden" name="f" value={pipeline.id} />
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input name="q" defaultValue={q} placeholder="Buscar nome, telefone, cidade" className={`${inputCls} w-72! pl-9`} />
          </div>
          {mine && <input type="hidden" name="meus" value="1" />}
        </form>
        <Link href={link({ meus: mine ? null : "1" })} className={tabCls(mine)}>
          <UserRound size={16} /> Só os meus
        </Link>
      </div>
      <Kanban columns={data} />
    </>
  );
}
