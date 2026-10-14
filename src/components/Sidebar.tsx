"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Columns3, LayoutDashboard, MessageCircle, Settings, Target, type LucideIcon } from "lucide-react";

type Item = { href: string; label: string; icon: LucideIcon; match?: string[] };

const ITEMS: Item[] = [
  { href: "/funil", label: "Funil", icon: Columns3, match: ["/leads", "/funis"] },
  { href: "/conversas", label: "Conversas", icon: MessageCircle },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/metas", label: "Metas", icon: Target },
  { href: "/painel", label: "Painel", icon: LayoutDashboard },
];

export function Sidebar() {
  const path = usePathname();
  const item = (i: Item) => {
    const active = path.startsWith(i.href) || !!i.match?.some((m) => path.startsWith(m));
    const Icon = i.icon;
    return (
      <Link
        key={i.href}
        href={i.href}
        className={`group flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-medium transition ${
          active ? "bg-white text-brand shadow-sm" : "text-white/70 hover:bg-white/10 hover:text-white"
        }`}
      >
        <Icon size={20} strokeWidth={active ? 2.2 : 1.8} />
        {i.label}
      </Link>
    );
  };
  return (
    <nav className="flex w-[84px] shrink-0 flex-col gap-1 bg-gradient-to-b from-brand to-brand-dark p-2">
      <div className="mb-4 mt-2 flex justify-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-lg font-black text-brand shadow">B</span>
      </div>
      {ITEMS.map(item)}
      <div className="mt-auto">{item({ href: "/configuracoes", label: "Ajustes", icon: Settings })}</div>
    </nav>
  );
}
