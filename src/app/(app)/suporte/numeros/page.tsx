import { Suspense } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { supportViewer } from "@/lib/support-access";
import { btnCls, Card, Loading, PageHeader, relTime } from "@/components/ui";
import { phoneLabel, StatusDot, SupportTabs } from "../parts";
import { AttendantForm, NumberActions, NumberForm } from "./forms";
import { QrNewNumber, QrReconnect } from "./QrConnect";
import { canCreateInstances } from "@/lib/support";
import { driveSummary } from "@/lib/support-drive";
import { disconnectDriveAction } from "../actions";
import { HardDrive } from "lucide-react";

export default function NumerosPage({ searchParams }: PageProps<"/suporte/numeros">) {
  return (
    <>
      <PageHeader title="Suporte" subtitle="Os números de suporte, conectados pelo QR code, e as pessoas que atendem." />
      <Suspense fallback={<Loading />}>
        <Setup searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Setup({ searchParams }: { searchParams: PageProps<"/suporte/numeros">["searchParams"] }) {
  const [viewer, sp] = await Promise.all([supportViewer(), searchParams]);
  if (!viewer.owner) redirect("/suporte");
  const [numbers, attendants, users] = await Promise.all([
    db.supportNumber.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], include: { attendants: { select: { id: true, name: true } }, _count: { select: { chats: true } } } }),
    db.supportAttendant.findMany({ where: { active: true }, orderBy: { name: "asc" }, include: { numbers: { select: { id: true } } } }),
    db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const qr = canCreateInstances();
  const attendantOptions = attendants.map((a) => ({ id: a.id, name: a.name }));
  const numberOptions = numbers.filter((n) => n.active).map((n) => ({ id: n.id, name: n.name }));
  return (
    <div className="space-y-6 px-4 pb-6 md:px-6">
      <SupportTabs active="numeros" monitor owner />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Números de suporte</h2>
        {numbers.map((n) => (
          <Card key={n.id} className={n.active ? "" : "opacity-60"}>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">{n.name}</span>
              {n.phone && <span className="text-sm text-slate-500">{phoneLabel(n.phone)}</span>}
              {n.active ? <StatusDot status={n.status} /> : <span className="text-xs font-medium text-slate-500">Desligado do CRM</span>}
              <span className="text-xs text-slate-400">
                {n._count.chats} conversa(s){n.statusAt ? ` · verificado ${relTime(n.statusAt)}` : ""}
              </span>
            </div>
            <details>
              <summary className="mb-2 cursor-pointer text-sm font-medium text-brand">Editar</summary>
              <NumberForm number={{ id: n.id, name: n.name, server: n.server, attendantIds: n.attendants.map((a) => a.id) }} attendants={attendantOptions} />
            </details>
            <div className="mt-2 space-y-2">
              <NumberActions id={n.id} active={n.active} />
              {n.active && n.status !== "connected" && <QrReconnect id={n.id} />}
              {n.active && n.status === "connected" && qr && <QrReconnect id={n.id} fresh />}
            </div>
          </Card>
        ))}
        <Card>
          <h3 className="mb-1 font-semibold">Conectar um número</h3>
          {qr ? (
            <>
              <p className="mb-3 text-sm text-slate-600">Dê um nome, marque quem atende e leia o QR code com o celular do número. Pronto: o que ele mandar e receber passa a chegar aqui.</p>
              <QrNewNumber attendants={attendantOptions} />
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-brand">Já tenho a instância na Uazapi: colar o token</summary>
                <div className="mt-3">
                  <NumberForm attendants={attendantOptions} />
                </div>
              </details>
            </>
          ) : (
            <>
              <ol className="mb-3 list-decimal space-y-0.5 pl-5 text-sm text-slate-600">
                <li>No painel da Uazapi, crie uma instância para o número e leia o QR code com o WhatsApp dele.</li>
                <li>Copie o token da instância e cole aqui.</li>
                <li>O CRM confere a conexão e passa a receber tudo o que esse número manda e recebe.</li>
              </ol>
              <NumberForm attendants={attendantOptions} />
            </>
          )}
        </Card>
      </section>

      <DriveCard result={typeof sp.drive === "string" ? sp.drive : null} detail={typeof sp.detalhe === "string" ? sp.detalhe : null} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Atendentes</h2>
        {attendants.map((a) => (
          <Card key={a.id}>
            <AttendantForm
              attendant={{ id: a.id, name: a.name, userId: a.userId, workDays: a.workDays, workStart: a.workStart, workEnd: a.workEnd, numberIds: a.numbers.map((x) => x.id) }}
              users={users}
              numbers={numberOptions}
            />
          </Card>
        ))}
        <Card>
          <h3 className="mb-3 font-semibold">Incluir atendente</h3>
          <AttendantForm users={users} numbers={numberOptions} />
        </Card>
      </section>
    </div>
  );
}

/** Where the files of the support numbers are kept: the WhatsApp server's disk, with a copy in the Google Drive. */
async function DriveCard({ result, detail }: { result: string | null; detail: string | null }) {
  const d = await driveSummary();
  const n = (v: number) => v.toLocaleString("pt-BR");
  return (
    <section id="drive" className="space-y-3">
      <h2 className="text-lg font-semibold">Arquivos (áudios, fotos, PDFs, vídeos)</h2>
      <Card>
        <div className="flex items-start gap-3">
          <HardDrive className="mt-0.5 shrink-0 text-gold" size={22} />
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <p className="text-slate-600">
              Cada arquivo que os números de suporte mandam ou recebem fica guardado no servidor do WhatsApp e ganha uma cópia no Google Drive, na pasta{" "}
              <b>Banneg Suporte</b>, separada por número e por mês.
            </p>
            {result === "ok" && <p className="font-medium text-emerald-700">Google Drive conectado{detail ? ` (${detail})` : ""}. As cópias começam no próximo minuto.</p>}
            {result === "erro" && <p className="font-medium text-red-700">Não conectou: {detail ?? "tente de novo"}.</p>}
            {result === "recusado" && <p className="font-medium text-amber-700">A permissão foi recusada no Google. Clique em conectar de novo e permita o acesso ao Drive.</p>}
            {d.email ? (
              <>
                <p>
                  <span className="font-medium text-emerald-700">Copiando para o Drive de {d.email}.</span> {n(d.copied)} arquivo(s) copiado(s)
                  {d.waiting ? `, ${n(d.waiting)} na fila` : ""}
                  {d.downloading ? `, ${n(d.downloading)} baixando do WhatsApp` : ""}.
                </p>
                {d.failed > 0 && <p className="text-red-700">{n(d.failed)} arquivo(s) não foram para o Drive depois de várias tentativas. Eles continuam no servidor.</p>}
                {d.lost > 0 && <p className="text-amber-700">{n(d.lost)} arquivo(s) o WhatsApp não entregou (antigos demais ou apagados no celular).</p>}
                <form action={disconnectDriveAction}>
                  <button className="text-xs font-medium text-slate-500 underline">Parar as cópias no Drive</button>
                </form>
              </>
            ) : (
              <>
                <p className="text-amber-700">
                  O Google Drive ainda não está conectado: os arquivos ficam só no servidor{d.waiting ? ` (${n(d.waiting)} esperando a cópia)` : ""}.
                </p>
                <a href="/api/suporte/drive/conectar" className={btnCls}>
                  Conectar o Google Drive
                </a>
              </>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
