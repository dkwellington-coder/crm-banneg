"use client";

import Link from "next/link";
import { useOptimistic, useTransition, useState } from "react";
import { Bot, X } from "lucide-react";
import type { StageKind } from "@prisma/client";
import { markAlertSeenAction, moveLeadAction } from "../../actions";
import { Avatar } from "@/components/ui";
import { StageMoveDialog, type StageAsk } from "@/components/StageMoveDialog";
import { closesReferral } from "@/lib/portal-status";
import type { ReopenChoice } from "@/lib/stage-move";

export type KanbanCard = {
  id: string;
  name: string;
  city: string | null;
  temperature: string | null;
  score: number | null;
  sdr: string | null;
  aiActive: boolean;
  owner: string | null;
  lastMessage: string | null;
  failed: boolean;
  lastActivity: string;
  value: number | null;
  // Needs a person: nobody opened it yet, or it is waiting for an answer
  alert: "new" | "waiting" | null;
};

export type KanbanColumn = {
  id: string;
  name: string;
  color: string;
  closed: boolean;
  // LOST asks for the reason before the card moves; WON may ask for the policy, and leaving it what happened to the sale
  kind: StageKind;
  key: string | null;
  total: number;
  value: number;
  leads: KanbanCard[];
};

const brl = (v: number) =>
  v >= 1_000_000
    ? `R$ ${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`
    : v >= 1000
      ? `R$ ${Math.round(v / 1000)} mil`
      : `R$ ${v}`;

