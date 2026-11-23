import Link from "next/link";
import { Tabs, tabCls } from "@/components/ui";
import { duration } from "@/lib/support-metrics";

/** Conversas / Equipe / Números: Equipe only for who monitors, Números only for the owner. */
export function SupportTabs({ active, monitor, owner, waiting }: { active: "conversas" | "equipe" | "numeros"; monitor: boolean; owner: boolean; waiting?: number }) {
  const tabs = [
    { key: "conversas", href: "/suporte", label: `Conversas${waiting ? ` (${waiting})` : ""}`, show: true },
    { key: "equipe", href: "/suporte/equipe", label: "Equipe", show: monitor },
    { key: "numeros", href: "/suporte/numeros", label: "Números e atendentes", show: owner },
  ].filter((t) => t.show);
  if (tabs.length < 2) return null;
  return (
    <div className="mb-3">
      <Tabs>
        {tabs.map((t) => (
          <Link key={t.key} href={t.href} className={tabCls(active === t.key)}>
            {t.label}
          </Link>
        ))}
      </Tabs>
    </div>
  );
}

/** "esperando há 12 min": green up to 5 min, amber up to 15, red after. */
export function WaitBadge({ since, now }: { since: Date; now: number }) {
  const ms = now - since.getTime();
  const cls = ms <= 5 * 60_000 ? "bg-emerald-100 text-emerald-700" : ms <= 15 * 60_000 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-700";
  return <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>esperando há {duration(ms)}</span>;
}

/** Green dot = connected, red = anything else. */
export function StatusDot({ status }: { status: string | null }) {
  const on = status === "connected";
  const error = status?.startsWith("erro") ? status.replace(/^erro:?\s*/, "") || null : null;
  // "connecting: <why>": our gateway keeps trying, and says why WhatsApp closed it the last time
  const why = !error && status?.includes(": ") ? status.slice(status.indexOf(": ") + 2) : null;
  const base = status?.split(": ")[0];
  const label = on
    ? "Conectado"
    : error !== null || status === "erro"
      ? "Servidor do WhatsApp não respondeu"
      : base === "qrcode" || base === "aguardando QR"
        ? "Esperando o QR code"
        : base === "connecting"
          ? `Tentando reconectar${why ? `: ${why}` : ""}`
          : status
            ? `Desconectado${why ? `: ${why}` : ": leia o QR code de novo"}`
            : "Ainda não verificado";
  return (
    <span title={error ?? why ?? undefined} className={`inline-flex items-center gap-1.5 text-xs font-medium ${on ? "text-emerald-700" : "text-red-700"}`}>
      <span className={`size-2 rounded-full ${on ? "bg-emerald-500" : "bg-red-500"}`} />
      {label}
    </span>
  );
}

export function phoneLabel(phone: string | null) {
  if (!phone) return "";
  const d = phone.replace(/\D/g, "");
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
}
