"use client";

import { useRef, useTransition } from "react";
import { sendMessageAction } from "../../../actions";
import { btnCls, inputCls } from "@/components/ui";

export function Composer({ leadId, macros }: { leadId: string; macros: { title: string; body: string }[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pending, start] = useTransition();
  return (
    <form
      action={(form) => {
        if (pending || !String(form.get("body") ?? "").trim()) return;
        start(async () => {
          await sendMessageAction(leadId, form);
          if (ref.current) ref.current.value = "";
        });
      }}
      className="flex flex-col gap-2"
    >
      <textarea
        ref={ref}
        name="body"
        rows={3}
        placeholder="Mensagem de WhatsApp"
        className={`${inputCls} max-md:h-[4.5rem]`}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !pending) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="flex items-center gap-2">
        {macros.length > 0 && (
          <select
            className={`${inputCls} w-auto!`}
            value=""
            onChange={(e) => {
              const m = macros[Number(e.target.value)];
              if (m && ref.current) ref.current.value = m.body;
            }}
          >
            <option value="">Inserir macro…</option>
            {macros.map((m, i) => (
              <option key={m.title} value={i}>
                {m.title}
              </option>
            ))}
          </select>
        )}
        <button className={`${btnCls} ml-auto`} disabled={pending}>
          {pending ? (
            "Enviando…"
          ) : (
            <>
              Enviar<span className="max-md:hidden"> (Ctrl+Enter)</span>
            </>
          )}
        </button>
      </div>
    </form>
  );
}
