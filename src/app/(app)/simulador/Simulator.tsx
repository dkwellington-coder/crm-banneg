"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Bot, Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { simulateSdrAction, type SimMessage, type SimResult } from "../../actions";
import { Avatar, Card, TempBadge, btnCls, btnGhostCls, inputCls } from "@/components/ui";

type Turn = SimMessage & { result?: Extract<SimResult, { ok: true }> };

const DECISION: Record<string, { label: string; cls: string }> = {
  continue: { label: "Continua qualificando", cls: "bg-sky-50 text-sky-700" },
  offer_meeting: { label: "Ofereceu reunião", cls: "bg-violet-50 text-violet-700" },
  book_meeting: { label: "Marcou reunião", cls: "bg-emerald-50 text-emerald-700" },
  handoff: { label: "Passou para o gerente", cls: "bg-pink-50 text-pink-700" },
  nurture: { label: "Mandou para nutrição", cls: "bg-slate-100 text-slate-700" },
  disqualify: { label: "Descartou", cls: "bg-red-50 text-red-700" },
};

const FIELD: Record<string, string> = {
  name: "Nome",
  email: "E-mail",
  city: "Cidade",
  state: "UF",
  capital: "Capital",
  timeline: "Prazo",
  experience: "Experiência",
  decisionMaker: "Quem decide",
};

const SCENARIOS = [
  "Oi, vi o anúncio da franquia e quero saber quanto custa",
  "Boa tarde! Tenho uns 300 mil guardados e quero abrir em Curitiba ainda este ano",
  "Quero falar com uma pessoa, não com robô",
  "Só estou pesquisando, talvez daqui a 2 anos",
];

