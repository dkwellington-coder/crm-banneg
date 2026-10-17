import { Suspense } from "react";
import { notFound } from "next/navigation";
import { after } from "next/server";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { markSeen } from "@/lib/alerts";
import { isWindowOpen } from "@/lib/whatsapp";
import { getSettings, messageVars, whatsappIsReal } from "@/lib/settings";
import { manualPurpose, templateFor } from "@/lib/messaging";
import { fillVariables } from "@/lib/rules";
import { Avatar, Card, Loading, STATUS_LABEL, TempBadge, btnGhostCls, fmt, inputCls, relTime } from "@/components/ui";
import {
  addNoteAction,
  assignSdrAction,
  completeTaskAction,
  markLostAction,
  toggleAiAction,
  updateLeadAction,
} from "../../../actions";
import { StageSelect } from "./StageSelect";
import { Composer } from "./Composer";
import { AudioRecorder } from "./AudioRecorder";
import { ScheduleMeeting } from "./ScheduleMeeting";
import { googleConfigured, googleLinks } from "@/lib/google";

export default function LeadPage({ params }: PageProps<"/leads/[id]">) {
  return (
    <Suspense fallback={<Loading />}>
      <LeadView params={params} />
    </Suspense>
  );
}

const QUAL_LABEL: Record<string, string> = {
  capital: "Capital",
  timeline: "Prazo",
  experience: "Experiência",
  decisionMaker: "Quem decide",
};

