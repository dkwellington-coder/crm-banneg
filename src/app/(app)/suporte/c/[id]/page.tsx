import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, FileText } from "lucide-react";
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
                  {m.mediaMime ? (
                    <>
                      <MessageFile m={m} />
                      {textOf(m.body) && <div className="mt-1 whitespace-pre-wrap break-words">{textOf(m.body)}</div>}
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap break-words">{m.body}</div>
                  )}
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

/** The caption without the "[Imagem]" label: the file itself is shown above it. */
const textOf = (body: string) => body.replace(/^\[[^\]]+\]\s*/, "").trim();

const sizeLabel = (bytes: number | null) =>
  !bytes ? "" : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;

type FileMessage = { id: string; kind: string | null; mediaMime: string | null; mediaName: string | null; mediaSize: number | null; mediaStatus: string | null; mediaError: string | null };

/** Photo, audio and video play right in the conversation; any other file (PDF, document) opens or downloads. */
function MessageFile({ m }: { m: FileMessage }) {
  if (m.mediaStatus === "baixando") return <div className="text-xs italic text-slate-500">Baixando o arquivo do WhatsApp…</div>;
  if (m.mediaStatus === "erro")
    return <div className="text-xs font-medium text-amber-700">O WhatsApp não entregou este arquivo{m.mediaError ? ` (${m.mediaError})` : ""}.</div>;
  const src = `/api/suporte/midia/${m.id}`;
  const mime = m.mediaMime ?? "";
  const download = (
    <a href={`${src}?baixar`} className="inline-flex items-center gap-1 text-xs font-medium text-brand underline">
      <Download size={12} /> Baixar
    </a>
  );
  if (mime.startsWith("image/"))
    return (
      <div className="space-y-1">
        <a href={src} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={m.mediaName ?? "Imagem"} loading="lazy" className="max-h-72 rounded-lg object-contain" />
        </a>
        {download}
      </div>
    );
  if (mime.startsWith("audio/"))
    return (
      <div className="space-y-1">
        <audio controls preload="none" src={src} className="w-64 max-w-full" />
        {download}
      </div>
    );
  if (mime.startsWith("video/"))
    return (
      <div className="space-y-1">
        <video controls preload="metadata" src={src} className="max-h-72 rounded-lg" />
        {download}
      </div>
    );
  return (
    <a href={src} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg bg-white/70 p-2 ring-1 ring-slate-200 hover:bg-white">
      <FileText size={22} className="shrink-0 text-gold" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{m.mediaName || "Documento"}</span>
        <span className="block text-xs text-slate-500">
          {[mime === "application/pdf" ? "PDF" : mime.split("/")[1]?.toUpperCase(), sizeLabel(m.mediaSize)].filter(Boolean).join(" · ")}
        </span>
      </span>
    </a>
  );
}
