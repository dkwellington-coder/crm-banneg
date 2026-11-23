import { Suspense } from "react";
import Link from "next/link";
import { Headset } from "lucide-react";
import { db } from "@/lib/db";
import { inboxVersion, supportViewer } from "@/lib/support-access";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Avatar, Card, Loading, PageHeader, Tabs, tabCls, relTime } from "@/components/ui";
import { phoneLabel, StatusDot, SupportTabs, WaitBadge } from "./parts";

export default function SuportePage({ searchParams }: PageProps<"/suporte">) {
  return (
    <>
      <PageHeader title="Suporte" subtitle="WhatsApp dos números de suporte. Responda por aqui ou pelo celular: tudo conta no acompanhamento da equipe." />
      <Suspense fallback={<Loading />}>
        <Inbox searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Inbox({ searchParams }: { searchParams: PageProps<"/suporte">["searchParams"] }) {
  const [viewer, sp] = await Promise.all([supportViewer(), searchParams]);
  const filter = sp.f === "todas" ? "todas" : "esperando";
  const numberId = typeof sp.n === "string" ? sp.n : null;
  const numbers = await db.supportNumber.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, status: true, statusAt: true, attendants: { select: { id: true } } },
  });
  const mine = viewer.monitor || !viewer.attendant ? numbers : numbers.filter((n) => n.attendants.some((a) => a.id === viewer.attendant!.id));
  const where = { ...viewer.chatWhere, ...(numberId && { numberId }) };
  const [chats, { version, waiting }] = await Promise.all([
    db.supportChat.findMany({
      where: { ...where, ...(filter === "esperando" && { waitingSince: { not: null } }) },
      orderBy: filter === "esperando" ? { waitingSince: "asc" } : { lastMessageAt: "desc" },
      take: 300,
      include: { number: { select: { name: true } } },
    }),
    inboxVersion(viewer.chatWhere),
  ]);
  const now = new Date().getTime();
  const link = (f: string, n: string | null) => `/suporte?f=${f}${n ? `&n=${n}` : ""}`;

  return (
    <div className="px-4 pb-6 md:px-6">
      <LiveRefresh src="/api/suporte/versao" version={version} />
      <SupportTabs active="conversas" monitor={viewer.monitor} owner={viewer.owner} waiting={waiting} />
      {mine.some((n) => n.status !== "connected") && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="font-semibold">Número de suporte fora do ar: as mensagens dele não estão chegando ao CRM.</div>
          <ul className="mt-1 space-y-0.5">
            {mine
              .filter((n) => n.status !== "connected")
              .map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.name}</span>
                  <StatusDot status={n.status} />
                  {n.statusAt && <span className="text-xs opacity-70">verificado {relTime(n.statusAt)}</span>}
                </li>
              ))}
          </ul>
          {viewer.owner && (
            <Link href="/suporte/numeros" className="mt-1 inline-block font-medium underline">
              Abrir Números e atendentes
            </Link>
          )}
        </div>
      )}
      {mine.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <Headset className="text-gold" size={32} />
          <div className="font-semibold">Nenhum número de suporte ligado ainda</div>
          <p className="max-w-md text-sm text-slate-500">
            {viewer.owner ? (
              <>
                Conecte o primeiro em{" "}
                <Link href="/suporte/numeros" className="font-medium text-brand underline">
                  Números e atendentes
                </Link>{" "}
                lendo o QR code com o celular do número.
              </>
            ) : (
              "Peça ao Wellington para ligar o seu número de suporte ao CRM."
            )}
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tabs>
              <Link href={link("esperando", numberId)} className={tabCls(filter === "esperando")}>
                Esperando resposta ({waiting})
              </Link>
              <Link href={link("todas", numberId)} className={tabCls(filter === "todas")}>
                Todas
              </Link>
            </Tabs>
            {mine.length > 1 && (
              <Tabs>
                <Link href={link(filter, null)} className={tabCls(!numberId)}>
                  Todos os números
                </Link>
                {mine.map((n) => (
                  <Link key={n.id} href={link(filter, n.id)} className={tabCls(numberId === n.id)}>
                    {n.name}
                  </Link>
                ))}
              </Tabs>
            )}
          </div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {chats.length === 0 && (
              <p className="p-4 text-sm text-slate-400">{filter === "esperando" ? "Ninguém esperando resposta. 👏" : "Nenhuma conversa ainda."}</p>
            )}
            {chats.map((c) => (
              <Link key={c.id} href={`/suporte/c/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                <Avatar name={c.name ?? c.phone ?? "?"} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-semibold">{c.name || phoneLabel(c.phone) || "Contato"}</span>
                    {mine.length > 1 && <span className="shrink-0 whitespace-nowrap rounded-full bg-gold-soft px-2 py-0.5 text-[11px] text-gold-ink max-sm:hidden">{c.number.name}</span>}
                  </div>
                  <div className="truncate text-sm text-slate-500">
                    {c.lastFromMe ? "Você: " : ""}
                    {c.lastBody}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {c.waitingSince ? <WaitBadge since={c.waitingSince} now={now} /> : null}
                  <span className="text-xs text-slate-400">{relTime(c.lastMessageAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
