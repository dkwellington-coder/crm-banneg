"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { btnGhostCls } from "@/components/ui";

/** The form's button, saying "Salvando…" while it goes and "Salvo" for a moment after, so a click never looks lost. */
export function SaveButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  const [saved, setSaved] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !pending) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 3000);
      was.current = pending;
      return () => clearTimeout(t);
    }
    was.current = pending;
  }, [pending]);
  return (
    <button disabled={pending} className={`${btnGhostCls} disabled:opacity-60`}>
      {pending ? "Salvando…" : saved ? "Salvo ✓" : label}
    </button>
  );
}
