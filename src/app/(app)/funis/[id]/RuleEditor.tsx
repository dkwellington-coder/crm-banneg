"use client";

import { useRef, useState } from "react";
import { Wand2 } from "lucide-react";
import { ACTIONS, UNITS, splitDelay, templateSlots, type ActionKey, type RuleConfig, type RuleTrigger } from "@/lib/rules";
import { saveRuleAction } from "../../../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

export type RuleData = {
  id: string;
  trigger: RuleTrigger;
  delayMinutes: number;
  action: string;
  config: RuleConfig;
  runAfterLeaving: boolean;
  active: boolean;
};

export type EditorOptions = {
  stages: { id: string; name: string; pipeline: string; same: boolean }[];
  emails: { key: string; name: string }[];
  sdrs: { id: string; name: string }[];
  waTemplates: { name: string; status: string; body: string }[];
};

type Draft = {
  trigger: RuleTrigger;
  when: "now" | "later";
  amount: number;
  unit: (typeof UNITS)[number]["key"];
  action: ActionKey;
  config: RuleConfig;
  runAfterLeaving: boolean;
};

// One click fills the sentence; the person only adjusts what differs
const PRESETS: { label: string; draft: Partial<Draft> }[] = [
  {
    label: "Boas-vindas no WhatsApp",
    draft: { trigger: "enter", when: "now", action: "whatsapp", config: { text: "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}. Recebi seu contato e já te ajudo por aqui." } },
  },
  {
    label: "Cobrar se não responder",
    draft: { trigger: "idle", amount: 1, unit: "d", action: "whatsapp", config: { text: "Oi, {{nome}}! Conseguiu ver minha última mensagem?" } },
  },
  { label: "Tarefa se ficar parado", draft: { trigger: "enter", when: "later", amount: 3, unit: "d", action: "task", config: { title: "Lead parado há 3 dias: dar retorno" } } },
  { label: "Mandar a apresentação", draft: { trigger: "enter", when: "later", amount: 5, unit: "min", action: "email", config: {} } },
  { label: "Ligar a SDR de IA", draft: { trigger: "enter", when: "now", action: "ai_on", config: {} } },
  { label: "Mover se sumir", draft: { trigger: "idle", amount: 7, unit: "d", action: "move", config: {} } },
  { label: "Fila: soltar leads por dia", draft: { trigger: "daily", action: "move", config: { perDay: 100 } } },
  { label: "Mover quando tocar no botão", draft: { trigger: "answer", action: "move", config: { answers: ["Quero ver"] } } },
];

const VARIABLES = ["nome", "empresa", "parceiro", "produto", "cidade", "sdr", "apresentacao", "video_ganhos", "simulacoes", "por_que_investir", "video_fundador", "video_bottini"];

function fromRule(rule?: RuleData): Draft {
  if (!rule) return { trigger: "enter", when: "now", amount: 1, unit: "d", action: "whatsapp", config: {}, runAfterLeaving: false };
  const { amount, unit } = splitDelay(rule.delayMinutes);
  return {
    trigger: rule.trigger,
    when: rule.delayMinutes === 0 ? "now" : "later",
    amount: rule.delayMinutes === 0 ? 1 : amount,
    unit: rule.delayMinutes === 0 ? "d" : unit,
    action: rule.action as ActionKey,
    config: rule.config,
    runAfterLeaving: rule.runAfterLeaving,
  };
}

const sel = "rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm font-medium text-slate-800 outline-none focus:border-brand";
const word = "text-sm font-medium text-slate-500";

