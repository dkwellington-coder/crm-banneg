"use client";

import Link from "next/link";
import { useOptimistic, useTransition, useState } from "react";
import { moveLeadAction } from "../../actions";

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
};

export type KanbanColumn = { id: string; name: string; color: string; closed: boolean; total: number; leads: KanbanCard[] };

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
          className={`flex shrink-0 flex-col rounded-xl ${col.closed ? "w-56" : "w-72"} ${
            dragOver === col.id ? "bg-brand-soft ring-2 ring-brand" : "bg-slate-100"
          }`}
        >
          <header className="border-t-4 px-3 pb-2 pt-3" style={{ borderColor: col.color, borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
            <div className="text-xs font-bold uppercase tracking-wide text-slate-700">{col.name}</div>
            <div className="text-xs text-slate-500">{col.total} leads</div>
          </header>
          <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {col.leads.map((l) => (
              <Link
                key={l.id}
                href={`/leads/${l.id}`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/lead", l.id)}
                className="block rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:border-brand"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate text-sm font-semibold">{l.name}</div>
                  <span className="shrink-0 text-[11px] text-slate-400">{since(l.lastActivity)}</span>
                </div>
                {l.city && <div className="text-xs text-slate-500">{l.city}</div>}
                {l.lastMessage && (
                  <div className={`mt-1 line-clamp-2 text-xs ${l.failed ? "text-red-600" : "text-slate-600"}`}>
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
                  {l.score !== null && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px]">score {l.score}</span>}
                  {l.sdr && (
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${l.aiActive ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                      {l.aiActive ? "●" : "○"} {l.sdr}
                    </span>
                  )}
                  {l.owner && <span className="ml-auto text-[11px] text-slate-500">{l.owner.split(" ")[0]}</span>}
                </div>
              </Link>
            ))}
            {col.total > col.leads.length && (
              <div className="py-1 text-center text-[11px] text-slate-500">+{col.total - col.leads.length} (use a busca)</div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
