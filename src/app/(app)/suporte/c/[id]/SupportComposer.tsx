"use client";

import { useActionState, useRef } from "react";
import { sendSupportAction, type SupportState } from "../../actions";
import { btnCls, inputCls } from "@/components/ui";

export function SupportComposer({ chatId }: { chatId: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [state, action, pending] = useActionState<SupportState, FormData>(async (_prev, form) => {
    const result = await sendSupportAction(chatId, form);
    if (result.ok && ref.current) ref.current.value = "";
    return result;
  }, {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <textarea
        ref={ref}
        name="body"
        rows={3}
        placeholder="Resposta no WhatsApp"
        className={`${inputCls} max-md:h-[4.5rem]`}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !pending) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="flex items-center gap-2">
        {state.error && <span className="text-sm font-medium text-red-700">{state.error}</span>}
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
