"use client";

import Link from "next/link";
import { useOptimistic, useTransition, useState } from "react";
import { Bot } from "lucide-react";
import { moveLeadAction } from "../../actions";
import { Avatar } from "@/components/ui";

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
};

export type KanbanColumn = {
  id: string;
  name: string;
  color: string;
  closed: boolean;
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

export function Kanban({ columns }: { columns: KanbanColumn[] }) {
  const [, start] = useTransition();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [cols, move] = useOptimistic(columns, (state, { leadId, to }: { leadId: string; to: string }) => {
    const card = state.flatMap((c) => c.leads).find((l) => l.id === leadId);
    if (!card) return state;
    return state.map((c) => {
      const without = c.leads.filter((l) => l.id !== leadId);
      if (c.id === to) return { ...c, leads: [card, ...without], total: c.total + (c.leads.length === without.length ? 1 : 0) };
      return { ...c, leads: without, total: c.total - (c.leads.length - without.length) };
    });
  });

  function drop(to: string, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const leadId = e.dataTransfer.getData("text/lead");
    if (!leadId) return;
    start(async () => {
      move({ leadId, to });
      await moveLeadAction(leadId, to);
    });
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-6 pb-6">
      {cols.map((col) => (
        <section
          key={col.id}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(col.id);
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => drop(col.id, e)}
          className={`flex shrink-0 flex-col rounded-2xl transition ${col.closed ? "w-60" : "w-[290px]"} ${
            dragOver === col.id ? "bg-brand-soft ring-2 ring-brand" : "bg-slate-200/50"
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
            {col.leads.map((l) => (
              <Link
                key={l.id}
                href={`/leads/${l.id}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/lead", l.id)}
                className="group block rounded-xl border border-slate-200/80 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.05)] transition hover:-translate-y-px hover:border-brand/40 hover:shadow-md"
              >
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
            ))}
            {col.leads.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 py-6 text-center text-xs text-slate-400">Solte um card aqui</div>}
            {col.total > col.leads.length && (
              <div className="py-1 text-center text-[11px] text-slate-500">+{col.total - col.leads.length} (use a busca)</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
