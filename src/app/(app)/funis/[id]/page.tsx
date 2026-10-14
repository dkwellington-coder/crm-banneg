import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Sparkles, Star } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Loading, btnGhostCls } from "@/components/ui";
import type { RuleConfig } from "@/lib/rules";
import { renamePipelineAction, setDefaultPipelineAction } from "../../../actions";
import { StageCard, type StageData } from "./StageCard";
import { AddStageForm, DeletePipelineButton } from "./PipelineControls";

export default function FunilEditorPage({ params }: PageProps<"/funis/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Editor params={params} />
    </Suspense>
  );
}

async function Editor({ params }: { params: PageProps<"/funis/[id]">["params"] }) {
  const user = await requireUser();
  const { id } = await params;
  const pipeline = await db.pipeline.findUnique({
    where: { id },
    include: {
      stages: {
        orderBy: { position: "asc" },
        include: { rules: { orderBy: [{ position: "asc" }, { createdAt: "asc" }] }, _count: { select: { leads: true } } },
      },
      _count: { select: { leads: true } },
    },
  });
  if (!pipeline) notFound();
  const [allStages, emails, sdrs] = await Promise.all([
    db.stage.findMany({ orderBy: [{ pipeline: { position: "asc" } }, { position: "asc" }], include: { pipeline: { select: { name: true } } } }),
    db.emailTemplate.findMany({ where: { active: true }, orderBy: { key: "asc" }, select: { key: true, name: true } }),
    db.sdrAgent.findMany({ where: { active: true }, select: { id: true, name: true } }),
  ]);
  const canEdit = user.role !== "SELLER";
  const options = {
    stages: allStages.map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline.name, same: s.pipelineId === pipeline.id })),
    emails,
    sdrs,
  };
  const stages: StageData[] = pipeline.stages.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    kind: s.kind,
    aiKey: s.key,
    leads: s._count.leads,
    rules: s.rules.map((r) => ({
      id: r.id,
      trigger: r.trigger as "enter" | "idle",
      delayMinutes: r.delayMinutes,
      action: r.action,
      config: r.config as RuleConfig,
      runAfterLeaving: r.runAfterLeaving,
      active: r.active,
    })),
  }));
  const ruleCount = stages.reduce((n, s) => n + s.rules.filter((r) => r.active).length, 0);

  return (
    <div className="mx-auto max-w-4xl px-6 pb-16 pt-6">
      <Link href={`/funil?f=${pipeline.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft size={15} /> Voltar para o funil
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <form action={renamePipelineAction.bind(null, pipeline.id)} className="min-w-0 flex-1">
          <input
            name="name"
            defaultValue={pipeline.name}
            disabled={!canEdit}
            className="w-full rounded-lg border border-transparent bg-transparent px-1 text-[26px] font-bold tracking-tight outline-none hover:border-slate-200 focus:border-brand focus:bg-white"
          />
        </form>
        {pipeline.isDefault ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
            <Star size={13} fill="currentColor" /> Funil padrão dos leads novos
          </span>
        ) : (
          canEdit && (
            <form action={setDefaultPipelineAction.bind(null, pipeline.id)}>
              <button className={btnGhostCls}>
                <Star size={15} /> Tornar padrão
              </button>
            </form>
          )
        )}
        {canEdit && !pipeline.isDefault && pipeline._count.leads === 0 && <DeletePipelineButton pipelineId={pipeline.id} />}
      </div>
      <div className="mt-4 flex items-start gap-3 rounded-2xl bg-gradient-to-r from-brand to-[#1f4fa8] p-4 text-white shadow">
        <Sparkles size={20} className="mt-0.5 shrink-0" />
        <div className="text-sm">
          <div className="font-semibold">
            {stages.length} etapas · {ruleCount} automações ligadas
          </div>
          <div className="text-white/80">
            Cada etapa tem as suas automações. Quando o lead entra nela, ou para de responder, o CRM faz o que você escolher: manda WhatsApp,
            e-mail, cria tarefa, move de etapa ou liga a SDR de IA. Clique no nome da etapa ou do funil para renomear.
          </div>
        </div>
      </div>

      <ol className="relative mt-6 space-y-4">
        {stages.map((s, i) => (
          <StageCard key={s.id} stage={s} index={i} isFirst={i === 0} isLast={i === stages.length - 1} options={options} canEdit={canEdit} />
        ))}
      </ol>
      {canEdit && <AddStageForm pipelineId={pipeline.id} />}
    </div>
  );
}
