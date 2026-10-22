"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { tabCls } from "@/components/ui";

/** On the computer, the lead's data beside the conversation. On the phone, one at a time: the conversation first. */
export function LeadSplit({ name, info, chat }: { name: string; info: ReactNode; chat: ReactNode }) {
  const [tab, setTab] = useState<"chat" | "info">("chat");
  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 lg:hidden">
        <Link href="/funil" aria-label="Voltar para o funil" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
          <ArrowLeft size={18} />
        </Link>
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
        <div className="flex shrink-0 gap-1 rounded-xl bg-sunken p-1">
          <button type="button" onClick={() => setTab("chat")} className={tabCls(tab === "chat")}>
            Conversa
          </button>
          <button type="button" onClick={() => setTab("info")} className={tabCls(tab === "info")}>
            Dados
          </button>
        </div>
      </div>
      <aside
        className={`w-full shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-white p-4 lg:w-96 ${
          tab === "info" ? "max-lg:min-h-0 max-lg:flex-1" : "max-lg:hidden"
        }`}
      >
        {info}
      </aside>
      <section className={`flex min-h-0 flex-1 flex-col bg-slate-50 ${tab === "chat" ? "" : "max-lg:hidden"}`}>{chat}</section>
    </div>
  );
}
