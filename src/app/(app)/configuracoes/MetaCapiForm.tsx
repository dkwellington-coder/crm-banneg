"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { btnCls, inputCls } from "@/components/ui";

export function MetaCapiForm({ configured }: { configured: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const router = useRouter();
  async function submit(action: string) {
    setBusy(true); setMessage("");
    const data = new FormData(form.current!);
    try {
      const response = await fetch("/api/meta/capi", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, datasetId: data.get("datasetId"), token: data.get("token") }) });
      const result = await response.json();
      setMessage(result.message ?? result.error);
    } catch { setMessage("Não foi possível acessar o servidor."); }
    finally { form.current?.reset(); setBusy(false); router.refresh(); }
  }
  return <form ref={form} onSubmit={e => { e.preventDefault(); void submit("save"); }} className="space-y-2">
    <p className="text-sm">{configured ? "Credenciais configuradas. Deixe o token vazio para manter o atual." : "Aguardando credenciais."}</p>
    <label className="block text-sm">META_DATASET_ID<input className={inputCls} name="datasetId" type="password" autoComplete="off" required /></label>
    <label className="block text-sm">META_CAPI_TOKEN<input className={inputCls} name="token" type="password" autoComplete="new-password" /></label>
    <div className="flex gap-2"><button className={btnCls} disabled={busy}>Salvar</button>
      <button type="button" className={btnCls} disabled={busy || !configured} onClick={() => void submit("test")}>Testar envio</button></div>
    <p role="status" className="text-sm">{message}</p>
  </form>;
}
