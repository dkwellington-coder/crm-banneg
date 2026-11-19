import { Suspense } from "react";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { supportViewer } from "@/lib/support-access";
import { Card, Loading, PageHeader, relTime } from "@/components/ui";
import { phoneLabel, StatusDot, SupportTabs } from "../parts";
import { AttendantForm, NumberActions, NumberForm } from "./forms";
import { QrNewNumber, QrReconnect } from "./QrConnect";
import { canCreateInstances } from "@/lib/support";

export default function NumerosPage() {
  return (
    <>
      <PageHeader title="Suporte" subtitle="Os números de suporte (cada um numa instância da Uazapi) e as pessoas que atendem." />
      <Suspense fallback={<Loading />}>
        <Setup />
      </Suspense>
    </>
  );
}

async function Setup() {
  const viewer = await supportViewer();
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
