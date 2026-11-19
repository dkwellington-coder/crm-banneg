import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import { supportViewer } from "@/lib/support-access";
import { supportChatVersion } from "@/lib/support";
import { LiveRefresh } from "@/components/LiveRefresh";
import { Avatar, Loading, fmt } from "@/components/ui";
import { phoneLabel, WaitBadge } from "../../parts";
import { SupportComposer } from "./SupportComposer";

export default function SupportChatPage({ params }: PageProps<"/suporte/c/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Chat params={params} />
    </Suspense>
  );
}

const VIA: Record<string, string> = { crm: "pelo CRM", phone: "pelo celular", api: "automática" };

async function Chat({ params }: { params: PageProps<"/suporte/c/[id]">["params"] }) {
  const [{ id }, viewer] = await Promise.all([params, supportViewer()]);
  const chat = await db.supportChat.findFirst({
    where: { id, ...viewer.chatWhere },
    include: { number: { select: { name: true, phone: true } }, messages: { orderBy: { createdAt: "desc" }, take: 300 } },
  });
  if (!chat) notFound();
  const messages = chat.messages.reverse();
  const version = await supportChatVersion(chat.id);
  const title = chat.name || phoneLabel(chat.phone) || "Contato";
  return (
    <div className="flex h-full flex-col bg-slate-50">
      <LiveRefresh src={`/api/suporte/${chat.id}/versao`} version={version} />
      <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 py-2 md:px-5 md:py-3">
        <Link href="/suporte" aria-label="Voltar para o Suporte" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
          <ArrowLeft size={18} />
        </Link>
        <Avatar name={title} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{title}</div>
          <div className="truncate text-xs text-slate-500">
            {phoneLabel(chat.phone)}
            {chat.phone ? " · " : ""}
            {chat.number.name}
          </div>
        </div>
        {chat.waitingSince && <WaitBadge since={chat.waitingSince} now={new Date().getTime()} />}
        {chat.phone && (
          <a href={`https://wa.me/${chat.phone}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand underline max-sm:hidden">
            Abrir no WhatsApp
          </a>
        )}
      </div>
      {/* Reversed column: opens at the end, on the newest message */}
      <div className="flex flex-1 flex-col-reverse overflow-y-auto p-4">
        <div className="mx-auto w-full max-w-3xl space-y-2">
          {messages.length === 0 && <p className="text-sm text-slate-400">Nenhuma mensagem ainda.</p>}
          {messages.map((m) => {
            const out = m.direction === "OUT";
            const cls = m.error ? "bg-red-50 ring-red-200" : out ? (m.via === "api" ? "bg-slate-100 ring-slate-200" : "bg-brand-soft ring-blue-200") : "bg-white ring-slate-200";
            return (
              <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ring-1 ${cls}`}>
                  {out && (
                    <div className="mb-1 text-[11px] text-slate-500">
                      {m.author ?? chat.number.name} · {VIA[m.via] ?? m.via}
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  <div className="mt-1 text-right text-[11px] text-slate-400">{fmt(m.createdAt)}</div>
                  {m.error && <div className="mt-1 text-xs font-medium text-red-700">{m.error}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="border-t border-slate-200 bg-white p-3">
        <div className="mx-auto max-w-3xl">
          <div className="mb-2 text-xs text-slate-500">Sai pelo número {chat.number.name}, com o seu nome no histórico. Responder pelo celular também conta.</div>
          <SupportComposer chatId={chat.id} />
        </div>
      </div>
    </div>
  );
}
