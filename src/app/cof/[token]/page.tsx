import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { after, connection } from "next/server";
import { cofByToken, cofDeadline, dateTimeBr, markCofOpened, sizeLabel, type CofDoc } from "@/lib/cof";
import { getSettings } from "@/lib/settings";
import { confirmCofAction } from "./actions";

export const metadata: Metadata = { title: "Circular de Oferta de Franquia", robots: { index: false, follow: false } };

export default function CofPage({ params }: PageProps<"/cof/[token]">) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-brand p-4 sm:items-center">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl sm:p-8">
        <div className="mb-6">
          <div className="text-2xl font-black tracking-widest text-brand">BANNEG /</div>
          <div className="text-xs font-semibold tracking-widest text-slate-500">CIRCULAR DE OFERTA DE FRANQUIA</div>
        </div>
        <Suspense fallback={<p className="text-sm text-slate-500">Carregando…</p>}>
          <CofView params={params} />
        </Suspense>
      </div>
    </div>
  );
}

async function CofView({ params }: { params: PageProps<"/cof/[token]">["params"] }) {
  const { token } = await params;
  await connection();
  const [delivery, settings] = await Promise.all([cofByToken(token), getSettings()]);
  if (!delivery) notFound();
  after(() => markCofOpened(token, "page"));
  const docs = delivery.documents as CofDoc[];
  const firstName = delivery.lead.name?.split(" ")[0];
  const confirm = confirmCofAction.bind(null, token);

  return (
    <div className="space-y-5 text-slate-700">
      <p>
        Olá{firstName ? `, ${firstName}` : ""}! Aqui estão os documentos da franquia {settings.companyName} enviados para você em{" "}
        {dateTimeBr(delivery.sentAt)}.
      </p>
      <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
        {docs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-semibold text-slate-900">{d.name}</div>
              <div className="text-xs text-slate-500">{sizeLabel(d.size)}</div>
            </div>
            <a href={`/api/cof/${token}/doc/${d.id}`} className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white">
              Baixar
            </a>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-500">
        Pela Lei de Franquias (Lei 13.966/2019), você recebe a Circular de Oferta de Franquia pelo menos 10 dias antes de assinar o contrato ou fazer
        qualquer pagamento, para ler com calma e tirar suas dúvidas.
      </p>
      {delivery.confirmedAt ? (
        <div className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">
          Recebimento confirmado em {dateTimeBr(delivery.confirmedAt)}. Obrigado! Os 10 dias para leitura vão até{" "}
          {dateTimeBr(cofDeadline(delivery)).slice(0, 10)}.
        </div>
      ) : (
        <form action={confirm}>
          <button className="w-full rounded-xl bg-brand px-4 py-3 font-bold text-white">Confirmo que recebi a COF e os documentos</button>
        </form>
      )}
      <p className="text-xs text-slate-400">Dúvidas? É só responder o e-mail que você recebeu.</p>
    </div>
  );
}
