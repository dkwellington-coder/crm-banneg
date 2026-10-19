import { Suspense } from "react";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { latestConversations } from "@/lib/inbox";
import { Avatar, Loading, PageHeader, Tabs, tabCls, relTime } from "@/components/ui";

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
  // Latest WhatsApp message per lead, newest first
  const [, sp, latest] = await Promise.all([requireUser(), searchParams, latestConversations(500)]);
  const filter = typeof sp.f === "string" ? sp.f : "humano";
  const found = await db.lead.findMany({
    where: { id: { in: latest.map((m) => m.leadId) } },
    include: { sdr: { select: { name: true } }, stage: { select: { name: true } } },
  });
  const byId = new Map(found.map((l) => [l.id, l]));
  const leads = latest.flatMap((m) => {
    const l = byId.get(m.leadId);
    return l ? [{ ...l, messages: [m] }] : [];
  });
  const needsHuman = (l: (typeof leads)[number]) =>
    l.messages[0]?.direction === "IN" && (!l.sdr || l.aiPaused) && (!l.alertsClearedAt || l.messages[0].createdAt > l.alertsClearedAt);
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
      <div className="mb-3">
        <Tabs>
          {tabs.map(([k, label]) => (
            <Link key={k} href={`/conversas?f=${k}`} className={tabCls(filter === k)}>
              {label}
            </Link>
          ))}
        </Tabs>
      </div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        {shown.length === 0 && <p className="p-4 text-sm text-slate-400">Nada por aqui.</p>}
        {shown.map((l) => {
          const m = l.messages[0];
          return (
            <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              <Avatar name={l.name ?? l.phone ?? "?"} size={38} />
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
