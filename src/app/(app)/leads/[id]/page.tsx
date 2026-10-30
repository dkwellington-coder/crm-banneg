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
  cancelMeetingAction,
  sendCofAction,
  completeTaskAction,
  markAlertSeenAction,
  toggleAiAction,
  updateLeadAction,
} from "../../../actions";
import { StageSelect } from "./StageSelect";
import { LostForm } from "./LostForm";
import { ApoliceUpload } from "@/components/ApoliceUpload";
import { needsApolice } from "@/lib/stage-move";
import { referredByPerson } from "@/lib/plan";
import { Composer } from "./Composer";
import { AudioRecorder } from "./AudioRecorder";
import { ScheduleMeeting } from "./ScheduleMeeting";
import { LeadSplit } from "./LeadSplit";
import { MeetingOutcome, OUTCOME_LABEL } from "@/components/MeetingOutcome";
import { PendingButton, SaveButton } from "./SaveButton";
import { googleConfigured, googleLinks } from "@/lib/google";
import { cofDeadline, dateTimeBr, sizeLabel } from "@/lib/cof";
import { VERSION_EVENTS, VERSION_MESSAGES, versionOf } from "@/lib/inbox";
import { LiveRefresh } from "@/components/LiveRefresh";

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

// What forms and the Portal de indicações send along, shown only when the lead has it
const FORM_LABEL: Record<string, string> = {
  parceiro: "Loja parceira",
  produto: "Produto",
  empresa: "Empresa",
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
        pipeline: { select: { slug: true } },
        sdr: true,
        owner: true,
        // The newest 300 (put back in order below): a long conversation shows its end, not its beginning
        messages: { orderBy: { createdAt: "desc" }, take: 300 },
        events: { orderBy: { createdAt: "desc" }, take: 300 },
        tasks: { where: { doneAt: null }, orderBy: { dueAt: "asc" } },
        meetings: { orderBy: { startsAt: "desc" }, include: { user: true } },
        cofDeliveries: {
          orderBy: { sentAt: "desc" },
          select: { id: true, to: true, sentAt: true, sentBy: true, openedAt: true, downloadedAt: true, confirmedAt: true, confirmIp: true },
        },
        jobs: { where: { status: { in: ["PENDING", "FAILED"] } }, orderBy: { runAt: "asc" }, take: 10 },
        // Finished uploads only, and never their bytes
        documents: {
          where: { sha256: { not: null } },
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true, size: true, uploadedBy: true, createdAt: true },
        },
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
  lead.messages.reverse();
  lead.events.reverse();
  // Someone opened it: it stops lighting the "new lead" alert
  if (!lead.seenAt) after(() => markSeen(lead.id));
  const managers = users.filter((u) => u.role === "OWNER" || u.role === "MANAGER");
  const meetingWith = managers.find((m) => m.id === lead.ownerId) ?? managers.find((m) => m.id === user.id) ?? managers[0];
  // Same rule as the red alerts: the lead wrote and no AI answers, or a task fell due, since the last time it was handled
  const cleared = lead.alertsClearedAt;
  const lastWhatsApp = lead.messages.findLast((m) => m.channel === "WHATSAPP");
  const dueTask = lead.tasks.find((t) => t.dueAt <= new Date() && (!cleared || t.dueAt > cleared));
  const alerting =
    lastWhatsApp?.direction === "IN" && (!lead.sdrId || lead.aiPaused) && (!cleared || lastWhatsApp.createdAt > cleared)
      ? "Esperando resposta: o lead escreveu e ninguém respondeu ainda."
      : dueTask
        ? `Tarefa vencida: ${dueTask.title}`
        : null;
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
    <LeadSplit
      name={lead.name ?? lead.phone ?? "Sem nome"}
      // Left: who the lead is and what the AI knows
      info={
        <>
          <Link href="/funil" className="text-xs text-slate-500 hover:underline max-lg:hidden">
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
          <StageSelect
            key={lead.stageId}
            leadId={lead.id}
            lead={lead.name ?? ""}
            stageId={lead.stageId}
            stages={stages.map((s) => ({ id: s.id, name: s.name, pipeline: s.pipeline.name, kind: s.kind, key: s.key }))}
          />
          {lead.stage.kind === "LOST" && lead.lostReason && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              <span className="font-semibold">Motivo da perda:</span> {lead.lostReason}
            </div>
          )}
          {alerting && (
            <form
              action={markAlertSeenAction.bind(null, lead.id)}
              className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              <span className="min-w-0 flex-1">{alerting}</span>
              <button className="shrink-0 rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-300 hover:bg-red-100">
                Marcar como visto
              </button>
            </form>
          )}

          {/* Next to the stage: it is what a won quote asks for */}
          {(needsApolice(lead) || lead.documents.length > 0) && (
            <Card className="space-y-2">
              <div className="text-sm font-bold">Apólice ou contrato</div>
              {lead.documents.map((d) => (
                <div key={d.id} className="text-sm">
                  <a href={`/api/leads/${lead.id}/documentos/${d.id}`} className="text-brand underline">
                    {d.name}
                  </a>
                  <div className="text-xs text-slate-500">
                    {sizeLabel(d.size)} · enviado por {d.uploadedBy} em {dateTimeBr(d.createdAt)}
                  </div>
                </div>
              ))}
              {!lead.documents.length && <p className="text-xs text-slate-500">Nenhum documento anexado. Para marcar o lead como Ganho, anexe a apólice (no consórcio, o contrato).</p>}
              <ApoliceUpload leadId={lead.id} />
            </Card>
          )}

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
              {Object.entries(FORM_LABEL)
                .filter(([k]) => qual[k])
                .map(([k, label]) => (
                  <div key={k} className="contents">
                    {/* An affiliate is a person, not a store; the kind itself is never listed */}
                    <dt className="text-slate-500">{k === "parceiro" && referredByPerson(qual) ? "Indicado por" : label}</dt>
                    <dd>{qual[k]}</dd>
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
            {lead.meetings.map((m) =>
              m.status === "canceled" ? (
                <div key={m.id} className="text-sm text-slate-400">
                  <s>Reunião {fmt(m.startsAt)}</s> · desmarcada
                </div>
              ) : (
                <div key={m.id} className="text-sm">
                  Reunião {fmt(m.startsAt)} com {m.user?.name ?? "gerente"}
                  {m.status !== "scheduled" && (
                    <span className={m.status === "no_show" ? "font-medium text-amber-700" : "text-slate-500"}> · {OUTCOME_LABEL[m.status] ?? m.status}</span>
                  )}
                  {m.status === "scheduled" && m.meetLink && (
                    <a href={m.meetLink} className="ml-1 text-brand underline" target="_blank">
                      Meet
                    </a>
                  )}
                  {m.status === "scheduled" && m.startsAt <= new Date() && (
                    <div className="mt-1">
                      <MeetingOutcome meetingId={m.id} />
                    </div>
                  )}
                  {m.status === "scheduled" && m.endsAt > new Date() && (
                    // Two clicks, so a slip never cancels a meeting the lead was told about
                    <details className="ml-1 inline-block">
                      <summary className="cursor-pointer text-xs text-slate-500 underline">desmarcar</summary>
                      <form action={cancelMeetingAction.bind(null, m.id)} className="mt-1">
                        <button className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600">Confirmar: desmarcar e tirar do Google Agenda</button>
                      </form>
                    </details>
                  )}
                </div>
              ),
            )}
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

          <Card className="space-y-2">
            <div className="text-sm font-bold">COF</div>
            {lead.cofDeliveries.map((c) => {
              const deadline = cofDeadline(c);
              return (
                <div key={c.id} className="space-y-0.5 text-sm">
                  <div>
                    Enviada {dateTimeBr(c.sentAt)} para {c.to}
                    <a href={`/api/cof-email/${c.id}`} className="ml-1 text-xs text-brand underline">
                      cópia .eml
                    </a>
                  </div>
                  <div className="text-xs text-slate-500">
                    {c.confirmedAt
                      ? `Recebimento confirmado em ${dateTimeBr(c.confirmedAt)} (IP ${c.confirmIp ?? "?"})`
                      : c.downloadedAt
                        ? `Baixou os documentos em ${dateTimeBr(c.downloadedAt)}; ainda não confirmou`
                        : c.openedAt
                          ? `Abriu em ${dateTimeBr(c.openedAt)}; ainda não confirmou`
                          : "Ainda não abriu"}
                    {" · "}
                    {deadline <= new Date() ? "10 dias cumpridos: pode assinar" : `Contrato ou pagamento só a partir de ${dateTimeBr(deadline).slice(0, 10)}`}
                  </div>
                </div>
              );
            })}
            {!lead.cofDeliveries.length && <p className="text-xs text-slate-500">Ainda não enviada.</p>}
            {/* Two clicks: the COF starts the law's 10 days */}
            <details>
              <summary className="cursor-pointer text-xs text-brand underline">Enviar COF agora</summary>
              <form action={sendCofAction.bind(null, lead.id)} className="mt-1">
                <PendingButton
                  disabled={!lead.email}
                  pendingLabel="Enviando a COF…"
                  label={lead.email ? `Confirmar: mandar a COF e os documentos para ${lead.email}` : "Cadastre o e-mail do lead primeiro"}
                  className="rounded border border-brand px-2 py-0.5 text-xs text-brand disabled:opacity-40"
                />
              </form>
            </details>
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
              {/* Keyed by the saved owner: after saving, the form resets to its defaults, and a select only takes a new default when it mounts */}
              <select key={lead.ownerId ?? ""} name="ownerId" defaultValue={lead.ownerId ?? ""} className={inputCls}>
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
              <SaveButton label="Salvar dados" />
            </form>
          </Card>

          {lead.stage.kind === "OPEN" && (
            <Card>
              <LostForm leadId={lead.id} />
            </Card>
          )}
        </>
      }
      // Right: one feed with WhatsApp, e-mails, notes and every AI/automation step
      chat={
        <>
          {/* The lead answers while the page is open: the new message shows up on its own */}
          <LiveRefresh
            src={`/api/leads/${lead.id}/versao`}
            version={versionOf(lead.messages.slice(-VERSION_MESSAGES), lead.events.slice(-VERSION_EVENTS))}
          />
          {/* Reversed column: the feed opens at its end, on the newest message */}
          <div className="flex flex-1 flex-col-reverse overflow-y-auto p-4">
            <div className="space-y-2">
              {feed.length === 0 && <p className="text-sm text-slate-400">Nenhuma interação ainda.</p>}
              {feed.map((item) =>
                item.kind === "event" ? (
                  <div key={item.e.id} className="text-center text-xs text-slate-500">
                    <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200">
                      {fmt(item.at)} · {item.e.actor}: {item.e.summary}
                      <OtherLead e={item.e} />
                    </span>
                  </div>
                ) : (
                  <MessageBubble key={item.m.id} m={item.m} />
                ),
              )}
            </div>
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
            <div className="mb-2 text-xs text-slate-500 max-lg:line-clamp-3">
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
        </>
      }
    />
  );
}

const JOB_LABEL: Record<string, string> = {
  "sdr.first_contact": "primeiro contato da IA",
  "sdr.reply": "resposta da IA",
  "rule.run": "automação da etapa",
  "email.send": "e-mail automático",
  "meeting.reminder": "lembrete de reunião",
  "portal.status": "aviso ao portal",
};

// Events about another lead (a store's referral that went on there, or came from there): one click to it
const OTHER_LEAD_EVENTS = new Set(["lead.duplicate", "lead.referral_joined", "lead.referral_code"]);

function OtherLead({ e }: { e: { type: string; data: unknown } }) {
  const id = (e.data as { leadId?: unknown } | null)?.leadId;
  if (!OTHER_LEAD_EVENTS.has(e.type) || typeof id !== "string") return null;
  return (
    <Link href={`/leads/${id}`} className="ml-1 text-brand underline">
      ver o outro lead
    </Link>
  );
}

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
