"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnCls } from "@/components/ui";

// Under Vercel's 4.5 MB limit per request
const CHUNK = 3 * 1024 * 1024;

async function call(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}`);
  return body;
}

/** Sends the COF, balance sheets and contract in pieces, with progress, and refreshes the list. */
export function CofUpload() {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(files: FileList) {
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const { id } = await call("/api/documentos?step=start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, mimeType: file.type, size: file.size }),
        });
        for (let at = 0; at < file.size; at += CHUNK) {
          setStatus(`Enviando ${file.name}: ${Math.round((at / file.size) * 100)}%`);
          await call(`/api/documentos?step=chunk&id=${id}`, { method: "POST", body: file.slice(at, at + CHUNK) });
        }
        await call(`/api/documentos?step=finish&id=${id}`, { method: "POST" });
      }
      setStatus("Pronto: os arquivos já vão na próxima COF.");
      router.refresh();
    } catch (e) {
      setStatus(`Não deu certo: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="space-y-1">
      <input ref={input} type="file" multiple hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.zip" onChange={(e) => e.target.files?.length && upload(e.target.files)} />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className={btnCls}>
        {busy ? "Enviando…" : "Subir documentos"}
      </button>
      {status && <p className="text-xs text-slate-500">{status}</p>}
    </div>
  );
}
