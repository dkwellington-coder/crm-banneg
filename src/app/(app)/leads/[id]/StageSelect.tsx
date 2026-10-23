"use client";

import { useState, useTransition } from "react";
import type { StageKind } from "@prisma/client";
import { moveLeadAction } from "../../../actions";
import { inputCls } from "@/components/ui";
import { StageMoveDialog, type StageAsk } from "@/components/StageMoveDialog";
import { closesReferral } from "@/lib/portal-status";
import type { ReopenChoice } from "@/lib/stage-move";

type StageOption = { id: string; name: string; pipeline: string; kind: StageKind; key: string | null };

export function StageSelect({ leadId, lead, stageId, stages }: { leadId: string; lead: string; stageId: string; stages: StageOption[] }) {
  const [pending, start] = useTransition();
  // Shows the chosen stage while the window asks for the reason, the policy or what happened to the sale; back to the
  // lead's stage when refused
  const [value, setValue] = useState(stageId);
  const [ask, setAsk] = useState<StageAsk | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function askFor(to: string, need: StageAsk["need"]): StageAsk {
    const stage = stages.find((s) => s.id === to);
    return { leadId, lead, to, stage: stage?.name ?? "", need, storeSees: !!stage && closesReferral(stage) };
  }

  function send(to: string, reason?: string, reopen?: ReopenChoice) {
    start(async () => {
      try {
        const res = await moveLeadAction(leadId, to, reason, reopen);
        if (res.need) {
          // The select is locked while a move is on its way, so no other window should be open; never replace one
          const asked = askFor(to, res.need);
          setAsk((cur) => cur ?? asked);
        } else if (res.error) {
          setValue(stageId);
          setNotice(res.error);
        }
      } catch {
        setValue(stageId);
        setNotice("Não deu para mudar a etapa. Tente de novo.");
      }
    });
  }

  return (
    <div className="space-y-1">
      <select
        value={value}
        disabled={pending}
        className={`${inputCls} font-semibold`}
        onChange={(e) => {
          const to = e.target.value;
          setValue(to);
          setNotice(null);
          if (stages.find((s) => s.id === to)?.kind === "LOST") setAsk(askFor(to, "reason"));
          else send(to);
        }}
      >
        {[...new Set(stages.map((s) => s.pipeline))].map((p) => (
          <optgroup key={p} label={`Funil ${p}`}>
            {stages
              .filter((s) => s.pipeline === p)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {notice && (
        <p role="alert" className="text-xs text-red-600">
          {notice}
        </p>
      )}
      {ask && (
        <StageMoveDialog
          ask={ask}
          onReason={(reason) => {
            setAsk(null);
            send(ask.to, reason);
          }}
          onUploaded={() => {
            setAsk(null);
            send(ask.to);
          }}
          onReopen={(choice) => {
            setAsk(null);
            send(ask.to, undefined, choice);
          }}
          onCancel={() => {
            setAsk(null);
            setValue(stageId);
          }}
        />
      )}
    </div>
  );
}
