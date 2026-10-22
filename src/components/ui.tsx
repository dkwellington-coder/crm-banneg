import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-6 pb-4 pt-6">
      <div>
        <h1 className="text-[28px] font-normal tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${className}`}>{children}</div>;
}

const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#ea580c", "#059669", "#0891b2", "#4f46e5", "#ca8a04"];

/** Colored initials, the same color for the same name everywhere. */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts.at(-1)![0] : "")).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.38, color: "#ffffff", background: AVATAR_COLORS[h % AVATAR_COLORS.length] }}
    >
      {initials}
    </span>
  );
}

export function Loading() {
  return <div className="p-6 text-sm text-slate-400">Carregando…</div>;
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15";
export const btnCls =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-dark disabled:opacity-50";
export const btnGhostCls =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50";

export function tabCls(active: boolean) {
  return `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
    active ? "bg-white text-brand shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"
  }`;
}

/** Wraps tabCls links in a segmented control. */
export function Tabs({ children }: { children: ReactNode }) {
  return <div className="inline-flex flex-wrap gap-1 rounded-xl bg-sunken p-1">{children}</div>;
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
