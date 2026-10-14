import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Loading, PageHeader, tabCls, relTime } from "@/components/ui";

export default function ConversasPage({ searchParams }: PageProps<"/conversas">) {
  return (
    <>
      <PageHeader title="Conversas" subtitle="WhatsApp de todos os leads. A IA responde sozinha; aqui você vê quem precisa de uma pessoa." />
      <Suspense fallback={<Loading />}>
        <Inbox searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Inbox({ searchParams }: { searchParams: PageProps<"/conversas">["searchParams"] }) {
  await requireUser();
  const sp = await searchParams;
  const filter = typeof sp.f === "string" ? sp.f : "humano";
  // Latest WhatsApp message per lead, newest first
  const latest = await db.$queryRaw<{ leadId: string; createdAt: Date }[]>`
    SELECT DISTINCT ON ("leadId") "leadId", "createdAt" FROM "Message"
    WHERE channel = 'WHATSAPP' ORDER BY "leadId", "createdAt" DESC`;
  latest.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const leads = await db.lead.findMany({
    where: { id: { in: latest.slice(0, 500).map((l) => l.leadId) } },
    include: {
      sdr: { select: { name: true } },
      stage: { select: { name: true } },
      messages: { where: { channel: "WHATSAPP" }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  const order = new Map(latest.map((l, i) => [l.leadId, i]));
  leads.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const needsHuman = (l: (typeof leads)[number]) => l.messages[0]?.direction === "IN" && (!l.sdr || l.aiPaused);
  const failed = (l: (typeof leads)[number]) => l.messages[0]?.status === "FAILED";
  const shown = leads.filter((l) => (filter === "humano" ? needsHuman(l) : filter === "falhas" ? failed(l) : filter === "ia" ? l.sdr && !l.aiPaused : true));
  const tabs = [
    ["humano", `Aguardando uma pessoa (${leads.filter(needsHuman).length})`],
    ["ia", "Com a IA"],
    ["falhas", `Falhas de envio (${leads.filter(failed).length})`],
    ["todas", "Todas"],
  ];
  return (
    <div className="px-6 pb-6">
      <div className="mb-3 flex flex-wrap gap-2">
        {tabs.map(([k, label]) => (
          <Link key={k} href={`/conversas?f=${k}`} className={tabCls(filter === k)}>
            {label}
          </Link>
        ))}
      </div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {shown.length === 0 && <p className="p-4 text-sm text-slate-400">Nada por aqui.</p>}
        {shown.map((l) => {
          const m = l.messages[0];
          return (
            <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{l.name ?? l.phone}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">{l.stage.name}</span>
                  {l.sdr && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${l.aiPaused ? "bg-slate-100 text-slate-500" : "bg-emerald-100 text-emerald-700"}`}>
                      {l.sdr.name}
                      {l.aiPaused ? " pausada" : ""}
                    </span>
                  )}
                </div>
                <div className={`truncate text-sm ${m?.status === "FAILED" ? "text-red-600" : "text-slate-500"}`}>
                  {m?.direction === "OUT" ? `${m.author}: ` : ""}
                  {m?.status === "FAILED" ? `não enviada (${m.error})` : m?.body}
                </div>
              </div>
              <span className="shrink-0 text-xs text-slate-400">{relTime(m?.createdAt)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
