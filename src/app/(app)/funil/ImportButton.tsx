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
      <button className={btnGhostCls} onClick={() => setOpen(true)} title="Importar planilha">
        <Upload size={16} /> <span className="max-md:hidden">Importar</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={() => setOpen(false)}>
          <form action={action} className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6" onClick={(e) => e.stopPropagation()}>
            <input type="hidden" name="pipelineId" value={pipelineId} />
            <h2 className="text-lg font-bold">Importar leads (CSV do Kommo, RD, Excel ou CRM antigo)</h2>
            <input name="file" type="file" accept=".csv,text/csv" className="text-sm" />
            <p className="text-xs text-slate-500">
              Os leads entram na fila do funil (ou em Novo, se ele não tiver fila). Uma coluna &quot;funil&quot; no arquivo manda cada lead
              para o funil indicado. Quem pediu para não receber mensagens vai para Descartado, quem já fechou fica de fora, e quem já
              está no CRM não é duplicado.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="startAi" className="mt-1" />
              <span>
                Já iniciar a reativação pela IA. Desmarcado, os leads entram sem receber mensagem: numa fila, saem aos poucos nos dias
                úteis; fora dela, você decide depois.
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