export function Simulator({
  agents,
  company,
  questions,
  qualifyScore,
  knowledgeCount,
  aiReady,
}: {
  agents: { id: string; name: string }[];
  company: string;
  questions: string[];
  qualifyScore: number;
  knowledgeCount: number;
  aiReady: boolean;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [lead, setLead] = useState({ name: "Lead Teste", city: "" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);
  const agent = agents.find((a) => a.id === agentId);
  const last = [...turns].reverse().find((t) => t.result)?.result;

  function send(body: string) {
    if (!body.trim() || pending) return;
    const next: Turn[] = [...turns, { direction: "IN", body: body.trim(), author: lead.name || "Lead" }];
    setTurns(next);
    setText("");
    setError(null);
    start(async () => {
      const res = await simulateSdrAction({
        agentId,
        lead,
        messages: next.map(({ direction, body, author }) => ({ direction, body, author })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setTurns([...next, { direction: "OUT", body: res.reply || "(a IA decidiu não responder)", author: agent?.name ?? "SDR", result: res }]);
      requestAnimationFrame(() => bottom.current?.scrollIntoView({ behavior: "smooth" }));
    });
  }

  return (
    <div className="grid min-h-0 flex-1 gap-4 px-4 pb-6 md:px-6 lg:grid-cols-[1fr_360px]">
      <Card className="flex min-h-[520px] flex-col p-0">
        <div className="grid grid-cols-2 items-center gap-2 border-b border-slate-100 px-4 py-3 md:grid-cols-[150px_1fr_1fr_auto]">
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputCls}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input value={lead.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} placeholder="Nome do lead" className={inputCls} />
          <input value={lead.city} onChange={(e) => setLead({ ...lead, city: e.target.value })} placeholder="Cidade (opcional)" className={inputCls} />
          <button
            onClick={() => {
              setTurns([]);
              setError(null);
            }}
            className={btnGhostCls}
          >
            <RotateCcw size={15} /> Recomeçar
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto bg-[#efeae2] p-4">
          {!aiReady && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                A IA ainda não está conectada. Coloque a ANTHROPIC_API_KEY no servidor e teste em{" "}
                <Link href="/integracoes" className="underline">
                  Integrações
                </Link>
                .
              </span>
            </div>
          )}
          {turns.length === 0 && (
            <div className="mx-auto max-w-md space-y-2 rounded-2xl bg-white/80 p-4 text-center text-sm text-slate-600">
              <Sparkles className="mx-auto text-brand" size={20} />
              <p>
                Escreva como um lead do {company} escreveria no WhatsApp. Ou comece por um destes:
              </p>
              <div className="flex flex-col gap-1.5">
                {SCENARIOS.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-lg bg-white px-3 py-1.5 text-left text-xs ring-1 ring-slate-200 hover:ring-brand">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`flex ${t.direction === "IN" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm shadow-sm ${t.direction === "IN" ? "bg-white" : "bg-[#d9fdd3]"}`}>
                <div className="mb-0.5 text-[11px] font-semibold text-slate-500">{t.author}</div>
                <div className="whitespace-pre-wrap">{t.body}</div>
                {t.result && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-black/5 pt-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${DECISION[t.result.decision]?.cls ?? ""}`}>
                      {DECISION[t.result.decision]?.label ?? t.result.decision}
                    </span>
                    <span className="rounded-full bg-white/70 px-2 py-0.5 text-[11px]">{t.result.score} pts</span>
                  </div>
                )}
              </div>
            </div>
          ))}
          {pending && (
            <div className="flex justify-end">
              <div className="flex items-center gap-2 rounded-xl bg-[#d9fdd3] px-3 py-2 text-sm text-slate-600 shadow-sm">
                <Loader2 size={14} className="animate-spin" /> {agent?.name} digitando…
              </div>
            </div>
          )}
          {error && <div className="rounded-xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">{error}</div>}
          <div ref={bottom} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
          className="flex gap-2 border-t border-slate-100 p-3"
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem do lead…" className={inputCls} disabled={!agentId} />
          <button disabled={pending || !text.trim()} className={btnCls}>
            <Send size={16} />
          </button>
        </form>
      </Card>

      <div className="space-y-4">
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Avatar name={agent?.name ?? "IA"} size={32} />
            <div>
              <div className="text-sm font-semibold">O que a {agent?.name ?? "IA"} entendeu</div>
              <div className="text-xs text-slate-500">Atualiza a cada resposta</div>
            </div>
          </div>
          {last ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${DECISION[last.decision]?.cls ?? ""}`}>{DECISION[last.decision]?.label}</span>
                <TempBadge t={last.temperature} />
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                  score {last.score} (mínimo {qualifyScore})
                </span>
              </div>
              <p className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">{last.summary}</p>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
                {Object.entries(FIELD).map(([k, label]) => (
                  <div key={k} className="contents">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className={last.extracted[k] ? "" : "text-slate-400"}>{last.extracted[k] ?? "a perguntar"}</dd>
                  </div>
                ))}
              </dl>
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">No CRM real, ela faria</div>
                <ul className="space-y-1 text-sm">
                  {last.effects.map((e) => (
                    <li key={e} className="flex gap-1.5">
                      <Bot size={14} className="mt-0.5 shrink-0 text-indigo-500" /> {e}
                    </li>
                  ))}
                </ul>
              </div>
              <p className="text-xs text-slate-500">Motivo: {last.reason}</p>
            </>
          ) : (
            <p className="text-sm text-slate-400">Mande a primeira mensagem para ver a análise.</p>
          )}
        </Card>
        <Card className="space-y-2 text-sm">
          <div className="font-semibold">Ela está seguindo</div>
          <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
            {questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p className="text-xs text-slate-500">
            {knowledgeCount} {knowledgeCount === 1 ? "item" : "itens"} na base de conhecimento. Ajuste perguntas, persona e base em{" "}
            <Link href="/configuracoes" className="text-brand underline">
              Ajustes
            </Link>{" "}
            e teste de novo aqui.
          </p>
          {last && last.slots.length > 0 && <p className="text-xs text-slate-500">Primeiros horários livres na agenda: {last.slots.join("; ")}</p>}
        </Card>
      </div>
    </div>
  );
}
