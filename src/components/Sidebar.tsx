"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { CalendarDays, Columns3, FlaskConical, LayoutDashboard, MessageCircle, Plug, Settings, Target, type LucideIcon } from "lucide-react";
import { AlertBell, AlertToasts, Badge, useTeamAlerts } from "./Alerts";
import { ThemeToggle } from "./ThemeToggle";

type Item = { href: string; label: string; icon: LucideIcon; match?: string[] };

const ITEMS: Item[] = [
  { href: "/funil", label: "Funil", icon: Columns3, match: ["/leads", "/funis"] },
  { href: "/conversas", label: "Conversas", icon: MessageCircle },
  { href: "/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/metas", label: "Metas", icon: Target },
  { href: "/painel", label: "Painel", icon: LayoutDashboard },
  { href: "/simulador", label: "Simulador", icon: FlaskConical },
];

export function Sidebar() {
  const path = usePathname();
  const router = useRouter();
  // Something new arrived: the funnel and the inbox on screen refresh by themselves
  const alerts = useTeamAlerts(() => {
    if (["/funil", "/conversas", "/painel"].some((p) => path.startsWith(p))) router.refresh();
  });
  const fresh = alerts.data?.newLeads ?? 0;
  const waiting = alerts.data?.waiting ?? 0;

  // "(3) BANNEG CRM" in the browser tab, so the alert shows even with another tab open
  useEffect(() => {
    const total = fresh + waiting;
    const apply = () => {
      // Mid-navigation the title can be empty for a moment. "(3) " would read back as "(3)" (the browser
      // trims it), never match, and set it again forever, freezing the tab: so never leave the name empty.
      const base = document.title.replace(/^\(\d+\+?\)\s*/, "").trim() || "BANNEG CRM";
      const want = total ? `(${total > 99 ? "99+" : total}) ${base}` : base;
      if (document.title !== want) document.title = want;
    };
    apply();
    // Navigating or refreshing the page puts the plain title back: add the count again
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => watch.disconnect();
  }, [fresh, waiting, path]);

  const badges: Record<string, { count: number; title: string }> = {
    "/funil": { count: fresh + waiting, title: `${fresh} lead(s) novo(s) e ${waiting} esperando resposta` },
    "/conversas": { count: waiting, title: `${waiting} esperando resposta de uma pessoa` },
  };
  const item = (i: Item) => {
    const active = path.startsWith(i.href) || !!i.match?.some((m) => path.startsWith(m));
    const Icon = i.icon;
    const badge = badges[i.href];
    const alert = !!badge?.count && !active;
    return (
      <Link
        key={i.href}
        href={i.href}
        className={`group flex flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-medium transition ${
          active ? "bg-brand text-white" : alert ? "bg-red-600 text-white" : "text-slate-500 hover:bg-brand-soft hover:text-brand"
        }`}
      >
        <span className="relative">
          <Icon size={20} strokeWidth={active ? 2.2 : 1.8} className={active ? "text-gold dark:text-current" : undefined} />
          {badge && <Badge count={badge.count} title={badge.title} />}
        </span>
        {i.label}
      </Link>
    );
  };
  return (
    <nav className="flex w-[88px] shrink-0 flex-col gap-1 border-r border-slate-200 bg-white p-2">
      <Link href="/funil" className="mb-5 mt-3 flex justify-center" title="BANNEG CRM">
        <Image src="/brand/monograma-azul.png" alt="BANNEG" width={44} height={23} priority className="dark:hidden" />
        <Image src="/brand/monograma-dourado.png" alt="BANNEG" width={44} height={23} priority className="hidden dark:block" />
      </Link>
      {ITEMS.map(item)}
      <div className="mt-auto space-y-1">
        <ThemeToggle />
        <AlertBell sound={alerts.sound} permission={alerts.permission} onClick={alerts.toggle} />
        {item({ href: "/integracoes", label: "Integrar", icon: Plug })}
        {item({ href: "/configuracoes", label: "Ajustes", icon: Settings })}
      </div>
      <AlertToasts toasts={alerts.toasts} dismiss={alerts.dismiss} seen={alerts.seen} />
    </nav>
  );
}
