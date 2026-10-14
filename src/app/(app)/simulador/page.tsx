import { Suspense } from "react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Loading, PageHeader } from "@/components/ui";
import { Simulator } from "./Simulator";

export default function SimuladorPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Simulador da SDR"
        subtitle="Converse como se fosse um lead e veja o que a Duda ou a Alice responderiam e fariam. Nada é enviado e nenhum lead é criado."
      />
      <Suspense fallback={<Loading />}>
        <Loader />
      </Suspense>
    </div>
  );
}

async function Loader() {
  await requireUser();
  const [agents, settings, knowledge] = await Promise.all([
    db.sdrAgent.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getSettings(),
    db.knowledgeItem.count(),
  ]);
  return (
    <Simulator
      agents={agents}
      company={settings.companyName}
      questions={settings.qualificationQuestions}
      qualifyScore={settings.qualifyScore}
      knowledgeCount={knowledge}
      aiReady={!!process.env.ANTHROPIC_API_KEY}
    />
  );
}
