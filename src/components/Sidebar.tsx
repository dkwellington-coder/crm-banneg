"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/funil", label: "Funil", icon: "▦" },
  { href: "/conversas", label: "Conversas", icon: "✉" },
  { href: "/agenda", label: "Agenda", icon: "◷" },
  { href: "/painel", label: "Painel", icon: "▤" },
];

export function Sidebar() {
  const path = usePathname();
  const item = (i: { href: string; label: string; icon: string }) => {
    const active = path.startsWith(i.href) || (i.href === "/funil" && path.startsWith("/leads"));
    return (
      <Link
        key={i.href}
        href={i.href}
        className={`flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-xs ${
          active ? "bg-white/15 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
        }`}
      >
        <span className="text-lg leading-none">{i.icon}</span>
        {i.label}
      </Link>
    );
  };
  return (
    <nav className="flex w-20 shrink-0 flex-col gap-1 bg-brand p-2">
      <div className="mb-4 mt-2 text-center text-sm font-black tracking-widest text-white">B/</div>
      {ITEMS.map(item)}
      <div className="mt-auto">{item({ href: "/configuracoes", label: "Ajustes", icon: "⚙" })}</div>
    </nav>
  );
}
