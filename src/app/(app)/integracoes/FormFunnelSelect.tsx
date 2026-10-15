"use client";

import { useTransition } from "react";
import { setFormFunnelAction } from "../../actions";

/** The funnel a Facebook or Instagram form feeds; saved as soon as it changes. */
export function FormFunnelSelect({
  formId,
  value,
  automatic,
  funnels,
}: {
  formId: string;
  // The funnel chosen by hand, or "" when the form name decides
  value: string;
  // The funnel the form name points to, shown on the "automático" option
  automatic: string;
  funnels: { slug: string; name: string }[];
}) {
  const [saving, start] = useTransition();
  return (
    <select
      defaultValue={value}
      disabled={saving}
      onChange={(e) => {
        const fd = new FormData();
        fd.set("funnel", e.target.value);
        start(() => setFormFunnelAction(formId, fd));
      }}
      className="shrink-0 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-600"
    >
      <option value="">Pelo nome: {automatic}</option>
      {funnels.map((f) => (
        <option key={f.slug} value={f.slug}>
          {f.name}
        </option>
      ))}
    </select>
  );
}
