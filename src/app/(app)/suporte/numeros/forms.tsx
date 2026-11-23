"use client";

import { useActionState, useTransition, useState } from "react";
import { checkNumberAction, saveAttendantAction, saveNumberAction, toggleAttendantAction, toggleNumberAction, type SupportState } from "../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

type Option = { id: string; name: string };

function Result({ state }: { state: SupportState }) {
  if (state.error) return <p className="text-sm font-medium text-red-700">{state.error}</p>;
  if (state.message) return <p className="text-sm font-medium text-emerald-700">{state.message}</p>;
  return null;
}

const label = "space-y-1 text-xs font-medium text-slate-600";

export function NumberForm({ number, attendants }: { number?: { id: string; name: string; server: string | null; attendantIds: string[] }; attendants: Option[] }) {
  const [state, action, pending] = useActionState(saveNumberAction, {});
  return (
    <form action={action} className="space-y-3">
      {number && <input type="hidden" name="id" value={number.id} />}
      <div className="grid gap-2 md:grid-cols-2">
        <label className={label}>
          Nome do número
          <input name="name" required defaultValue={number?.name ?? ""} placeholder="Ex.: Suporte Franqueados" className={inputCls} />
        </label>
        <label className={label}>
          Token da instância (Uazapi){number && " · deixe vazio para manter"}
          <input name="token" type="password" autoComplete="off" placeholder={number ? "••••••••" : "Cole aqui o token"} className={inputCls} />
        </label>
        <label className={`${label} md:col-span-2`}>
          Servidor da Uazapi (só se for diferente do que o CRM já usa)
          <input name="server" defaultValue={number?.server ?? ""} placeholder="https://banneg.uazapi.com" className={inputCls} />
        </label>
      </div>
      {attendants.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-600">Quem atende este número</legend>
          <div className="flex flex-wrap gap-2">
            {attendants.map((a) => (
              <label key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                <input type="checkbox" name="attendants" value={a.id} defaultChecked={number?.attendantIds.includes(a.id)} />
                {a.name}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">Com uma pessoa só, o que for respondido pelo celular conta para ela. Com várias, só as respostas pelo CRM saem com o nome de cada uma.</p>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={pending}>
          {pending ? "Conectando…" : number ? "Salvar" : "Conectar número"}
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function NumberActions({ id, active }: { id: string; active: boolean }) {
  const [state, setState] = useState<SupportState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btnGhostCls} disabled={pending} onClick={() => start(async () => setState(await checkNumberAction(id)))}>
        {pending ? "Verificando…" : "Verificar conexão"}
      </button>
      <button type="button" className={btnGhostCls} disabled={pending} onClick={() => start(() => toggleNumberAction(id, !active))}>
        {active ? "Desligar do CRM" : "Ligar de novo"}
      </button>
      <Result state={state} />
    </div>
  );
}

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function AttendantForm({
  attendant,
  users,
  numbers,
}: {
  attendant?: { id: string; name: string; userId: string | null; workDays: number[]; workStart: string; workEnd: string; numberIds: string[] };
  users: Option[];
  numbers: Option[];
}) {
  const [state, action, pending] = useActionState(saveAttendantAction, {});
  const days = attendant?.workDays ?? [1, 2, 3, 4, 5];
  return (
    <form action={action} className="space-y-3">
      {attendant && <input type="hidden" name="id" value={attendant.id} />}
      <div className="grid gap-2 md:grid-cols-2">
        <label className={label}>
          Nome
          <input name="name" required defaultValue={attendant?.name ?? ""} placeholder="Nome do atendente" className={inputCls} />
        </label>
        <label className={label}>
          Acesso no CRM (opcional)
          <select name="userId" defaultValue={attendant?.userId ?? ""} className={inputCls}>
            <option value="">Não usa o CRM, só o celular</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="space-y-1">
        <legend className="text-xs font-medium text-slate-600">Expediente combinado (horário de Brasília)</legend>
        <div className="flex flex-wrap items-center gap-2">
          {DAYS.map((d, i) => (
            <label key={d} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-sm">
              <input type="checkbox" name="workDays" value={i} defaultChecked={days.includes(i)} />
              {d}
            </label>
          ))}
          <input name="workStart" type="time" required defaultValue={attendant?.workStart ?? "08:00"} className={`${inputCls} w-auto!`} />
          <span className="text-sm text-slate-500">às</span>
          <input name="workEnd" type="time" required defaultValue={attendant?.workEnd ?? "18:00"} className={`${inputCls} w-auto!`} />
        </div>
      </fieldset>
      {numbers.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-600">Números que atende</legend>
          <div className="flex flex-wrap gap-2">
            {numbers.map((n) => (
              <label key={n.id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                <input type="checkbox" name="numbers" value={n.id} defaultChecked={attendant?.numberIds.includes(n.id)} />
                {n.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={pending}>
          {pending ? "Salvando…" : attendant ? "Salvar" : "Incluir atendente"}
        </button>
        {attendant && (
          <button type="button" className={btnGhostCls} onClick={() => toggleAttendantAction(attendant.id, false)}>
            Tirar da equipe
          </button>
        )}
        <Result state={state} />
      </div>
    </form>
  );
}
