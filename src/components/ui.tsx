import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-6 pb-4 pt-6">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`}>{children}</div>;
}

export function Loading() {
  return <div className="p-6 text-sm text-slate-400">Carregando…</div>;
}

export const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand";
export const btnCls = "rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50";
export const btnGhostCls = "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium hover:bg-slate-50";

export function tabCls(active: boolean) {
  return `rounded-lg border px-3 py-2 text-sm font-medium ${
    active ? "border-brand bg-brand text-white" : "border-slate-300 bg-white hover:bg-slate-50"
  }`;
}

export function relTime(d: Date | null | undefined) {
  if (!d) return "nunca";
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60_000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function fmt(d: Date) {
  return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export const STATUS_LABEL: Record<string, string> = {
  NEW: "Novo",
  AI_QUALIFYING: "IA qualificando",
  QUALIFIED: "Qualificado",
  MEETING_BOOKED: "Reunião marcada",
  HANDED_OFF: "Com o gerente",
  NURTURING: "Nutrição",
  DISQUALIFIED: "Descartado",
  WON: "Ganho",
  LOST: "Perdido",
};

export function TempBadge({ t }: { t: string | null }) {
  if (!t) return null;
  const cls = t === "quente" ? "bg-red-100 text-red-700" : t === "morno" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${cls}`}>{t}</span>;
}