function since(iso: string) {
  const h = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

const TEMP: Record<string, string> = {
  quente: "bg-red-100 text-red-700",
  morno: "bg-amber-100 text-amber-700",
  frio: "bg-sky-100 text-sky-700",
};

type Move = { leadId: string; to: string };

/** The board with the card in another column, its count and money too (applying it twice changes nothing). */
function moveCard(state: KanbanColumn[], { leadId, to }: Move) {
  const card = state.flatMap((c) => c.leads).find((l) => l.id === leadId);
  if (!card) return state;
  const worth = card.value ?? 0;
  return state.map((c) => {
    const without = c.leads.filter((l) => l.id !== leadId);
    const had = c.leads.length - without.length;
    if (c.id === to) return { ...c, leads: [card, ...without], total: c.total + 1 - had, value: c.value + (1 - had) * worth };
    return { ...c, leads: without, total: c.total - had, value: c.value - had * worth };
  });
}

export function Kanban({ columns }: { columns: KanbanColumn[] }) {
  const [, start] = useTransition();
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Alerts marked as seen go away at once, before the board reloads
  const [seen, markSeen] = useOptimistic<string[], string>([], (s, id) => [...s, id]);
  const [optimistic, move] = useOptimistic(columns, moveCard);
  // The card waits in the column it was dropped on while the window asks for the reason, the policy or what happened
  // to the sale
  const [held, setHeld] = useState<Move | null>(null);
  const [ask, setAsk] = useState<StageAsk | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cols = held ? moveCard(optimistic, held) : optimistic;

  function askFor(leadId: string, to: string, need: StageAsk["need"]): StageAsk {
    const col = columns.find((c) => c.id === to);
    const lead = columns.flatMap((c) => c.leads).find((l) => l.id === leadId)?.name ?? "";
    return { leadId, lead, to, stage: col?.name ?? "", need, storeSees: !!col && closesReferral(col) };
  }

  function send(leadId: string, to: string, reason?: string, reopen?: ReopenChoice) {
    setHeld(null);
    start(async () => {
      move({ leadId, to });
      try {
        const res = await moveLeadAction(leadId, to, reason, reopen);
        if (res.need) {
          // Another card's window may have opened while this answer was on its way: that one stays, and this card
          // goes back to its column
          const asked = askFor(leadId, to, res.need);
          setAsk((cur) => cur ?? asked);
          setHeld((cur) => cur ?? { leadId, to });
        } else if (res.error) setNotice(res.error);
      } catch {
        setNotice("Não deu para mover o lead. Tente de novo.");
      }
    });
  }

  function drop(to: string, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const leadId = e.dataTransfer.getData("text/lead");
    const col = cols.find((c) => c.id === to);
    if (!leadId || !col || col.leads.some((l) => l.id === leadId)) return;
    setNotice(null);
    if (col.kind === "LOST") {
      setHeld({ leadId, to });
      setAsk(askFor(leadId, to, "reason"));
      return;
    }
    send(leadId, to);
  }

  return (
    <>
      {notice && (
        <div role="alert" className="mx-4 mb-3 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 md:mx-6">
          <span className="min-w-0 flex-1">{notice}</span>
          <button type="button" title="Fechar o aviso" onClick={() => setNotice(null)} className="shrink-0 rounded p-0.5 hover:bg-amber-100">
            <X size={14} />
          </button>
        </div>
      )}
      {ask && (
        <StageMoveDialog
          ask={ask}
          onReason={(reason) => {
            setAsk(null);
            send(ask.leadId, ask.to, reason);
          }}
          onUploaded={() => {
            setAsk(null);
            send(ask.leadId, ask.to);
          }}
          onReopen={(choice) => {
            setAsk(null);
            send(ask.leadId, ask.to, undefined, choice);
          }}
          onCancel={() => {
            setAsk(null);
            setHeld(null);
          }}
        />
      )}
      {/* On the phone one column fills the screen and a swipe goes to the next */}
      <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-4 md:snap-none md:px-6 md:pb-6">
        {cols.map((col) => (
          <section
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(col.id);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => drop(col.id, e)}
            className={`flex shrink-0 flex-col rounded-2xl transition snap-start ${col.closed ? "w-60" : "w-[min(290px,calc(100vw-3rem))]"} ${
              dragOver === col.id ? "bg-brand-soft ring-2 ring-brand" : "bg-sunken"
            }`}
          >
            <header className="px-3 pb-2 pt-3">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.color }} />
                <span className="truncate text-[13px] font-semibold text-slate-800">{col.name}</span>
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-600 shadow-sm">{col.total}</span>
              </div>
              <div className="mt-1.5 h-1 rounded-full" style={{ background: col.color, opacity: 0.35 }} />
              {col.value > 0 && <div className="mt-1.5 text-[11px] font-medium text-slate-500">{brl(col.value)} em negociação</div>}
            </header>
            <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {col.leads.map((card) => {
                const l = seen.includes(card.id) ? { ...card, alert: null } : card;
                return (
                  <Link
                    key={l.id}
                    href={`/leads/${l.id}`}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/lead", l.id)}
                    className={`group block rounded-xl border bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:-translate-y-px hover:shadow-md ${
                      l.alert ? "border-red-400 ring-2 ring-red-500/60" : "border-slate-200/80 hover:border-brand/40"
                    }`}
                  >
                    {l.alert && (
                      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-red-600">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-red-600" />
                        </span>
                        {l.alert === "new" ? "Lead novo" : "Esperando resposta"}
                        <span
                          role="button"
                          tabIndex={0}
                          title="Tirar o aviso deste lead"
                          onClick={(e) => {
                            // Inside the card's link: only the alert goes, the lead does not open
                            e.preventDefault();
                            e.stopPropagation();
                            start(async () => {
                              markSeen(l.id);
                              await markAlertSeenAction(l.id);
                            });
                          }}
                          className="ml-auto cursor-pointer rounded-md px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-700"
                        >
                          Marcar como visto
                        </span>
                      </div>
                    )}
                    <div className="flex items-start gap-2.5">
                      <Avatar name={l.name} size={30} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="truncate text-sm font-semibold text-slate-900">{l.name}</div>
                          <span className="shrink-0 text-[11px] text-slate-400">{since(l.lastActivity)}</span>
                        </div>
                        {(l.city || l.value) && (
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            {l.city && <span className="truncate">{l.city}</span>}
                            {l.value ? <span className="ml-auto shrink-0 font-semibold text-emerald-700">{brl(l.value)}</span> : null}
                          </div>
                        )}
                      </div>
                    </div>
                    {l.lastMessage && (
                      <div className={`mt-2 line-clamp-2 rounded-lg px-2 py-1.5 text-xs ${l.failed ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600"}`}>
                        {l.failed ? "Falhou: " : ""}
                        {l.lastMessage}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {l.temperature && (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${TEMP[l.temperature] ?? ""}`}>
                          {l.temperature}
                        </span>
                      )}
                      {l.score !== null && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{l.score} pts</span>}
                      {l.sdr && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                            l.aiActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"
                          }`}
                        >
                          <Bot size={12} /> {l.sdr}
                          {!l.aiActive && " (pausada)"}
                        </span>
                      )}
                      {l.owner && <span className="ml-auto"><Avatar name={l.owner} size={20} /></span>}
                    </div>
                  </Link>
                );
              })}
              {col.leads.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 py-6 text-center text-xs text-slate-400">Solte um card aqui</div>}
              {col.total > col.leads.length && (
                <div className="py-1 text-center text-[11px] text-slate-500">+{col.total - col.leads.length} (use a busca)</div>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
