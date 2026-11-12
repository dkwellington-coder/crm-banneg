"use client";

import { useActionState, useState } from "react";
import { CalendarClock } from "lucide-react";
import { rescheduleMeetingAction } from "@/app/actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

const br = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleString("en-CA", { timeZone: "America/Sao_Paulo", ...opts });

/** "Remarcar": the meeting's new day and time (Brasília); the Google event and the lead follow. */
export function RescheduleMeeting({ meetingId, startsAt, hasPhone }: { meetingId: string; startsAt: Date; hasPhone: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(rescheduleMeetingAction.bind(null, meetingId), {});
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-xs text-brand underline">
        <CalendarClock size={13} /> Remarcar
      </button>
    );
  return (
    <form action={action} className="space-y-2 rounded-lg border border-slate-200 p-2">
      <div className="text-xs font-semibold text-slate-600">Novo dia e horário (Brasília)</div>
      <div className="flex gap-2">
        <input name="date" type="date" required defaultValue={br(startsAt, { year: "numeric", month: "2-digit", day: "2-digit" })} className={inputCls} />
        <input
          name="time"
          type="time"
          required
          step={60}
          defaultValue={br(startsAt, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
          className={`${inputCls} w-28!`}
        />
      </div>
      {hasPhone && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="notify" defaultChecked /> Mandar o novo horário e o link para o cliente no WhatsApp
        </label>
      )}
      <p className="text-xs text-slate-500">O evento muda na agenda Google, os convidados recebem o aviso e o link do Meet continua o mesmo.</p>
      {state.error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{state.error}</p>}
      {state.message && <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">{state.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={`${btnGhostCls} px-3 py-1.5`} onClick={() => setOpen(false)}>
          Fechar
        </button>
        <button className={`${btnCls} px-3 py-1.5`} disabled={pending}>
          {pending ? "Remarcando…" : "Remarcar"}
        </button>
      </div>
    </form>
  );
}
