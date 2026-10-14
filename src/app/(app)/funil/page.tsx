import { Suspense } from "react";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Loading, PageHeader, btnGhostCls, inputCls } from "@/components/ui";
import { Kanban, type KanbanColumn } from "./Kanban";
import { NewLeadButton } from "./NewLeadButton";
import { ImportButton } from "./ImportButton";

const PER_COLUMN = 50;

export default function FunilPage({ searchParams }: PageProps<"/funil">) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Funil" subtitle="Arraste o card para mudar de etapa. Clique para abrir o lead com a conversa." />
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
  const stages = await db.stage.findMany({ orderBy: { position: "asc" } });
  const [counts, columns] = await Promise.all([
    db.lead.groupBy({ by: ["stageId"], where, _count: true }),
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
  const data: KanbanColumn[] = stages.map((s, i) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    closed: s.kind !== "OPEN",
    total: countBy.get(s.id) ?? 0,
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
    })),
  }));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
        <form className="flex flex-1 gap-2">
          <input name="q" defaultValue={q} placeholder="Buscar nome, telefone, e-mail ou cidade" className={`${inputCls} max-w-sm`} />
          {mine && <input type="hidden" name="meus" value="1" />}
        </form>
        <Link href={mine ? "/funil" : "/funil?meus=1"} className={btnGhostCls}>
          {mine ? "Todos os leads" : "Só os meus"}
        </Link>
        <ImportButton />
        <NewLeadButton />
      </div>
      <Kanban columns={data} />
    </>
  );
}
