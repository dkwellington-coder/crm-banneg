"use client";

import { useActionState, useTransition, useState } from "react";
import { Save, Send } from "lucide-react";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";
import { saveSecretaryAction, testSecretaryAction, type SaveState } from "./actions";
import type { SecretaryMember } from "@/lib/secretary";

type Props = {
  name: string;
  members: SecretaryMember[];
  checklist: string;
  instructions: string;
  switches: { active: boolean; confirmEmails: boolean; weekly: boolean; daily: boolean; privates: boolean };
  groups: { id: string; name: string }[] | null;
  groupId: string;
  canTest: boolean;
};

// Two partners and the office team; empty rows to add more (the form saves up to 12)
const ROWS = 6;

function Switch({ name, label, hint, on }: { name: string; label: string; hint: string; on: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 transition hover:bg-slate-50">
      <input type="checkbox" name={name} defaultChecked={on} className="mt-0.5 size-4 accent-brand" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
    </label>
  );
}

/** Her setup in one form: who she is, the group, the people, the checklist and how she works. */
export function SecretaryForm(p: Props) {
  const [state, save, saving] = useActionState<SaveState, FormData>(saveSecretaryAction, {});
  const [test, setTest] = useState<SaveState>({});
  const [testing, startTest] = useTransition();
  const blank = (i: number): SecretaryMember => ({ name: "", phone: "", email: "", role: i < 2 ? "socio" : "colaborador" });
  const rows = [...p.members, ...Array.from({ length: Math.max(2, ROWS - p.members.length) }, (_, i) => blank(p.members.length + i))].slice(0, 12);
  return (
    <form action={save} className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Nome dela</span>
          <input name="name" defaultValue={p.name} className={inputCls} placeholder="Ex.: Clara" />
          <span className="block text-xs text-slate-500">É como ela se apresenta no grupo e no privado.</span>
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Grupo do WhatsApp</span>
          {p.groups ? (
            <select name="groupId" defaultValue={p.groupId} className={inputCls}>
              <option value="">Nenhum ainda</option>
              {p.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500">Conecte o número dela para escolher o grupo.</p>
          )}
          <span className="block text-xs text-slate-500">Ela só lê este grupo. Se o grupo não aparecer, coloque o número dela no grupo e recarregue a página.</span>
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700">Quem pode pedir</p>
        <p className="text-xs text-slate-500">
          <span className="font-medium text-slate-600">Sócios</span> ficam no grupo e pedem tudo.{" "}
          <span className="font-medium text-slate-600">Colaboradores</span> falam com ela no privado: tarefas e lembretes deles, e-mails para clientes,
          checklist, dados de leads e recados; reunião com os sócios só depois do ok no grupo. Quem não está aqui só deixa recado.
        </p>
        <div className="space-y-2">
          {rows.map((m, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_1.3fr_auto]">
              <input name={`name_${i}`} defaultValue={m.name} placeholder="Nome" className={inputCls} aria-label={`Nome da pessoa ${i + 1}`} />
              <input name={`phone_${i}`} defaultValue={m.phone} placeholder="WhatsApp com DDD" inputMode="tel" className={inputCls} aria-label={`WhatsApp da pessoa ${i + 1}`} />
              <input name={`email_${i}`} defaultValue={m.email} placeholder="E-mail" type="email" className={inputCls} aria-label={`E-mail da pessoa ${i + 1}`} />
              <select name={`role_${i}`} defaultValue={m.role ?? "colaborador"} className={`${inputCls} md:w-auto!`} aria-label={`Papel da pessoa ${i + 1}`}>
                <option value="socio">Sócio</option>
                <option value="colaborador">Colaborador</option>
              </select>
            </div>
          ))}
        </div>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Checklist de cadastro</span>
        <textarea name="checklist" defaultValue={p.checklist} rows={7} className={inputCls} placeholder={"Um item por linha, como vai no WhatsApp.\nEx.:\n• RG e CPF\n• Comprovante de endereço"} />
        <span className="block text-xs text-slate-500">Ela manda este texto, do jeito que está, quando alguém pedir o checklist.</span>
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Orientações para ela</span>
        <textarea
          name="instructions"
          defaultValue={p.instructions}
          rows={4}
          className={inputCls}
          placeholder="Ex.: reuniões só de terça a quinta, das 9h às 17h. E-mails para franqueados sempre com cópia para o Odair."
        />
      </label>

      <div className="grid gap-2 md:grid-cols-2">
        <Switch name="active" label="Secretária ligada" hint="Desligada, ela não lê nem responde, e os lembretes param." on={p.switches.active} />
        <Switch name="confirmEmails" label="Mostrar e-mail antes de enviar" hint="Ela mostra o e-mail no grupo e só envia depois de um ok." on={p.switches.confirmEmails} />
        <Switch name="weekly" label="Lista da semana" hint="Toda segunda às 8h: tarefas e reuniões da semana." on={p.switches.weekly} />
        <Switch name="daily" label="Lista do dia" hint="Terça a sexta às 8h: reuniões e tarefas do dia, só quando houver." on={p.switches.daily} />
        <Switch name="privates" label="Atender no privado" hint="Quem escrever direto para o número dela é atendido e o recado vem para o grupo." on={p.switches.privates} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={saving}>
          <Save size={16} /> {saving ? "Salvando…" : "Salvar"}
        </button>
        {p.canTest && (
          <button type="button" className={btnGhostCls} disabled={testing} onClick={() => startTest(async () => setTest(await testSecretaryAction()))}>
            <Send size={16} /> {testing ? "Enviando…" : "Ela se apresentar no grupo"}
          </button>
        )}
        {state.message && <span className={`text-sm font-medium ${state.ok ? "text-emerald-700" : "text-red-700"}`}>{state.message}</span>}
        {test.message && <span className={`text-sm font-medium ${test.ok ? "text-emerald-700" : "text-red-700"}`}>{test.message}</span>}
      </div>
    </form>
  );
}
