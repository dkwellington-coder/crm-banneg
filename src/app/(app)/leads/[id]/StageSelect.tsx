"use client";

import { useTransition } from "react";
import { moveLeadAction } from "../../../actions";
import { inputCls } from "@/components/ui";

export function StageSelect({ leadId, stageId, stages }: { leadId: string; stageId: string; stages: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  return (
    <select
      defaultValue={stageId}
      disabled={pending}
      className={`${inputCls} font-semibold`}
      onChange={(e) => {
        const to = e.target.value;
        start(() => moveLeadAction(leadId, to));
      }}
    >
      {stages.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
