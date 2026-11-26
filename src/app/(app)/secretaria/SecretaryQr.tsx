"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, QrCode } from "lucide-react";
import { connectSecretaryAction, secretaryQrAction } from "./actions";
import { btnCls, btnGhostCls } from "@/components/ui";

type Step = { connected: boolean; phone?: string | null; qr?: string | null; error?: string };

const POLL_MS = 4_000;
// WhatsApp changes the QR code every few seconds; after 3 minutes without reading, stop and offer it again
const GIVE_UP_MS = 3 * 60_000;

/** The QR code of the secretary's chip, followed until it connects. */
export function SecretaryQr({ label, fresh = false }: { label: string; fresh?: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [expired, setExpired] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!step || step.connected || step.error || expired) return;
    const t = setTimeout(async () => {
      if (Date.now() - startedAt > GIVE_UP_MS) return setExpired(true);
      const next = await secretaryQrAction();
      setStep({ ...next, qr: next.qr ?? step.qr });
      if (next.connected) router.refresh();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [step, expired, startedAt, router]);

  const begin = () =>
    start(async () => {
      setExpired(false);
      setStartedAt(Date.now());
      setStep(await connectSecretaryAction(fresh));
    });

  if (step?.connected)
    return (
      <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
        <CheckCircle2 size={18} /> Conectado{step.phone ? ` (${step.phone})` : ""}. Agora coloque o número dela no grupo pelo celular e escolha o grupo abaixo.
      </div>
    );
  if (!step || step.error || expired)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={step || fresh ? btnGhostCls : btnCls} disabled={pending} onClick={begin}>
          <QrCode size={16} /> {pending ? "Gerando…" : expired ? "O QR code expirou: gerar outro" : label}
        </button>
        {step?.error && <span className="text-sm font-medium text-red-700">{step.error}</span>}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-4">
      {step.qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={step.qr} alt="QR code para conectar o WhatsApp" className="size-56 rounded-xl bg-white p-2 ring-1 ring-slate-200" />
      ) : (
        <div className="flex size-56 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">Gerando o QR code…</div>
      )}
      <ol className="max-w-xs list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>No celular do chip da secretária, abra o WhatsApp.</li>
        <li>Toque em Configurações (ou nos três pontinhos) e depois em Aparelhos conectados.</li>
        <li>Toque em Conectar um aparelho e aponte para este QR code.</li>
        <li>Esta tela avisa sozinha quando conectar.</li>
      </ol>
    </div>
  );
}
