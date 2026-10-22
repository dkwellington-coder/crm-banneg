"use client";

import { RotateCcw } from "lucide-react";
import { btnCls, Card } from "@/components/ui";

/** Any page of the CRM that breaks shows this inside the menu, instead of a blank screen. */
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // In production the server hides its messages; only ours, written in Portuguese, are worth showing
  const ours = error.message && !error.message.startsWith("An error occurred");
  return (
    <div className="p-6">
      <Card className="max-w-lg space-y-3">
        <h2 className="text-lg font-semibold">Não deu certo desta vez</h2>
        <p className="text-sm text-slate-600">
          {ours ? error.message : "O CRM não conseguiu abrir esta tela ou concluir o que você pediu. Tente de novo; se continuar, avise o Claude."}
        </p>
        {error.digest && <p className="text-xs text-slate-400">Código do erro: {error.digest}</p>}
        <button onClick={retry} className={btnCls}>
          <RotateCcw size={15} /> Tentar de novo
        </button>
      </Card>
    </div>
  );
}
