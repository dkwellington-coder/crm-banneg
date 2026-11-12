"use client";

import { useActionState } from "react";
import { saveMeetingNotesAction, type MeetingNotesState } from "@/app/actions";
import { btnCls, inputCls } from "@/components/ui";

/** "O que aconteceu na reunião": the business manager writes it right after the meeting. */
export function MeetingNotes({ meetingId, notes, signed }: { meetingId: string; notes: string | null; signed: string | null }) {
  const [state, action, pending] = useActionState<MeetingNotesState, FormData>(saveMeetingNotesAction.bind(null, meetingId), {});
  return (
    <form action={action} className="space-y-1.5">
      <label className="block text-xs font-semibold text-slate-600" htmlFor={`notes-${meetingId}`}>
        O que aconteceu na reunião
      </label>
      <textarea
        id={`notes-${meetingId}`}
        name="notes"
        rows={notes ? 4 : 3}
        maxLength={5000}
        defaultValue={notes ?? ""}
        placeholder="Interesse, dúvidas, objeções, o que foi combinado e o próximo passo."
        className={inputCls}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button className={`${btnCls} px-3 py-1.5`} disabled={pending}>
          {pending ? "Salvando…" : notes ? "Atualizar relato" : "Salvar relato"}
        </button>
        {state.error && <span className="text-xs text-red-600">{state.error}</span>}
        {state.ok && <span className="text-xs text-emerald-700">{state.message}</span>}
        {!state.ok && !state.error && signed && <span className="text-xs text-slate-500">{signed}</span>}
      </div>
    </form>
  );
}
