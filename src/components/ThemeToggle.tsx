"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

const KEY = "crm_theme";
const EVENT = "crm-theme";

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

const isDark = () => document.documentElement.dataset.theme === "dark";

/** Light (the default) or dark, remembered on this computer. The layout's script applies it before the page paints. */
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => false);
  const toggle = () => {
    const next = !isDark();
    if (next) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // No storage (private window): the choice lasts until the page reloads
    }
    window.dispatchEvent(new Event(EVENT));
  };
  const Icon = dark ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? "Voltar para o modo claro" : "Usar o modo escuro"}
      className="flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2.5 text-[11px] font-medium text-slate-500 transition hover:bg-brand-soft hover:text-brand"
    >
      <Icon size={20} strokeWidth={1.8} />
      {dark ? "Claro" : "Escuro"}
    </button>
  );
}
