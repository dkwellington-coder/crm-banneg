"use client";

import { useEffect, useState } from "react";
import type { ReopenChoice, StageMoveBlock } from "@/lib/stage-move";
import { ApoliceUpload } from "./ApoliceUpload";
import { btnCls, btnGhostCls, inputCls } from "./ui";

/**
 * What a move to another stage is waiting for: the reason of a loss, the policy of a won quote, or what happened to a
 * won sale taken back to an open stage. lead: its name. storeSees: the store reads the reason in the portal (every lost
 * stage but Erro no WhatsApp, which the portal never hears of).
 */
export type StageAsk = { leadId: string; lead: string; to: string; stage: string; need: StageMoveBlock["need"]; storeSees: boolean };

const REOPEN_CHOICES: { choice: ReopenChoice; label: string; detail: string }[] = [
  { choice: "new", label: "É um novo atendimento", detail: "A venda da loja continua fechada no portal." },
  { choice: "undone", label: "A venda foi desfeita", detail: "A loja volta a acompanhar este atendimento." },
];

/**
 * The window the board and the lead's page open before a move that needs something from the person. Cancelling
 * leaves the lead where it was.
 */
export function StageMoveDialog({
  ask,
  onReason,
  onUploaded,
  onReopen,
  onCancel,
}: {
  ask: StageAsk;
  onReason: (reason: string) => void;
  onUploaded: () => void;
  onReopen: (choice: ReopenChoice) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  // Esc leaves the lead where it was, as Cancelar does
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stage-move-title"
        className="w-full max-w-md space-y-3 rounded-2xl bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {ask.need === "reason" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) onReason(reason.trim());
            }}
          >
            <h2 id="stage-move-title" className="text-lg font-bold">
              Motivo da perda
            </h2>
            <p className="text-sm text-slate-500">
              {ask.lead || "O lead"} vai para {ask.stage}.{ask.storeSees && " Se veio de uma loja parceira, a loja vê este motivo no portal de indicações."}
            </p>
            <textarea
              autoFocus
              required
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: fechou com outra corretora, achou caro, não respondeu mais"
              className={inputCls}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhostCls} onClick={onCancel}>
                Cancelar
              </button>
              <button className={btnCls} disabled={!reason.trim()}>
                Confirmar
              </button>
            </div>
          </form>
        ) : ask.need === "reopen" ? (
          <div className="space-y-3">
            <h2 id="stage-move-title" className="text-lg font-bold">
              Tirar do Ganho
            </h2>
            <p className="text-sm text-slate-500">A loja que indicou vê esta venda como fechada no portal. O que aconteceu?</p>
            <div className="space-y-2">
              {/* Neither answer is focused first: a stray Enter must not pick one for the person */}
              {REOPEN_CHOICES.map((c) => (
                <button
                  key={c.choice}
                  type="button"
                  onClick={() => onReopen(c.choice)}
                  className="block w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-left transition hover:border-brand hover:bg-brand-soft focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/15"
                >
                  <span className="block text-sm font-semibold text-slate-900">{c.label}</span>
                  <span className="block text-xs text-slate-500">{c.detail}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button type="button" className={btnGhostCls} onClick={onCancel}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 id="stage-move-title" className="text-lg font-bold">
              Anexe a apólice ou o contrato
            </h2>
            <p className="text-sm text-slate-500">
              Para marcar {ask.lead || "o lead"} como {ask.stage}, anexe a apólice emitida ou, no consórcio, o contrato (PDF, JPG ou PNG, até 20 MB). Assim que o arquivo subir, o lead muda de etapa.
            </p>
            <ApoliceUpload leadId={ask.leadId} onDone={onUploaded} primary />
            <div className="flex justify-end">
              <button type="button" className={btnGhostCls} onClick={onCancel}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
