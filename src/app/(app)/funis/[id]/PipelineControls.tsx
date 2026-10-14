"use client";

import { Plus, Trash2 } from "lucide-react";
import { addStageAction, deletePipelineAction } from "../../../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";
import { useRef } from "react";

export function DeletePipelineButton({ pipelineId }: { pipelineId: string }) {
  return (
    <button
      className={`${btnGhostCls} text-red-600 hover:bg-red-50`}
      onClick={async () => {
        if (confirm("Excluir este funil e todas as automações dele?")) await deletePipelineAction(pipelineId);
      }}
    >
      <Trash2 size={15} /> Excluir funil
    </button>
  );
}

export function AddStageForm({ pipelineId }: { pipelineId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={ref}
      action={async (fd) => {
        await addStageAction(pipelineId, fd);
        ref.current?.reset();
      }}
      className="mt-4 flex items-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 p-3"
    >
      <input type="color" name="color" defaultValue="#6366f1" className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-slate-200 bg-white p-1" />
      <input name="name" required placeholder="Nome da nova etapa (entra antes de Ganho/Perdido)" className={inputCls} />
      <button className={`${btnCls} shrink-0`}>
        <Plus size={16} /> Adicionar etapa
      </button>
    </form>
  );
}

