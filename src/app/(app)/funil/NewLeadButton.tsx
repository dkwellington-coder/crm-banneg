"use client";

import { useState } from "react";
import { createLeadAction } from "../../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

export function NewLeadButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={btnCls} onClick={() => setOpen(true)}>
        + Novo lead
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <form action={createLeadAction} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">Novo lead</h2>
            <input name="name" placeholder="Nome" className={inputCls} />
            <input name="phone" placeholder="WhatsApp com DDD" className={inputCls} />
            <input name="email" type="email" placeholder="E-mail" className={inputCls} />
            <input name="city" placeholder="Cidade" className={inputCls} />
            <p className="text-xs text-slate-500">Ao salvar, a SDR de IA manda a primeira mensagem e começa a sequência de e-mails.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhostCls} onClick={() => setOpen(false)}>
                Cancelar
              </button>
              <button className={btnCls}>Salvar</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
