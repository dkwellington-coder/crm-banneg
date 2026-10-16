"use client";

import { useActionState, useState } from "react";
import { CalendarPlus } from "lucide-react";
import { scheduleMeetingAction } from "../../../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

type Props = {
  leadId: string;
  managers: { id: string; name: string }[];
  defaultUserId: string;
  minutes: number;
  hasPhone: boolean;
  google: string | null;
};

/** Next business day in São Paulo, as the date input wants it (YYYY-MM-DD). */
function nextBusinessDay() {
  const d = new Date(Date.now() - 3 * 3600_000);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export function ScheduleMeeting({ leadId, managers, defaultUserId, minutes, hasPhone, google }: Props) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(scheduleMeetingAction.bind(null, leadId), null);
  if (!open)
    return (
      <button type="button" className={`${btnGhostCls} w-full`} onClick={() => setOpen(true)}>
        <CalendarPlus size={16} /> Agendar reunião
      </button>
    );
  return (
    <form action={action} className="space-y-2">
      <div className="flex gap-2">
        <input name="date" type="date" required defaultValue={nextBusinessDay()} className={inputCls} />
        <input name="time" type="time" required defaultValue="10:00" step={900} className={`${inputCls} w-28!`} />
      </div>
      <div className="flex gap-2">
        <select name="minutes" defaultValue={String(minutes)} className={`${inputCls} w-28!`}>
          {[30, 45, 60, 90].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        <select name="userId" defaultValue={defaultUserId} className={inputCls} title="Quem faz a reunião">
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              com {m.name}
            </option>
          ))}
        </select>
      </div>
      {hasPhone && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="notify" defaultChecked /> Enviar dia, hora e link para o lead no WhatsApp
        </label>
      )}
      <p className="text-xs text-slate-500">
        {google
          ? `Entra no Google Agenda (${google}) com link do Meet. Horário de Brasília.`
          : "Google Agenda não conectado: a reunião fica só no CRM, sem link do Meet. Conecte em Integrações."}
      </p>
      {state && "error" in state && state.error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{state.error}</p>}
      {state && "message" in state && state.message && <p className="rounded-lg bg-emerald-50 p-2 text-sm text-emerald-800">{state.message}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnGhostCls} onClick={() => setOpen(false)}>
          Fechar
        </button>
        <button className={btnCls} disabled={pending}>
          {pending ? "Agendando…" : "Agendar"}
        </button>
      </div>
    </form>
  );
}
