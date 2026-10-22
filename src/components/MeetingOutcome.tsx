import { meetingOutcomeAction } from "@/app/actions";

const pill = "rounded-full border px-2.5 py-0.5 text-xs font-medium transition";

/**
 * Once a meeting began: did the lead come? "Não compareceu" takes two clicks, since it sends the lead
 * the message to book again.
 */
export function MeetingOutcome({ meetingId }: { meetingId: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-slate-500">O lead compareceu?</span>
      <form action={meetingOutcomeAction.bind(null, meetingId, "done")}>
        <button className={`${pill} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}>Compareceu</button>
      </form>
      <details className="relative">
        <summary className={`${pill} cursor-pointer list-none border-amber-300 text-amber-700 hover:bg-amber-50`}>Não compareceu</summary>
        <form action={meetingOutcomeAction.bind(null, meetingId, "no_show")} className="mt-1">
          <button className="rounded border border-amber-400 bg-amber-50 px-2 py-1 text-left text-xs text-amber-800">
            Confirmar: mover para Não compareceu e mandar a mensagem para remarcar
          </button>
        </form>
      </details>
    </span>
  );
}

export const OUTCOME_LABEL: Record<string, string> = { done: "realizada", no_show: "não compareceu", canceled: "desmarcada" };
