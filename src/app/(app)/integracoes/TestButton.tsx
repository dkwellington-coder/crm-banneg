"use client";

import { useActionState, type ReactNode } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { testIntegrationAction, type TestState } from "../../actions";
import { btnGhostCls } from "@/components/ui";

/** A test button with its own result line, so each integration is checked on its own. */
export function TestButton({ kind, label, children }: { kind: string; label: string; children?: ReactNode }) {
  const [state, action, pending] = useActionState<TestState, FormData>(testIntegrationAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <button disabled={pending} className={btnGhostCls}>
          {pending && <Loader2 size={15} className="animate-spin" />}
          {label}
        </button>
      </div>
      {state && (
        <div className={`rounded-lg px-3 py-2 text-sm ${state.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          <div className="flex items-start gap-2">
            {state.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{state.message}</span>
          </div>
          {state.details && state.details.length > 0 && (
            <ul className="mt-1 list-disc pl-8 text-xs opacity-80">
              {state.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
