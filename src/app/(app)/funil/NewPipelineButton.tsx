"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { createPipelineAction } from "../../actions";
import { btnCls, btnGhostCls, inputCls, tabCls } from "@/components/ui";

export function NewPipelineButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={tabCls(false)} onClick={() => setOpen(true)}>
        <Plus size={15} /> Novo funil
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <form action={createPipelineAction} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">Novo funil</h2>
            <input name="name" autoFocus required placeholder="Ex.: Revenda, Pós-venda, Indicações" className={inputCls} />
            <p className="text-xs text-slate-500">
              Ele começa com Novo, Em contato, Proposta, Ganho e Perdido. Depois você renomeia, cria etapas e escolhe as automações de cada uma.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhostCls} onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <button className={btnCls}>Criar e configurar</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
