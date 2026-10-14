"use client";

import { Upload } from "lucide-react";
import { useActionState, useState } from "react";
import { importCsvAction } from "../../actions";
import { btnCls, btnGhostCls } from "@/components/ui";

export function ImportButton({ pipelineId }: { pipelineId: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(importCsvAction, null);
  return (
    <>
      <button className={btnGhostCls} onClick={() => setOpen(true)}>
        <Upload size={16} /> Importar
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <form action={action} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <input type="hidden" name="pipelineId" value={pipelineId} />
            <h2 className="text-lg font-bold">Importar leads (CSV do Kommo, RD ou Excel)</h2>
            <input name="file" type="file" accept=".csv,text/csv" className="text-sm" />
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="startAi" className="mt-1" />
              <span>
                Já iniciar a reativação pela IA. Desmarcado, os leads entram em Novo sem receber mensagem, e você decide depois.
              </span>
            </label>
            {state?.message && <p className="rounded-lg bg-slate-50 p-2 text-sm">{state.message}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhostCls} onClick={() => setOpen(false)}>
                Fechar
              </button>
              <button className={btnCls} disabled={pending}>
                {pending ? "Importando…" : "Importar"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