export function RuleEditor({ stageId, rule, options, onDone }: { stageId: string; rule?: RuleData; options: EditorOptions; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => fromRule(rule));
  const [saving, setSaving] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<Draft>) => setD((cur) => ({ ...cur, ...patch }));
  const setConfig = (patch: RuleConfig) => setD((cur) => ({ ...cur, config: { ...cur.config, ...patch } }));
  const daily = d.trigger === "daily";
  const answer = d.trigger === "answer";
  const later = !daily && !answer && (d.trigger === "idle" || d.when === "later");

  function insertVar(v: string) {
    const el = text.current;
    const value = d.config.text ?? "";
    const at = el?.selectionStart ?? value.length;
    setConfig({ text: `${value.slice(0, at)}{{${v}}}${value.slice(at)}` });
    requestAnimationFrame(() => el?.focus());
  }

  // The chosen template's {{1}}, {{2}}...: name and SDR unless the person picks other variables
  const template = options.waTemplates.find((t) => t.name === d.config.templateName);
  const slots = template ? templateSlots(template.body) : 0;
  const params = Array.from({ length: slots }, (_, i) => d.config.templateParams?.[i] ?? ["nome", "sdr"][i] ?? "");
  const setParam = (i: number, v: string) => setConfig({ templateParams: params.map((p, j) => (j === i ? v : p)) });

  const sameFunnel = options.stages.filter((s) => s.same);
  const otherFunnels = options.stages.filter((s) => !s.same);

  return (
    <form
      action={async (fd) => {
        setSaving(true);
        await saveRuleAction(fd);
        setSaving(false);
        onDone();
      }}
      className="space-y-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-4 ring-4 ring-brand/5"
    >
      {rule && <input type="hidden" name="id" value={rule.id} />}
      <input type="hidden" name="stageId" value={stageId} />
      <input type="hidden" name="trigger" value={d.trigger} />
      <input type="hidden" name="amount" value={later ? d.amount : 0} />
      <input type="hidden" name="unit" value={d.unit} />
      <input type="hidden" name="action" value={d.action} />
      {daily && <input type="hidden" name="perDay" value={d.config.perDay ?? 100} />}
      {answer && <input type="hidden" name="answers" value={(d.config.answers ?? []).join(" | ")} />}

      {!rule && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500">
            <Wand2 size={13} /> Atalhos:
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setD((cur) => ({ ...cur, ...p.draft, config: { ...p.draft.config } }))}
              className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200 transition hover:text-brand hover:ring-brand"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* The rule reads as a sentence */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
        <span className={word}>Quando o lead</span>
        <select
          value={d.trigger}
          onChange={(e) => {
            const trigger = e.target.value as RuleTrigger;
            // A queue only releases leads to another stage
            set(
              trigger === "daily"
                ? { trigger, action: "move", config: { perDay: 100 } }
                : trigger === "answer"
                  ? { trigger, config: { ...d.config, answers: d.config.answers ?? [] } }
                  : { trigger },
            );
          }}
          className={sel}
        >
          <option value="enter">entrar nesta etapa</option>
          <option value="idle">ficar sem responder</option>
          <option value="daily">estiver na fila desta etapa</option>
          <option value="answer">responder</option>
        </select>
        {answer ? (
          <input
            value={(d.config.answers ?? []).join(" | ")}
            onChange={(e) => setConfig({ answers: e.target.value.split("|").map((a) => a.trim()).filter(Boolean) })}
            placeholder="Quero ver | Sim"
            className={`${sel} w-56`}
          />
        ) : daily ? (
          <>
            <span className={word}>soltar</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={d.config.perDay ?? 100}
              onChange={(e) => setConfig({ perDay: Math.min(1000, Math.max(1, Number(e.target.value) || 1)) })}
              className={`${sel} w-24`}
            />
            <span className={word}>por dia útil (9h às 18h), os mais recentes primeiro</span>
          </>
        ) : d.trigger === "enter" ? (
          <select value={d.when} onChange={(e) => set({ when: e.target.value as Draft["when"] })} className={sel}>
            <option value="now">na hora</option>
            <option value="later">depois de</option>
          </select>
        ) : (
          <span className={word}>por</span>
        )}
        {later && (
          <>
            <input
              type="number"
              min={1}
              value={d.amount}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value) || 1) })}
              className={`${sel} w-20`}
            />
            <select value={d.unit} onChange={(e) => set({ unit: e.target.value as Draft["unit"] })} className={sel}>
              {UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </>
        )}
        <span className={word}>então</span>
        <select
          value={d.action}
          disabled={daily}
          onChange={(e) => set({ action: e.target.value as ActionKey, config: {} })}
          className={sel}
        >
          {Object.entries(ACTIONS).map(([k, a]) => (
            <option key={k} value={k}>
              {a.label.charAt(0).toLowerCase() + a.label.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {d.action === "whatsapp" && (
        <div className="space-y-1.5">
          <textarea
            ref={text}
            name="text"
            required
            rows={3}
            value={d.config.text ?? ""}
            onChange={(e) => setConfig({ text: e.target.value })}
            placeholder="Escreva a mensagem. Use as variáveis para personalizar."
            className={inputCls}
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            Inserir:
            {VARIABLES.map((v) => (
              <button key={v} type="button" onClick={() => insertVar(v)} className="rounded-md bg-white px-2 py-0.5 font-mono text-[11px] ring-1 ring-slate-200 hover:ring-brand">
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <input
            name="buttons"
            value={(d.config.buttons ?? []).join(" | ")}
            onChange={(e) => setConfig({ buttons: e.target.value.split("|").map((b) => b.trim()).filter(Boolean).slice(0, 3) })}
            placeholder="Botões (opcional, até 3, separados por |): Quero ver | Agora não"
            className={inputCls}
          />
          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            Se o lead não escreveu nas últimas 24 h, mandar o modelo da Meta:
            <select
              name="templateName"
              value={d.config.templateName ?? ""}
              onChange={(e) => setConfig({ templateName: e.target.value || undefined, templateParams: undefined })}
              className={`${inputCls} w-auto!`}
            >
              <option value="">nenhum (espera o lead escrever)</option>
              {options.waTemplates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.status !== "APPROVED" ? " (aguardando a Meta)" : ""}
                </option>
              ))}
            </select>
          </label>
          {template && slots > 0 && (
            <div className="space-y-1.5 rounded-lg bg-slate-50 p-2 text-xs text-slate-600">
              <div className="whitespace-pre-line text-slate-500">{template.body}</div>
              <div className="flex flex-wrap items-center gap-2">
                No modelo, preencher:
                {params.map((p, i) => (
                  <label key={i} className="flex items-center gap-1">
                    <span className="font-mono">{`{{${i + 1}}}`}</span>=
                    <select name="templateParams" required value={p} onChange={(e) => setParam(i, e.target.value)} className={`${inputCls} w-auto! py-1`}>
                      <option value="" disabled>
                        escolha
                      </option>
                      {VARIABLES.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {d.action === "email" && (
        <select name="templateKey" required value={d.config.templateKey ?? ""} onChange={(e) => setConfig({ templateKey: e.target.value })} className={inputCls}>
          <option value="" disabled>
            Escolha o e-mail
          </option>
          {options.emails.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </select>
      )}
      {d.action === "cof" && (
        <p className="text-xs text-slate-500">
          Vai por e-mail, com o assunto COF, com os documentos que estão em Ajustes. O CRM guarda a cópia do e-mail e o lead confirma o recebimento pelo
          link. Se o lead já recebeu estes mesmos arquivos, não manda de novo.
        </p>
      )}
      {d.action === "task" && (
        <input
          name="title"
          required
          value={d.config.title ?? ""}
          onChange={(e) => setConfig({ title: e.target.value })}
          placeholder="O que o responsável deve fazer?"
          className={inputCls}
        />
      )}
      {d.action === "move" && (
        <select name="toStageId" required value={d.config.toStageId ?? ""} onChange={(e) => setConfig({ toStageId: e.target.value })} className={inputCls}>
          <option value="" disabled>
            Para qual etapa?
          </option>
          <optgroup label="Este funil">
            {sameFunnel.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === stageId}>
                {s.name}
              </option>
            ))}
          </optgroup>
          {otherFunnels.length > 0 && (
            <optgroup label="Outros funis">
              {otherFunnels.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.pipeline} › {s.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      {d.action === "ai_on" && (
        <select name="sdrId" value={d.config.sdrId ?? ""} onChange={(e) => setConfig({ sdrId: e.target.value })} className={inputCls}>
          <option value="">A SDR do lead (ou a com menos leads)</option>
          {options.sdrs.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {answer && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" name="aiReplies" checked={!!d.config.aiReplies} onChange={(e) => setConfig({ aiReplies: e.target.checked || undefined })} />
            A IA também responde a mensagem
          </label>
        )}
        {d.trigger === "enter" && later && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              name="runAfterLeaving"
              checked={d.runAfterLeaving}
              onChange={(e) => set({ runAfterLeaving: e.target.checked })}
            />
            Fazer mesmo se o lead já tiver saído da etapa
          </label>
        )}
        <div className="ml-auto flex gap-2">
          <button type="button" onClick={onDone} className={btnGhostCls}>
            Cancelar
          </button>
          <button disabled={saving} className={btnCls}>
            {saving ? "Salvando…" : rule ? "Salvar" : "Criar automação"}
          </button>
        </div>
      </div>
    </form>
  );
}
