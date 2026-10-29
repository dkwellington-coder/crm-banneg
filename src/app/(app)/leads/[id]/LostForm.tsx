"use client";

import { useActionState } from "react";
import { markLostAction } from "../../../actions";
import { btnGhostCls, inputCls } from "@/components/ui";

/** "Perdido" on the lead's page: the reason is required, and a refusal says why instead of doing nothing. */
export function LostForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(markLostAction.bind(null, leadId), {});
  return (
    <form action={action} className="space-y-1">
      <div className="flex gap-2">
        <input name="reason" required maxLength={500} placeholder="Motivo da perda" className={inputCls} />
        <button disabled={pending} className={`${btnGhostCls} disabled:opacity-60`}>
          {pending ? "Salvando…" : "Perdido"}
        </button>
      </div>
      <p className="text-xs text-slate-500">Se o lead veio por indicação de uma loja parceira ou de um afiliado, quem indicou vê este motivo no portal de indicações.</p>
      {state.error && (
        <p role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
