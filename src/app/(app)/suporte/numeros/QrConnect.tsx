"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, QrCode } from "lucide-react";
import { createNumberByQrAction, numberQrAction, type QrState } from "../actions";
import { btnCls, btnGhostCls, inputCls } from "@/components/ui";

const POLL_MS = 4_000;
// WhatsApp changes the QR code every few seconds; after 3 minutes without reading, stop and offer it again
const GIVE_UP_MS = 3 * 60_000;

/** Shows the QR code and follows the reading until the number is connected. */
function QrPanel({ state, onState }: { state: QrState; onState: (s: QrState) => void }) {
  const router = useRouter();
  const [startedAt] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!state.id || state.connected || expired) return;
    const t = setTimeout(async () => {
      if (Date.now() - startedAt > GIVE_UP_MS) return setExpired(true);
      const next = await numberQrAction(state.id!);
      onState({ ...next, qr: next.qr ?? state.qr });
      if (next.connected) router.refresh();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [state, expired, startedAt, onState, router]);

  if (state.connected)
    return (
      <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
        <CheckCircle2 size={18} /> Conectado{state.phone ? ` (${state.phone})` : ""}. As mensagens deste número já chegam no Suporte.
      </div>
    );
  if (expired)
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
        O QR code expirou.
        <button type="button" className={btnGhostCls} onClick={async () => onState(await numberQrAction(state.id!, true))}>
          Gerar outro
        </button>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-4">
      {state.qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={state.qr} alt="QR code para conectar o WhatsApp" className="size-56 rounded-xl bg-white p-2 ring-1 ring-slate-200" />
      ) : (
        <div className="flex size-56 items-center justify-center rounded-xl bg-slate-100 text-sm text-slate-500">Gerando o QR code…</div>
      )}
      <ol className="max-w-xs list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>No celular do número de suporte, abra o WhatsApp.</li>
        <li>Toque em Configurações (ou nos três pontinhos) e depois em Aparelhos conectados.</li>
        <li>Toque em Conectar um aparelho e aponte para este QR code.</li>
        <li>Esta tela avisa sozinha quando conectar.</li>
      </ol>
    </div>
  );
}

export function QrNewNumber({ attendants }: { attendants: { id: string; name: string }[] }) {
  const [state, setState] = useState<QrState>({});
  const [pending, start] = useTransition();
  if (state.id)
    return (
      <div className="space-y-3">
        <QrPanel state={state} onState={setState} />
        {state.connected && (
          <button type="button" className={btnGhostCls} onClick={() => setState({})}>
            <QrCode size={16} /> Conectar outro número
          </button>
        )}
      </div>
    );
  return (
    <form action={(form) => start(async () => setState(await createNumberByQrAction(form)))} className="space-y-3">
      <label className="block space-y-1 text-xs font-medium text-slate-600">
        Nome do número
        <input name="name" required placeholder="Ex.: Suporte Seguros" className={inputCls} />
      </label>
      {attendants.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-slate-600">Quem atende este número</legend>
          <div className="flex flex-wrap gap-2">
            {attendants.map((a) => (
              <label key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                <input type="checkbox" name="attendants" value={a.id} />
                {a.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnCls} disabled={pending}>
          <QrCode size={16} /> {pending ? "Preparando…" : "Mostrar QR code"}
        </button>
        {state.error && <span className="text-sm font-medium text-red-700">{state.error}</span>}
      </div>
    </form>
  );
}

/** For a number that disconnected: a new QR code without creating anything. */
export function QrReconnect({ id }: { id: string }) {
  const [state, setState] = useState<QrState>({});
  const [pending, start] = useTransition();
  if (state.id && !state.error) return <QrPanel state={state} onState={setState} />;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={btnGhostCls} disabled={pending} onClick={() => start(async () => setState(await numberQrAction(id, true)))}>
        <QrCode size={16} /> {pending ? "Gerando…" : "Conectar com QR code"}
      </button>
      {state.error && <span className="text-sm font-medium text-red-700">{state.error}</span>}
    </div>
  );
}
