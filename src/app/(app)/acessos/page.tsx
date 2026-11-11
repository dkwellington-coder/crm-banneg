import { Suspense } from "react";
import { requireOwnerPage, AREAS } from "@/lib/access";
import { db } from "@/lib/db";
import { Card, Loading, PageHeader } from "@/components/ui";
import { AccessForm } from "./AccessForm";

export default function AcessosPage() {
  return (
    <>
      <PageHeader title="Acessos" subtitle="Quem entra no CRM: usuário, senha e as telas que cada pessoa pode abrir." />
      <Suspense fallback={<Loading />}>
        <Accesses />
      </Suspense>
    </>
  );
}

const LOGIN_URL = `${(process.env.PUBLIC_BASE_URL ?? "https://crm-banneg-banneg.vercel.app").replace(/\/$/, "")}/login`;

async function Accesses() {
  const me = await requireOwnerPage();
  const users = await db.user.findMany({
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, role: true, calendarId: true, areas: true },
  });
  const areas = AREAS.map(({ key, label, hint }) => ({ key, label, hint }));
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 md:px-6">
      <Card className="space-y-3">
        <div>
          <h2 className="font-bold">Novo acesso</h2>
          <p className="text-sm text-slate-500">
            O usuário é o e-mail da pessoa. Depois de criar, copie os dados e mande para ela. A senha não fica visível depois: para trocar, dê uma nova.
          </p>
        </div>
        <AccessForm areas={areas} loginUrl={LOGIN_URL} />
      </Card>
      {users.map((u) => (
        <Card key={u.id}>
          <AccessForm user={u} isMe={u.id === me.id} areas={areas} loginUrl={LOGIN_URL} />
        </Card>
      ))}
    </div>
  );
}
