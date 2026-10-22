import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { ArrowLeft, Bot, MessageCircle, Sparkles, Star } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Loading, btnCls, btnGhostCls, inputCls } from "@/components/ui";
import type { RuleConfig, RuleTrigger } from "@/lib/rules";
import { refreshWhatsAppNumbers, savedWhatsAppNumbers } from "@/lib/whatsapp";
import { renamePipelineAction, savePipelineAiAction, savePipelineWhatsAppAction, setDefaultPipelineAction } from "../../../actions";
import { StageCard, type StageData } from "./StageCard";
import { AddStageForm, DeletePipelineButton } from "./PipelineControls";

export default function FunilEditorPage({ params }: PageProps<"/funis/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <Editor params={params} />
    </Suspense>
  );
}

const HOUR = 3600_000;

/** The WhatsApp account's numbers: read from Meta on the first visit (waiting a moment at most), refreshed after the page when old. */
async function accountNumbers() {
  const saved = await savedWhatsAppNumbers();
  if (!saved) return Promise.race([refreshWhatsAppNumbers(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
  if (Date.now() - Date.parse(saved.at) > HOUR) after(() => refreshWhatsAppNumbers({ ifOlderThanMs: HOUR }));
  return saved;
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
      sdr: { select: { id: true, name: true, active: true } },
    },
  });
  if (!pipeline) notFound();
  const [allStages, emails, sdrs, waTemplates, pipelines, numbers] = await Promise.all([
    db.stage.findMany({ orderBy: [{ pipeline: { position: "asc" } }, { position: "asc" }], include: { pipeline: { select: { name: true } } } }),
    db.emailTemplate.findMany({ where: { active: true }, orderBy: { key: "asc" }, select: { key: true, name: true } }),
    db.sdrAgent.findMany({ where: { active: true }, select: { id: true, name: true } }),
    db.whatsAppTemplate.findMany({ orderBy: { name: "asc" }, select: { name: true, status: true, body: true } }),
    db.pipeline.findMany({ where: { id: { not: id } }, orderBy: { position: "asc" }, select: { id: true, name: true } }),
    accountNumbers(),
  ]);
  const canEdit = user.role !== "SELLER";
  const mainId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const mainNumber = numbers?.numbers.find((n) => n.id === mainId);
  const ownNumbers = numbers?.numbers.filter((n) => n.id !== mainId) ?? [];
  // A number saved before the list was lost (or removed at Meta) stays selectable, so saving does not drop it
  if (pipeline.whatsappNumberId && !ownNumbers.some((n) => n.id === pipeline.whatsappNumberId))
    ownNumbers.push({ id: pipeline.whatsappNumberId, display: pipeline.whatsappNumberId, name: "não está na lista da Meta", quality: null });
  const funnelNumber = ownNumbers.find((n) => n.id === pipeline.whatsappNumberId);
  // The funnel's SDR stays listed, marked, after it was switched off
  const funnelSdrs = [...sdrs.map((s) => ({ ...s, active: true })), ...(pipeline.sdr && !pipeline.sdr.active ? [pipeline.sdr] : [])];
  const options = {
    stages: allStages.map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline.name, same: s.pipelineId === pipeline.id })),
    emails,
    sdrs,
    waTemplates,
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
      trigger: r.trigger as RuleTrigger,
      delayMinutes: r.delayMinutes,
      action: r.action,
      config: r.config as RuleConfig,
      runAfterLeaving: r.runAfterLeaving,
      active: r.active,
    })),
  }));
  const ruleCount = stages.reduce((n, s) => n + s.rules.filter((r) => r.active).length, 0);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-4 md:px-6 md:pt-6">
      <Link href={`/funil?f=${pipeline.id}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
        <ArrowLeft size={15} /> Voltar para o funil
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <form action={renamePipelineAction.bind(null, pipeline.id)} className="min-w-0 flex-[1_1_14rem]">
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
      <div className="mt-4 flex items-start gap-3 rounded-2xl bg-brand p-4 text-white shadow">
        <Sparkles size={20} className="mt-0.5 shrink-0 text-gold dark:text-current" />
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

      <details className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200" open={!pipeline.isDefault && !pipeline.aiGoal}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
          <Bot size={16} className="text-brand" /> A IA neste funil
          <span className="font-normal text-slate-500">
            {pipeline.aiGoal ? "objetivo próprio" : "roteiro de venda de franquia"}
            {pipeline.slug ? ` · formulários usam "${pipeline.slug}"` : ""}
          </span>
        </summary>
        <form action={savePipelineAiAction.bind(null, pipeline.id)} className="mt-3 space-y-3 text-sm">
          <label className="block space-y-1">
            <span className="font-medium text-slate-700">Objetivo da SDR de IA aqui</span>
            <textarea
              name="aiGoal"
              rows={5}
              defaultValue={pipeline.aiGoal ?? ""}
              disabled={!canEdit}
              placeholder="Vazio: a IA segue o roteiro de venda de franquia (qualificar e marcar reunião com o gerente)."
              className={inputCls}
            />
          </label>
          <label className="block space-y-1">
            <span className="font-medium text-slate-700">Dados que a IA coleta (um por linha)</span>
            <textarea
              name="aiQuestions"
              rows={4}
              defaultValue={pipeline.aiQuestions.join("\n")}
              disabled={!canEdit}
              placeholder="Vazio: as perguntas de qualificação de Ajustes."
              className={inputCls}
            />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="font-medium text-slate-700">Nome curto para formulários e sites</span>
              <input name="slug" defaultValue={pipeline.slug ?? ""} disabled={!canEdit} placeholder="ex.: sindicatos" className={inputCls} />
            </label>
            <label className="block space-y-1">
              <span className="font-medium text-slate-700">Quando qualificar, continuar no funil</span>
              <select name="nextPipelineId" defaultValue={pipeline.nextPipelineId ?? ""} disabled={!canEdit} className={inputCls}>
                <option value="">este mesmo funil</option>
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <button className={btnCls}>Salvar</button>
            </div>
          )}
        </form>
      </details>

      <details className="mt-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-semibold">
          <MessageCircle size={16} className="text-brand" /> WhatsApp e SDR deste funil
          <span className="font-normal text-slate-500">
            {funnelNumber ? funnelNumber.display : "número principal"} · {pipeline.sdr ? pipeline.sdr.name : "rodízio entre as SDRs"}
          </span>
        </summary>
        <form action={savePipelineWhatsAppAction.bind(null, pipeline.id)} className="mt-3 space-y-3 text-sm">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="font-medium text-slate-700">Número do WhatsApp</span>
              <select name="whatsappNumberId" defaultValue={pipeline.whatsappNumberId ?? ""} disabled={!canEdit} className={inputCls}>
                <option value="">Número principal{mainNumber ? ` (${mainNumber.display})` : ""}</option>
                {ownNumbers.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.display}
                    {n.name ? ` · ${n.name}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium text-slate-700">SDR deste funil</span>
              <select name="sdrId" defaultValue={pipeline.sdrId ?? ""} disabled={!canEdit} className={inputCls}>
                <option value="">Rodízio entre as SDRs</option>
                {funnelSdrs.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.active ? "" : " (inativa)"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-slate-500">
            Vale para as conversas que começam neste funil: leads novos, indicações e quem escreve para este número pela primeira vez. Conversas já em
            andamento continuam no número delas.
            {!ownNumbers.length && " Os números vêm da conta do WhatsApp na Meta: em Integrações, clique em Verificar número."}
          </p>
          {canEdit && (
            <div className="flex justify-end">
              <button className={btnCls}>Salvar</button>
            </div>
          )}
        </form>
      </details>

      <ol className="relative mt-6 space-y-4">
        {stages.map((s, i) => (
          <StageCard key={s.id} stage={s} index={i} isFirst={i === 0} isLast={i === stages.length - 1} options={options} canEdit={canEdit} />
        ))}
      </ol>
      {canEdit && <AddStageForm pipelineId={pipeline.id} />}
    </div>
  );
}
