import { Suspense } from "react";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
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
  const user = await requireUser();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const mine = sp.meus === "1";
  const where: Prisma.LeadWhereInput = {
    ...(q && {
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { phone: { contains: q.replace(/\D/g, "") || q } },
        { email: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } },
      ],
    }),
    ...(mine && { ownerId: user.id }),
  };
  const pipelines = await db.pipeline.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  const pipeline = pipelines.find((p) => p.id === sp.f) ?? pipelines.find((p) => p.isDefault) ?? pipelines[0];
  if (!pipeline) return <p className="p-6 text-sm text-slate-500">Nenhum funil ainda. Rode o seed (npm run db:seed).</p>;
  const stages = await db.stage.findMany({ where: { pipelineId: pipeline.id }, orderBy: { position: "asc" } });
  const [counts, columns] = await Promise.all([
    db.lead.groupBy({ by: ["stageId"], where: { ...where, pipelineId: pipeline.id }, _count: true, _sum: { value: true } }),
    Promise.all(
      stages.map((s) =>
        db.lead.findMany({
          where: { ...where, stageId: s.id },
          orderBy: { updatedAt: "desc" },
          take: PER_COLUMN,
          include: {
            sdr: { select: { name: true } },
            owner: { select: { name: true } },
            messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, direction: true, status: true } },
          },
        }),
      ),
    ),
  ]);
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
    leads: columns[i].map((l) => ({
      id: l.id,
      name: l.name ?? l.phone ?? l.email ?? "Sem nome",
      city: [l.city, l.state].filter(Boolean).join("/") || null,
      temperature: l.temperature,
      score: l.score,
      sdr: l.sdr?.name ?? null,
      aiActive: !!l.sdr && !l.aiPaused,
      owner: l.owner?.name ?? null,
      lastMessage: l.messages[0] ? `${l.messages[0].direction === "IN" ? "" : "Você: "}${l.messages[0].body}` : null,
      failed: l.messages[0]?.status === "FAILED",
      lastActivity: (l.lastInboundAt ?? l.lastContactAt ?? l.createdAt).toISOString(),
      value: l.value,
    })),
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
            </Link>
          ))}
          <NewPipelineButton />
        </Tabs>
        <form className="ml-auto flex gap-2">
          <input type="hidden" name="f" value={pipeline.id} />
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input name="q" defaultValue={q} placeholder="Buscar nome, telefone, cidade" className={`${inputCls} w-72 pl-9`} />
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
