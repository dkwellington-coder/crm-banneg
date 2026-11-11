"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { removeUserAccessAction, saveAccessAction, type AccessState } from "../../actions";
import { Avatar, btnCls, btnGhostCls, inputCls } from "@/components/ui";

type AreaOption = { key: string; label: string; hint: string };
type Person = { id: string; name: string; email: string; role: string; calendarId: string | null; areas: string[] };

const ROLE_LABEL: Record<string, string> = { OWNER: "Proprietário", MANAGER: "Gerente", SELLER: "Vendedor" };
// A new person starts with the screens that work leads; the owner ticks more if needed
const NEW_PERSON = ["funil", "conversas", "agenda"];
// No 0/O or 1/l/I, so the password reads the same on any screen or over the phone
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function AccessForm({ user, isMe = false, areas, loginUrl }: { user?: Person; isMe?: boolean; areas: AreaOption[]; loginUrl: string }) {
  const [role, setRole] = useState(user?.role ?? "SELLER");
  const [password, setPassword] = useState("");
  const [state, action, pending] = useActionState<AccessState, FormData>(async (prev, form) => {
    const result = await saveAccessAction(prev, form);
    // Saved: the password field empties (it shows once in the card to copy)
    if (result.ok) setPassword("");
    return result;
  }, {});
  const [show, setShow] = useState(false);
  const all = !!user?.areas.includes("*");
  const owner = role === "OWNER";
  const blocked = !!user && user.role !== "OWNER" && user.areas.length === 0;
  return (
    <form action={action} className="space-y-3">
      {user && (
        <div className="flex flex-wrap items-center gap-2">
          <Avatar name={user.name} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-slate-900">
              {user.name} {isMe && <span className="text-xs font-normal text-slate-500">(você)</span>}
            </div>
            <div className="truncate text-xs text-slate-500">{user.email}</div>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${blocked ? "bg-red-50 text-red-700" : "bg-brand-soft text-brand"}`}
          >
            {blocked ? "Sem acesso" : user.role === "OWNER" ? "Vê tudo" : `${ROLE_LABEL[user.role]}`}
          </span>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-slate-600">
          Nome
          <input name="name" required defaultValue={user?.name ?? ""} placeholder="Nome da pessoa" className={inputCls} />
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600">
          Usuário (e-mail de entrada)
          <input
            name="email"
            type="email"
            required
            defaultValue={user?.email ?? ""}
            readOnly={!!user}
            placeholder="nome@banneg.com.br"
            className={`${inputCls} ${user ? "bg-slate-50 text-slate-500" : ""}`}
          />
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600">
          {user ? "Nova senha (deixe em branco para manter)" : "Senha"}
          <div className="flex gap-2">
            <input
              name="password"
              type={show ? "text" : "password"}
              required={!user}
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Pelo menos 8 caracteres"
              className={inputCls}
            />
            <button type="button" onClick={() => setShow(!show)} className={btnGhostCls} title={show ? "Esconder" : "Mostrar"}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
            <button
              type="button"
              onClick={() => {
                setPassword(newPassword());
                setShow(true);
              }}
              className={btnGhostCls}
              title="Gerar uma senha forte"
            >
              <KeyRound size={16} /> Gerar
            </button>
          </div>
        </label>
        <label className="space-y-1 text-xs font-medium text-slate-600">
          Papel
          <select name="role" value={role} onChange={(e) => setRole(e.target.value)} disabled={isMe && user?.role === "OWNER"} className={inputCls}>
            <option value="OWNER">Proprietário (vê e muda tudo)</option>
            <option value="MANAGER">Gerente (recebe reuniões, edita funis e metas)</option>
            <option value="SELLER">Vendedor (atende os leads)</option>
          </select>
          {isMe && user?.role === "OWNER" && <input type="hidden" name="role" value="OWNER" />}
        </label>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-slate-600">Telas que pode abrir</legend>
        {owner ? (
          <p className="text-sm text-slate-500">O proprietário abre todas as telas, inclusive Acessos.</p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {areas.map((a) => (
              <label key={a.key} className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" name="areas" value={a.key} defaultChecked={user ? all || user.areas.includes(a.key) : NEW_PERSON.includes(a.key)} className="mt-0.5" />
                <span>
                  <span className="font-medium text-slate-800">{a.label}</span>
                  <span className="block text-xs text-slate-500">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer">Agenda Google (opcional)</summary>
        <input name="calendarId" defaultValue={user?.calendarId ?? ""} placeholder="E-mail da agenda, para gerentes que recebem reuniões" className={`${inputCls} mt-1`} />
      </details>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.ok && <p className="text-sm text-emerald-700">{state.message}</p>}
      {state.login && <LoginCard login={state.login} loginUrl={loginUrl} />}

      <div className="flex flex-wrap items-center gap-2">
        <button className={btnCls} disabled={pending}>
          {pending ? "Salvando…" : user ? "Salvar" : "Criar acesso"}
        </button>
        {user && !isMe && !blocked && (
          <button
            type="submit"
            formAction={removeUserAccessAction.bind(null, user.id)}
            formNoValidate
            onClick={(e) => {
              if (!confirm(`Tirar o acesso de ${user.name}? A pessoa sai de todos os aparelhos agora.`)) e.preventDefault();
            }}
            className="text-xs text-slate-400 hover:text-red-600"
          >
            Tirar acesso
          </button>
        )}
      </div>
    </form>
  );
}

/** The login to send to the person, ready to copy: shown once, right after saving. */
function LoginCard({ login, loginUrl }: { login: { name: string; email: string; password: string }; loginUrl: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Seu acesso ao CRM do Banneg\nEndereço: ${loginUrl}\nUsuário: ${login.email}\nSenha: ${login.password}`;
  return (
    <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
      <div className="font-semibold">Mande para {login.name.split(" ")[0]}:</div>
      <pre className="whitespace-pre-wrap font-sans">{text}</pre>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        }}
        className={btnGhostCls}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}
