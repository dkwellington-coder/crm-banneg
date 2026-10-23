"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip } from "lucide-react";
import { btnCls, btnGhostCls } from "./ui";

// Under Vercel's 4.5 MB limit per request, as the COF upload
const CHUNK = 3 * 1024 * 1024;

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}`);
  return body;
}

/** Sends a lead's policy in pieces, with progress. Without onDone the page reloads to list it. */
export function ApoliceUpload({ leadId, onDone, primary }: { leadId: string; onDone?: () => void; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  // Kept apart from the progress line, in red, so a refused file is not missed
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/leads/${encodeURIComponent(leadId)}/documentos`;
  // Closed in the middle (Cancelar): the file still lands on the lead, but the move it was for does not happen
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await call(`${base}?step=start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, mimeType: file.type, size: file.size }),
      });
      for (let at = 0; at < file.size; at += CHUNK) {
        setStatus(`Enviando ${file.name}: ${Math.round((at / file.size) * 100)}%`);
        await call(`${base}?step=chunk&id=${id}`, { method: "POST", body: file.slice(at, at + CHUNK) });
      }
      await call(`${base}?step=finish&id=${id}`, { method: "POST" });
      setStatus("Documento anexado.");
      if (!onDone) router.refresh();
      else if (mounted.current) onDone();
    } catch (e) {
      setStatus(null);
      setError(`Não deu certo: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1">
      <input
        ref={input}
        type="file"
        hidden
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className={primary ? btnCls : btnGhostCls}>
        <Paperclip size={15} /> {busy ? "Enviando…" : "Anexar apólice ou contrato"}
      </button>
      {status && <p className="text-xs text-slate-500">{status}</p>}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
