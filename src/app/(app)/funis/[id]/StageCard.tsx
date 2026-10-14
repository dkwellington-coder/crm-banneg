"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Bot,
  CalendarClock,
  CheckSquare,
  Clock,
  Hourglass,
  Mail,
  MessageCircle,
  Pause,
  Pencil,
  Plus,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { actionLabel, triggerLabel } from "@/lib/rules";
import { deleteRuleAction, deleteStageAction, moveStageAction, toggleRuleAction, updateStageAction } from "../../../actions";
import { RuleEditor, type EditorOptions, type RuleData } from "./RuleEditor";

export type StageData = {
  id: string;
  name: string;
  color: string;
  kind: "OPEN" | "WON" | "LOST";
  aiKey: string | null;
  leads: number;
  rules: RuleData[];
};

export const ACTION_ICON: Record<string, LucideIcon> = {
  whatsapp: MessageCircle,
  email: Mail,
  task: CheckSquare,
  move: ArrowRightLeft,
  ai_on: Bot,
  ai_off: Pause,
};

const ACTION_TINT: Record<string, string> = {
  whatsapp: "bg-emerald-50 text-emerald-700",
  email: "bg-sky-50 text-sky-700",
  task: "bg-amber-50 text-amber-700",
  move: "bg-violet-50 text-violet-700",
  ai_on: "bg-indigo-50 text-indigo-700",
  ai_off: "bg-slate-100 text-slate-600",
};

const iconBtn = "rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30";

export function StageCard({
  stage,
  index,
  isFirst,
  isLast,
  options,
  canEdit,
}: {
  stage: StageData;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  options: EditorOptions;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [dirty, setDirty] = useState(false);
  const names = {
    stages: Object.fromEntries(options.stages.map((s) => [s.id, s.same ? s.name : `${s.pipeline} › ${s.name}`])),
    emails: Object.fromEntries(options.emails.map((e) => [e.key, e.name])),
  };

  return (
    <li className="relative pl-12">
      {/* Timeline */}
      <span
        className="absolute left-0 top-4 flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold text-white shadow ring-4 ring-[var(--background)]"
        style={{ background: stage.color }}
      >
        {index + 1}
      </span>
      {!isLast && <span className="absolute bottom-[-18px] left-[15px] top-12 w-0.5 bg-slate-200" />}

      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <form
          action={async (fd) => {
            await updateStageAction(stage.id, fd);
            setDirty(false);
          }}
          onChange={() => setDirty(true)}
          className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3"
          style={{ borderLeft: `4px solid ${stage.color}` }}
        >
          <input
            type="color"
            name="color"
            defaultValue={stage.color}
            disabled={!canEdit}
            className="h-7 w-7 shrink-0 cursor-pointer rounded-md border border-slate-200 bg-white p-0.5"
            title="Cor da etapa"
          />
          <input
            name="name"
            defaultValue={stage.name}
            disabled={!canEdit}
            className="min-w-40 flex-1 rounded-md border border-transparent px-1.5 py-1 text-base font-semibold outline-none hover:border-slate-200 focus:border-brand"
          />
          <select
            name="kind"
            defaultValue={stage.kind}
            disabled={!canEdit}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600"
          >
            <option value="OPEN">Em andamento</option>
            <option value="WON">Ganho (conta na meta)</option>
            <option value="LOST">Perdido</option>
          </select>
          {stage.aiKey && (
            <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700" title="A SDR de IA move leads para esta etapa">
              <Bot size={12} /> usada pela IA
            </span>
          )}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{stage.leads} {stage.leads === 1 ? "lead" : "leads"}</span>
          {dirty && <button className="rounded-md bg-brand px-3 py-1 text-xs font-semibold text-white">Salvar</button>}
          {canEdit && (
            <div className="ml-auto flex items-center">
              <button type="button" className={iconBtn} disabled={isFirst} onClick={() => moveStageAction(stage.id, -1)} title="Subir">
                <ArrowUp size={16} />
              </button>
              <button type="button" className={iconBtn} disabled={isLast} onClick={() => moveStageAction(stage.id, 1)} title="Descer">
                <ArrowDown size={16} />
              </button>
              {!stage.aiKey && (
                <button
                  type="button"
                  className={`${iconBtn} hover:bg-red-50 hover:text-red-600`}
                  title="Excluir etapa"
                  onClick={() => {
                    const msg = stage.leads
                      ? `Excluir "${stage.name}"? Os ${stage.leads} leads dela vão para a primeira etapa do funil.`
                      : `Excluir "${stage.name}"?`;
                    if (confirm(msg)) deleteStageAction(stage.id);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          )}
        </form>

        <div className="space-y-2 p-3">
          {stage.rules.length === 0 && editing !== "new" && (
            <p className="px-1 text-sm text-slate-400">Nenhuma automação nesta etapa.</p>
          )}
          {stage.rules.map((r) =>
            editing === r.id ? (
              <RuleEditor key={r.id} stageId={stage.id} rule={r} options={options} onDone={() => setEditing(null)} />
            ) : (
              <RuleRow
                key={r.id}
                rule={r}
                label={actionLabel(r.action, r.config, names)}
                canEdit={canEdit}
                onEdit={() => setEditing(r.id)}
              />
            ),
          )}
          {editing === "new" ? (
            <RuleEditor stageId={stage.id} options={options} onDone={() => setEditing(null)} />
          ) : (
            canEdit && (
              <button
                onClick={() => setEditing("new")}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2 text-sm font-medium text-slate-500 transition hover:border-brand hover:bg-brand-soft hover:text-brand"
              >
                <Plus size={16} /> Adicionar automação
              </button>
            )
          )}
        </div>
      </div>
    </li>
  );
}

function RuleRow({ rule, label, canEdit, onEdit }: { rule: RuleData; label: string; canEdit: boolean; onEdit: () => void }) {
  const Icon = ACTION_ICON[rule.action] ?? Zap;
  const TriggerIcon = rule.trigger === "idle" ? Hourglass : rule.trigger === "daily" ? CalendarClock : Clock;
  return (
    <div className={`group flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2 ${rule.active ? "" : "opacity-50"}`}>
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => toggleRuleAction(rule.id)}
        title={rule.active ? "Desligar" : "Ligar"}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${rule.active ? "bg-emerald-500" : "bg-slate-300"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${rule.active ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
        <TriggerIcon size={13} /> {triggerLabel(rule.trigger, rule.delayMinutes, rule.config)}
      </span>
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${ACTION_TINT[rule.action] ?? ""}`}>
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-slate-800" title={label}>
        {label}
        {rule.runAfterLeaving && <span className="ml-2 text-xs text-slate-400">(mesmo se sair da etapa)</span>}
      </span>
      {canEdit && (
        <div className="flex shrink-0 opacity-0 transition group-hover:opacity-100">
          <button className={iconBtn} onClick={onEdit} title="Editar">
            <Pencil size={15} />
          </button>
          <button
            className={`${iconBtn} hover:bg-red-50 hover:text-red-600`}
            title="Excluir"
            onClick={() => confirm("Excluir esta automação?") && deleteRuleAction(rule.id)}
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

