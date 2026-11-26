import Link from "next/link";
import { Suspense } from "react";
import { BookOpen, Bot, CheckCircle2, FolderOpen, ListTodo, Palette, MessageSquareText, Smartphone, XCircle } from "lucide-react";
import { requireOwnerPage } from "@/lib/access";
import { db } from "@/lib/db";
import { phoneLabel } from "@/lib/calendar";
import { canCreateInstances } from "@/lib/support";
import { getSecretary, getSecretaryHealth, secretaryGroups, secretaryStatus, TASK_KIND_LABEL, whenBr } from "@/lib/secretary";
import { Card, Loading, PageHeader, btnCls, btnGhostCls, inputCls, relTime } from "@/components/ui";
import { SecretaryQr } from "./SecretaryQr";
import { SecretaryForm } from "./SecretaryForm";
import { secretaryDrive } from "@/lib/secretary-drive";
import { CANVA_FOLDER, canvaConnected, secretaryCanva } from "@/lib/secretary-canva";
import { getGuides } from "@/lib/secretary-guides";
import { addGuideAction, addTaskAction, disconnectCanvaAction, refreshGuidesAction, removeGuideAction, disconnectDriveAction, removeSecretaryAction, setDriveFolderAction, setTaskStatusAction } from "./actions";

/**
 * Secretária (Wellington, 2026-11-26): the AI secretary on her own WhatsApp chip, in a group with him and the team.
 * Here he connects her number, picks the group and the people, writes the registration checklist, and sees the
 * tasks she keeps and what she did.
 */
type Search = { drive?: string; canva?: string; guia?: string; detalhe?: string };

export default function SecretariaPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <>
      <PageHeader title="Secretária" subtitle="Sua secretária no WhatsApp: agenda com Meet, e-mails, tarefas, lembretes e cobranças no grupo." />
      <Suspense fallback={<Loading />}>
        <Secretaria searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const DRIVE_NOTICE: Record<string, (d: string) => { ok: boolean; text: string }> = {
  ok: (d) => ({ ok: true, text: `Google Drive conectado${d ? ` (${d})` : ""}. Agora cole o link da pasta da equipe.` }),
  pasta: (d) => ({ ok: true, text: `Pronto: a equipe vê a pasta "${d}".` }),
  recusado: () => ({ ok: false, text: "O Google não recebeu a permissão. Clique em conectar e marque o acesso ao Drive." }),
  erro: (d) => ({ ok: false, text: d || "Não deu certo. Tente de novo." }),
};

const GUIDE_NOTICE: Record<string, (d: string) => { ok: boolean; text: string }> = {
  ok: (d) => ({ ok: true, text: `Guia "${d}" lido. Ela segue esse padrão a partir de agora.` }),
  atualizado: () => ({ ok: true, text: "Guias lidos de novo no Google Docs." }),
  erro: (d) => ({ ok: false, text: d || "Não deu certo. Tente de novo." }),
};

const CANVA_NOTICE: Record<string, (d: string) => { ok: boolean; text: string }> = {
  ok: () => ({ ok: true, text: `Canva conectado. Coloque os modelos na pasta "${CANVA_FOLDER}" do seu Canva.` }),
  recusado: () => ({ ok: false, text: "O Canva não recebeu a permissão. Clique em conectar e aceite." }),
  erro: (d) => ({ ok: false, text: d || "Não deu certo. Tente de novo." }),
};

function Section({ icon: Icon, title, children, className = "" }: { icon: typeof Bot; title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={`space-y-4 ${className}`}>
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Icon size={17} />
        </span>
        {title}
      </h2>
      {children}
    </Card>
  );
}

