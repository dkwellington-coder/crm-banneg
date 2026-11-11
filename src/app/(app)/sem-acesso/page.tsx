import { Suspense } from "react";
import { requireUser } from "@/lib/auth";
import { Card, Loading, PageHeader } from "@/components/ui";

export default function SemAcessoPage() {
  return (
    <>
      <PageHeader title="Sem acesso" />
      <Suspense fallback={<Loading />}>
        <NoAccess />
      </Suspense>
    </>
  );
}

/** Someone whose screens were all taken away in Acessos lands here instead of a loop of redirects. */
async function NoAccess() {
  const user = await requireUser();
  return (
    <div className="px-4 md:px-6">
      <Card className="max-w-lg text-sm text-slate-600">
        Olá, {user.name.split(" ")[0]}. Seu usuário ainda não tem nenhuma tela liberada no CRM. Peça ao responsável para liberar em Acessos.
      </Card>
    </div>
  );
}