async function LeadView({ params }: { params: PageProps<"/leads/[id]">["params"] }) {
  const { id } = await params;
  // The lead and everything around it load together, in one round
  const [user, lead, stages, agents, users, macros, settings, google] = await Promise.all([
    requireUser(),
    db.lead.findUnique({
      where: { id },
      include: {
        stage: true,
        sdr: true,
        owner: true,
        messages: { orderBy: { createdAt: "asc" }, take: 300 },
        events: { orderBy: { createdAt: "asc" }, take: 300 },
        tasks: { where: { doneAt: null }, orderBy: { dueAt: "asc" } },
        meetings: { orderBy: { startsAt: "desc" }, include: { user: true } },
        jobs: { where: { status: { in: ["PENDING", "FAILED"] } }, orderBy: { runAt: "asc" }, take: 10 },
      },
    }),
    db.stage.findMany({ orderBy: [{ pipeline: { position: "asc" } }, { position: "asc" }], include: { pipeline: { select: { name: true } } } }),
    db.sdrAgent.findMany({ where: { active: true } }),
    db.user.findMany({ orderBy: { name: "asc" } }),
    db.macro.findMany({ orderBy: { title: "asc" } }),
    getSettings(),
    googleConfigured() ? googleLinks() : [],
  ]);
  if (!lead) notFound();
  // Someone opened it: it stops lighting the "new lead" alert
  if (!lead.seenAt) after(() => markSeen(lead.id));
  const managers = users.filter((u) => u.role === "OWNER" || u.role === "MANAGER");
  const meetingWith = managers.find((m) => m.id === lead.ownerId) ?? managers.find((m) => m.id === user.id) ?? managers[0];
  const agendaOf = (userId: string) => google.find((g) => g.user.id === userId)?.link.email ?? google[0]?.link.email ?? null;
  // Macros arrive ready to send: name, links to videos and PDFs already filled in
  const vars = messageVars(settings, lead, lead.sdr?.name ?? "");
  const windowOpen = isWindowOpen(lead.lastInboundAt);
  // Test mode records the messages to this lead without sending them: say so before anyone types
  const sendsForReal = whatsappIsReal(settings, lead);
  // With the window closed, what the team types does not go: Meta only lets an approved template through
  const closedTemplate =
    !windowOpen && lead.phone ? await templateFor(manualPurpose(lead), !sendsForReal) : null;
  const closedText = closedTemplate?.body
    .replace("{{1}}", lead.name?.split(" ")[0] || "tudo bem")
    .replace("{{2}}", lead.sdr?.name ?? user.name);
  const feed = [
    ...lead.messages.map((m) => ({ kind: "msg" as const, at: m.createdAt, m })),
    ...lead.events.filter((e) => e.type !== "lead.updated").map((e) => ({ kind: "event" as const, at: e.createdAt, e })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const qual = lead.qualification as Record<string, string>;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Left: who the lead is and what the AI knows */}
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto border-r border-slate-200 bg-white p-4 lg:w-96">
        <Link href="/funil" className="text-xs text-slate-500 hover:underline">
          ← Funil
        </Link>
        <div>
          <div className="flex items-center gap-3">
            <Avatar name={lead.name ?? lead.phone ?? "?"} size={44} />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold">{lead.name ?? "Sem nome"}</h1>
              <div className="text-sm text-slate-500">
                {lead.phone ?? "sem telefone"} · origem {lead.source}
              </div>
            </div>
          </div>
        </div>
        <StageSelect leadId={lead.id} stageId={lead.stageId} stages={stages.map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline.name }))} />

        <Card className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">SDR de IA</div>
            <span className={`rounded-full px-2 py-0.5 text-xs ${lead.sdr && !lead.aiPaused ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
              {lead.sdr ? (lead.aiPaused ? `${lead.sdr.name} pausada` : `${lead.sdr.name} atendendo`) : "sem IA"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{STATUS_LABEL[lead.status]}</span>
            <TempBadge t={lead.temperature} />
            {lead.score !== null && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">score {lead.score}</span>}
          </div>
          {lead.aiSummary && <p className="whitespace-pre-line rounded-lg bg-slate-50 p-2 text-sm text-slate-700">{lead.aiSummary}</p>}
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-sm">
            {Object.entries(QUAL_LABEL).map(([k, label]) => (
              <div key={k} className="contents">
                <dt className="text-slate-500">{label}</dt>
                <dd className={qual[k] ? "" : "text-slate-400"}>{qual[k] ?? "a perguntar"}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2 pt-1">
            <form action={toggleAiAction.bind(null, lead.id)}>
              <button className={btnGhostCls}>{lead.aiPaused ? "Retomar IA" : "Pausar IA"}</button>
            </form>
            <form action={assignSdrAction.bind(null, lead.id)} className="flex gap-1">
              <select name="sdrId" defaultValue={lead.sdrId ?? ""} className={`${inputCls} w-auto! py-1`}>
                <option value="">Sem IA</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button className={btnGhostCls}>Trocar</button>
            </form>
          </div>
          {lead.jobs.length > 0 && (
            <div className="border-t border-slate-100 pt-2 text-xs text-slate-500">
              {lead.jobs.map((j) => (
                <div key={j.id} className={j.status === "FAILED" ? "text-red-600" : ""}>
                  {j.status === "FAILED" ? "Falhou" : "Agendado"}: {JOB_LABEL[j.type] ?? j.type} · {fmt(j.runAt)}
                  {j.lastError ? ` · ${j.lastError}` : ""}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="space-y-2">
          <div className="text-sm font-bold">Próximos passos</div>
          {lead.meetings.map((m) => (
            <div key={m.id} className="text-sm">
              Reunião {fmt(m.startsAt)} com {m.user?.name ?? "gerente"}
              {m.meetLink && (
                <a href={m.meetLink} className="ml-1 text-brand underline" target="_blank">
                  Meet
                </a>
              )}
            </div>
          ))}
          {lead.tasks.map((t) => (
            <form key={t.id} action={completeTaskAction.bind(null, t.id)} className="flex items-center gap-2 text-sm">
              <button className="h-4 w-4 rounded border border-slate-400" title="Concluir" />
              <span>{t.title}</span>
              <span className="ml-auto text-xs text-slate-400">{fmt(t.dueAt)}</span>
            </form>
          ))}
          {meetingWith && (
            <ScheduleMeeting
              leadId={lead.id}
              managers={managers.map((m) => ({ id: m.id, name: m.name }))}
              defaultUserId={meetingWith.id}
              minutes={settings.meetingMinutes}
              hasPhone={!!lead.phone}
              google={agendaOf(meetingWith.id)}
            />
          )}
        </Card>

        <Card>
          <form action={updateLeadAction.bind(null, lead.id)} className="space-y-2">
            <div className="text-sm font-bold">Dados</div>
            <input name="name" defaultValue={lead.name ?? ""} placeholder="Nome" className={inputCls} />
            <input name="email" defaultValue={lead.email ?? ""} placeholder="E-mail" className={inputCls} />
            <div className="flex gap-2">
              <input name="city" defaultValue={lead.city ?? ""} placeholder="Cidade" className={inputCls} />
              <input name="state" defaultValue={lead.state ?? ""} placeholder="UF" className={`${inputCls} w-20!`} />
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">R$</span>
              <input
                name="value"
                inputMode="numeric"
                defaultValue={lead.value ? lead.value.toLocaleString("pt-BR") : ""}
                placeholder="Valor do negócio"
                title="Conta na meta de receita quando o lead for ganho"
                className={`${inputCls} pl-9`}
              />
            </div>
            <select name="ownerId" defaultValue={lead.ownerId ?? ""} className={inputCls}>
              <option value="">Sem responsável</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="emailOptOut" defaultChecked={lead.emailOptOut} /> Não enviar e-mails
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="whatsappOptOut" defaultChecked={lead.whatsappOptOut} /> Não enviar WhatsApp automático
            </label>
            <button className={btnGhostCls}>Salvar dados</button>
          </form>
        </Card>

        {lead.stage.kind === "OPEN" && (
          <Card>
            <form action={markLostAction.bind(null, lead.id)} className="flex gap-2">
              <input name="reason" required placeholder="Motivo da perda" className={inputCls} />
              <button className={btnGhostCls}>Perdido</button>
            </form>
          </Card>
        )}
      </aside>

      {/* Right: one feed with WhatsApp, e-mails, notes and every AI/automation step */}
      <section className="flex min-h-0 flex-1 flex-col bg-slate-50">
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {feed.length === 0 && <p className="text-sm text-slate-400">Nenhuma interação ainda.</p>}
          {feed.map((item) =>
            item.kind === "event" ? (
              <div key={item.e.id} className="text-center text-xs text-slate-500">
                <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                  {fmt(item.at)} · {item.e.actor}: {item.e.summary}
                </span>
              </div>
            ) : (
              <MessageBubble key={item.m.id} m={item.m} />
            ),
          )}
        </div>
        <div className="border-t border-slate-200 bg-white p-3">
          {lead.phone && !sendsForReal && (
            <div className="mb-2 rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">
              Modo teste: o que for mandado para este lead fica só simulado e não chega ao WhatsApp dele. Para atender de verdade, coloque o
              número dele nos contatos de teste em{" "}
              <Link href="/integracoes" className="underline">
                Integrações
              </Link>
              .
            </div>
          )}
          <div className="mb-2 text-xs text-slate-500">
            {windowOpen
              ? `Janela de 24 h aberta (última mensagem do lead ${relTime(lead.lastInboundAt)}). Você pode escrever livremente.`
              : closedText
                ? `Janela de 24 h fechada: a Meta só deixa passar um modelo aprovado. Ao enviar, vai este, e não o que você escrever: “${closedText}” Quando o lead responder, você escreve livremente.`
                : "Janela de 24 h fechada e não há modelo aprovado pela Meta para reabrir a conversa."}
            {lead.sdr && !lead.aiPaused && " Ao enviar, a IA pausa neste lead."}
          </div>
          <Composer leadId={lead.id} macros={macros.map((m) => ({ title: m.title, body: fillVariables(m.body, vars) }))} />
          {lead.phone && (
            <div className="mt-2">
              <AudioRecorder leadId={lead.id} windowOpen={windowOpen} />
            </div>
          )}
          <form action={addNoteAction.bind(null, lead.id)} className="mt-2 flex gap-2">
            <input name="note" placeholder="Nota interna (o lead não vê)" className={inputCls} />
            <button className={btnGhostCls}>Anotar</button>
          </form>
        </div>
      </section>
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  "sdr.first_contact": "primeiro contato da IA",
  "sdr.reply": "resposta da IA",
  "rule.run": "automação da etapa",
  "email.send": "e-mail automático",
  "meeting.reminder": "lembrete de reunião",
};

type BubbleMessage = {
  id: string;
  channel: string;
  direction: string;
  body: string;
  author: string;
  status: string;
  error: string | null;
  template: string | null;
  mediaKind: string | null;
  createdAt: Date;
};

function MessageBubble({ m }: { m: BubbleMessage }) {
  const out = m.direction === "OUT";
  const note = m.channel === "NOTE";
  const cls = note
    ? "bg-amber-50 ring-amber-200"
    : m.status === "FAILED"
      ? "bg-red-50 ring-red-200"
      : out
        ? "bg-brand-soft ring-blue-200"
        : "bg-white ring-slate-200";
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] rounded-xl px-3 py-2 text-sm ring-1 ${cls}`}>
        <div className="mb-1 text-[11px] text-slate-500">
          {note ? "Nota · " : m.channel === "EMAIL" ? "E-mail · " : ""}
          {m.author}
          {m.template ? ` · modelo ${m.template}` : ""}
        </div>
        {m.mediaKind === "audio" && <audio controls preload="none" src={`/api/media/${m.id}`} className="mb-1 h-9 w-64 max-w-full" />}
        <div className={`whitespace-pre-wrap break-words ${m.mediaKind === "audio" ? "text-slate-600 italic" : ""}`}>{m.body}</div>
        <div className="mt-1 text-right text-[11px] text-slate-400">
          {fmt(m.createdAt)}
          {out && !note && ` · ${STATUS_PT[m.status] ?? m.status}`}
        </div>
        {m.error && <div className="mt-1 text-xs font-medium text-red-700">{m.error}</div>}
      </div>
    </div>
  );
}

const STATUS_PT: Record<string, string> = { QUEUED: "na fila", SENT: "enviada", DELIVERED: "entregue", READ: "lida", FAILED: "falhou", SIMULATED: "simulada (modo teste)" };