async function Secretaria({ searchParams }: { searchParams: Promise<Search> }) {
  await requireOwnerPage();
  const query = await searchParams;
  const s = await getSecretary();
  const drive = await secretaryDrive();
  const notice = query.drive && DRIVE_NOTICE[query.drive]?.(query.detalhe ?? "");
  const canva = await secretaryCanva();
  const canvaNotice = query.canva && CANVA_NOTICE[query.canva]?.(query.detalhe ?? "");
  const guideNotice = query.guia && GUIDE_NOTICE[query.guia]?.(query.detalhe ?? "");
  const guides = await getGuides();
  const status = s.token ? await secretaryStatus(s).catch((e: Error) => ({ connected: false, status: "sem resposta", reason: e.message, phone: null })) : null;
  const groups = status?.connected ? await secretaryGroups().catch(() => null) : null;
  // The saved group stays selectable even when the list could not be read
  const groupList = groups ? (s.group && !groups.some((g) => g.id === s.group!.id) ? [s.group, ...groups] : groups) : s.group ? [s.group] : null;
  const [health, open, done, messages, drafts] = await Promise.all([
    getSecretaryHealth(),
    db.secretaryTask.findMany({ where: { status: "aberta" }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], take: 100 }),
    db.secretaryTask.findMany({ where: { status: { in: ["feita", "cancelada"] } }, orderBy: { doneAt: "desc" }, take: 15 }),
    db.secretaryMessage.findMany({ orderBy: { at: "desc" }, take: 40 }),
    db.secretaryEmail.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const now = new Date();
  const phone = s.phone ?? status?.phone;

  return (
    <div className="grid gap-4 px-4 pb-8 md:px-6 xl:grid-cols-[1.15fr_1fr]">
      <div className="space-y-4">
        <Section icon={Smartphone} title="WhatsApp dela">
          {!canCreateInstances() ? (
            <p className="text-sm text-amber-700">Falta ligar o servidor do WhatsApp (SUPPORT_WA_URL e SUPPORT_WA_ADMIN_TOKEN no Vercel).</p>
          ) : status?.connected ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <CheckCircle2 size={18} /> Conectada{phone ? ` no ${phoneLabel(phone)}` : ""}
                {s.group ? ` · lendo o grupo ${s.group.name}` : " · falta escolher o grupo"}
                {s.teamGroup ? ` e acompanhando ${s.teamGroup.name}` : ""}
              </p>
              <p className="text-xs text-slate-500">
                Ela só lê os grupos escolhidos{s.privates ? " e as conversas no privado do número dela" : ""}. Outros grupos em que o chip estiver ficam de fora.
                Se desconectar, você recebe um e-mail.
              </p>
              <form action={removeSecretaryAction}>
                <button className="text-xs text-slate-500 underline">Desconectar o número dela</button>
              </form>
            </div>
          ) : (
            <div className="space-y-3">
              {status && (
                <p className="flex items-center gap-2 text-sm font-medium text-red-700">
                  <XCircle size={18} /> Desconectada{health?.since ? ` desde ${whenBr(new Date(health.since))}` : ""}
                  {status.reason ? `: ${status.reason}` : ""}
                </p>
              )}
              <p className="text-sm text-slate-600">
                Use o chip só dela, com o WhatsApp já instalado no celular. Leia o QR code com esse celular: o número dela fica ligado no servidor do Banneg,
                como um WhatsApp Web, sem mensalidade.
              </p>
              <SecretaryQr label={s.token ? "Ler o QR code" : "Conectar o número dela"} fresh={!!s.token} />
            </div>
          )}
        </Section>

        <Section icon={Bot} title="Como ela trabalha">
          <SecretaryForm
            name={s.name}
            nicknames={s.nicknames}
            members={s.members}
            checklist={s.checklist}
            instructions={s.instructions}
            switches={{ active: s.active, confirmEmails: s.confirmEmails, weekly: s.weekly, daily: s.daily, privates: s.privates }}
            groups={groupList}
            groupId={s.group?.id ?? ""}
            teamGroupId={s.teamGroup?.id ?? ""}
            canTest={!!status?.connected && !!s.group}
          />
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
            <p className="font-medium text-slate-800">Exemplos do que pedir no grupo</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>“Marca reunião com o João Silva amanhã às 15h e convida o Odair.”</li>
              <li>“Manda um e-mail para fulano@empresa.com confirmando a visita de quinta.”</li>
              <li>“Odair, me manda o contrato até sexta.” (ela anota e cobra na sexta)</li>
              <li>“Me lembra de ligar para a seguradora às 16h.”</li>
              <li>“Quais são as tarefas da semana?” · “Manda o checklist de cadastro.”</li>
              <li>“Jessica, me manda o relatório de inadimplência.” · “Quais seguradoras foram feitas em outubro?”</li>
              <li>“Manda a tabela de comissões aqui.” · “Quantos leads entraram essa semana? Manda em planilha.”</li>
              <li>“Jess, faz um post da Black Banneg” · “Me dá 5 ideias de story para telemedicina.”</li>
            </ul>
          </div>
        </Section>

        <Section icon={FolderOpen} title="Google Drive">
          <div id="drive" className="space-y-3 text-sm text-slate-600">
            <p>
              Ela procura, lê e manda arquivos do seu Drive (relatórios de inadimplência, comissões, seguradoras, marketing, jurídico). Você e o Franklin
              podem pedir qualquer arquivo do Drive. A equipe só enxerga a pasta da equipe escolhida abaixo.
            </p>
            {notice && <p className={`rounded-lg px-3 py-2 text-sm ${notice.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{notice.text}</p>}
            {drive ? (
              <>
                <p className="flex items-center gap-2 font-medium text-emerald-700">
                  <CheckCircle2 size={18} /> Conectado em {drive.email}
                  {drive.folderName ? ` · pasta da equipe "${drive.folderName}"` : " · falta escolher a pasta da equipe"}
                </p>
                <form action={setDriveFolderAction} className="flex flex-col gap-2 sm:flex-row">
                  <input
                    name="folder"
                    required
                    placeholder="Link da pasta da equipe: drive.google.com/drive/folders/..."
                    defaultValue={drive.folderId ? `https://drive.google.com/drive/folders/${drive.folderId}` : ""}
                    className={inputCls}
                    aria-label="Link da pasta da equipe no Google Drive"
                  />
                  <button className={btnCls}>{drive.folderId ? "Trocar pasta" : "Usar esta pasta"}</button>
                </form>
                <form action={disconnectDriveAction}>
                  <button className="text-xs text-slate-500 underline">Desconectar o Drive</button>
                </form>
              </>
            ) : (
              <a href="/api/secretaria/drive/conectar" className={`${btnCls} inline-flex`}>
                Conectar o Google Drive
              </a>
            )}
          </div>
        </Section>

        <Section icon={BookOpen} title="Padrão do Banneg">
          <div id="guias" className="space-y-3 text-sm text-slate-600">
            <p>Os guias que ela segue em artes, legendas, vídeos e respostas sobre consórcio. Edite no Google Docs e clique em atualizar.</p>
            {guideNotice && <p className={`rounded-lg px-3 py-2 text-sm ${guideNotice.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{guideNotice.text}</p>}
            {guides.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {guides.map((g) => (
                  <li key={g.docId} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <a href={`https://docs.google.com/document/d/${g.docId}/edit`} target="_blank" rel="noreferrer" className="font-medium text-slate-800 underline">
                        {g.nome}
                      </a>
                      <p className="text-xs text-slate-500">lido {relTime(new Date(g.lidoEm))} · {Math.round(g.texto.length / 1000)} mil caracteres</p>
                    </div>
                    <form action={removeGuideAction.bind(null, g.docId)}>
                      <button className="text-xs text-slate-500 hover:text-red-600">Tirar</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            {drive ? (
              <>
                <form action={addGuideAction} className="flex flex-col gap-2 sm:flex-row">
                  <input name="nome" required placeholder="Nome (ex.: Marketing)" className={`${inputCls} sm:w-44!`} aria-label="Nome do guia" />
                  <input name="link" required placeholder="Link do Google Docs" className={inputCls} aria-label="Link do guia no Google Docs" />
                  <button className={btnCls}>Adicionar</button>
                </form>
                {guides.length > 0 && (
                  <form action={refreshGuidesAction}>
                    <button className={btnGhostCls}>Atualizar os guias</button>
                  </form>
                )}
              </>
            ) : (
              <p className="text-xs text-slate-500">Para adicionar ou atualizar guias, conecte o Google Drive acima.</p>
            )}
          </div>
        </Section>

        <Section icon={Palette} title="Canva">
          <div id="canva" className="space-y-3 text-sm text-slate-600">
            <p>
              Ela faz artes a partir dos seus modelos do Canva: copia o modelo, troca os textos e manda a imagem no WhatsApp. O seu original fica intacto.
              Ela só usa o que estiver na pasta <strong>“{CANVA_FOLDER}”</strong> do seu Canva. Use fotos suas ou grátis (foto do Canva Pro sai com marca d’água).
            </p>
            {canvaNotice && <p className={`rounded-lg px-3 py-2 text-sm ${canvaNotice.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{canvaNotice.text}</p>}
            {canvaConnected(canva) ? (
              <>
                <p className="flex items-center gap-2 font-medium text-emerald-700">
                  <CheckCircle2 size={18} /> Canva conectado
                </p>
                <form action={disconnectCanvaAction}>
                  <button className="text-xs text-slate-500 underline">Desconectar o Canva</button>
                </form>
              </>
            ) : (
              <a href="/api/secretaria/canva/conectar" className={`${btnCls} inline-flex`}>
                Conectar o Canva
              </a>
            )}
          </div>
        </Section>
      </div>

      <div className="space-y-4">
        <Section icon={ListTodo} title={`Tarefas em aberto (${open.length})`}>
          <Link href="/tarefas" className="-mt-2 block text-xs font-medium text-brand underline">Abrir a lista resumida</Link>
          <form action={addTaskAction} className="grid gap-2 md:grid-cols-[1.6fr_1fr_1fr_auto]">
            <input name="title" required placeholder="Nova tarefa" className={inputCls} aria-label="Nova tarefa" />
            <input name="assignee" placeholder="Responsável" list="secretaria-people" className={inputCls} aria-label="Responsável" />
            <input name="dueAt" type="datetime-local" className={inputCls} aria-label="Prazo" />
            <div className="flex gap-2">
              <select name="kind" className={`${inputCls} w-auto!`} aria-label="Tipo">
                <option value="tarefa">Tarefa</option>
                <option value="retorno">Retorno</option>
                <option value="lembrete">Lembrete</option>
              </select>
              <button className={btnCls}>Anotar</button>
            </div>
            <datalist id="secretaria-people">
              {s.members.map((m) => (
                <option key={m.name} value={m.name} />
              ))}
            </datalist>
          </form>
          {open.length ? (
            <ul className="divide-y divide-slate-100">
              {open.map((t) => {
                const late = t.dueAt && t.dueAt < now;
                return (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800">{t.title}</p>
                      <p className="text-xs text-slate-500">
                        {TASK_KIND_LABEL[t.kind] ?? t.kind}
                        {t.assignee && ` · ${t.assignee}`}
                        {t.dueAt && <span className={late ? "font-semibold text-red-600" : ""}>{` · ${late ? "atrasada, era" : "até"} ${whenBr(t.dueAt)}`}</span>}
                        {t.nudges > 0 && ` · cobrada ${t.nudges}x`}
                        {t.createdBy && ` · pedida por ${t.createdBy}`}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <form action={setTaskStatusAction.bind(null, t.id, "feita")}>
                        <button className={`${btnGhostCls} px-2.5! py-1! text-xs`}>Feita</button>
                      </form>
                      <form action={setTaskStatusAction.bind(null, t.id, "cancelada")}>
                        <button className="px-2 py-1 text-xs text-slate-500 hover:text-red-600">Cancelar</button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Nada em aberto. Tudo o que for combinado no grupo aparece aqui.</p>
          )}
          {done.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-500">Concluídas recentemente ({done.length})</summary>
              <ul className="mt-2 space-y-1 text-slate-500">
                {done.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2">
                    <span className={t.status === "cancelada" ? "line-through" : ""}>
                      {t.title}
                      {t.doneBy && ` · ${t.doneBy}`} {t.doneAt && `· ${relTime(t.doneAt)}`}
                    </span>
                    <form action={setTaskStatusAction.bind(null, t.id, "aberta")}>
                      <button className="text-xs underline">Reabrir</button>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Section>

        <Section icon={MessageSquareText} title="O que ela leu e respondeu">
          {drafts.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">E-mails</p>
              {drafts.map((d) => (
                <p key={d.id} className="text-sm text-slate-600">
                  <span className={`mr-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${d.status === "enviado" ? "bg-emerald-100 text-emerald-700" : d.status === "erro" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"}`}>
                    {d.status}
                  </span>
                  {d.subject} · para {d.to} · {relTime(d.sentAt ?? d.createdAt)}
                  {d.error && <span className="block text-xs text-red-600">{d.error}</span>}
                </p>
              ))}
            </div>
          )}
          {messages.length ? (
            <ul className="space-y-2">
              {messages.map((m) => (
                <li key={m.id} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.fromMe ? "bg-brand text-white" : "bg-slate-100 text-slate-800"}`}>
                    <p className={`text-[11px] font-semibold ${m.fromMe ? "text-white/70" : "text-slate-500"}`}>
                      {m.fromMe ? s.name : m.senderName ?? (m.senderPhone ? phoneLabel(m.senderPhone) : "alguém")}
                      {!m.isGroup && " · privado"} · {whenBr(m.at)}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">Nenhuma mensagem ainda.</p>
          )}
        </Section>
      </div>
    </div>
  );
}
