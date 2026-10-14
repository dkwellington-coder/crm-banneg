"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";
import { btnCls, inputCls } from "@/components/ui";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action} className="space-y-3">
      <input name="email" type="email" required placeholder="E-mail" className={inputCls} autoComplete="email" />
      <input name="password" type="password" required placeholder="Senha" className={inputCls} autoComplete="current-password" />
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button className={`${btnCls} w-full`} disabled={pending}>
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
