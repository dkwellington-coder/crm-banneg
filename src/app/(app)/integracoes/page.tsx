import { Suspense, type ReactNode } from "react";
import { headers } from "next/headers";
import { BadgeDollarSign, Bot, CalendarDays, ClipboardList, Copy, FlaskConical, Mail, MessageCircle, ShieldCheck, Webhook, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Card, Loading, PageHeader, btnCls, btnGhostCls, inputCls, relTime } from "@/components/ui";
import { disconnectGoogleAction, saveTestModeAction } from "../../actions";
import { googleLinks } from "@/lib/google";
import { TestButton } from "./TestButton";
import { FormFunnelSelect } from "./FormFunnelSelect";
import { funnelForForm, type MetaLeadsAudit } from "@/lib/meta-leads";
import type { MetaAdsState } from "@/lib/meta-ads";
import { daysAgo } from "@/lib/time";
import { savedWhatsAppNumbers } from "@/lib/whatsapp";

export default function IntegracoesPage({ searchParams }: PageProps<"/integracoes">) {
  return (
    <>
      <PageHeader title="Integrações" subtitle="O que está conectado, o que falta e um botão para testar cada parte antes de ligar para os leads." />
      <Suspense fallback={<Loading />}>
        <Integrations searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function has(...keys: string[]) {
  return keys.filter((k) => !process.env[k]);
}

function Status({ missing }: { missing: string[] }) {
  return missing.length ? (
    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">falta configurar</span>
  ) : (
    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">configurado</span>
  );
}

function Block({ icon: Icon, color, title, missing, children }: { icon: LucideIcon; color: string; title: string; missing: string[]; children: ReactNode }) {
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: color }}>
          <Icon size={20} />
        </span>
        <h2 className="flex-1 font-semibold">{title}</h2>
        <Status missing={missing} />
      </div>
      {missing.length > 0 && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Variáveis que faltam no servidor: <span className="font-mono">{missing.join(", ")}</span>
        </p>
      )}
      {children}
    </Card>
  );
}

const Step = ({ children }: { children: ReactNode }) => <li className="text-sm text-slate-600">{children}</li>;

const GOOGLE_RESULT: Record<string, [boolean, string]> = {
  ok: [true, "Agenda Google conectada"],
  recusado: [false, "O Google não foi autorizado. Para conectar, clique de novo e aceite as permissões."],
  erro: [false, "Não deu para conectar o Google"],
  "sem-chaves": [false, "Faltam as chaves do Google na Vercel (passo a passo abaixo)."],
};

function GoogleResult({ result, detail }: { result?: string | string[]; detail?: string | string[] }) {
  const r = typeof result === "string" ? GOOGLE_RESULT[result] : undefined;
  if (!r) return null;
  const [ok, text] = r;
  return (
    <p className={`rounded-lg px-3 py-2 text-sm font-medium ${ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
      {text}
      {typeof detail === "string" && detail ? `: ${detail}` : "."}
    </p>
  );
}

/** Lead audios become text for the AI (Groq's free Whisper, or Vercel's AI Gateway); checked once a day by the cron. */
async function AudioCheck() {
  const check = (await db.setting.findUnique({ where: { key: "audio_check" } }))?.value as { ok?: boolean; message?: string; at?: string } | undefined;
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <p className="text-sm text-slate-600">
        <span className="font-medium text-slate-800">Áudios do WhatsApp:</span> a IA lê a transcrição de cada áudio do lead, e a equipe pode ouvir e gravar áudios na conversa.{" "}
        {check?.message && (
          <span className={check.ok ? "text-emerald-700" : "text-red-700"}>
            {check.message} {check.at && `(${relTime(new Date(check.at))})`}
          </span>
        )}
      </p>
      {!process.env.GROQ_API_KEY && (
        <p className="text-sm text-slate-600">
          Sem custo: crie uma conta grátis em console.groq.com, gere uma chave em API Keys e coloque no Vercel como GROQ_API_KEY. Dá até 2.000
          áudios por dia sem cartão.
        </p>
      )}
      <TestButton kind="transcription" label="Testar transcrição de áudio" />
    </div>
  );
}

/** Result of the scheduler's daily test of the owner's Google agenda. */
async function CalendarCheck() {
  const check = (await db.setting.findUnique({ where: { key: "calendar_check" } }))?.value as
    | { ok?: boolean; message?: string; details?: string[]; at?: string }
    | undefined;
  if (!check?.message) return null;
  return (
    <p className={`text-sm ${check.ok ? "text-emerald-700" : "text-red-700"}`}>
      Teste automático: {check.message} {check.at && `(${relTime(new Date(check.at))})`}
      {check.details?.[0] && <span className="block text-xs text-slate-500">{check.details[0]}</span>}
    </p>
  );
}

async function Integrations({ searchParams }: { searchParams: PageProps<"/integracoes">["searchParams"] }) {
  const user = await requireUser();
  const sp = await searchParams;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const [settings, lastInbound, users, templates, drafts, pending, formsRow, pipelines, adsRow, spend30, copyRow, forwardRow, auditRow, numbers] = await Promise.all([
    getSettings(),
    db.message.findFirst({ where: { direction: "IN", channel: "WHATSAPP" }, orderBy: { createdAt: "desc" } }),
    db.user.findMany({ where: { role: { in: ["OWNER", "MANAGER"] } }, orderBy: { name: "asc" } }),
    db.whatsAppTemplate.count({ where: { active: true } }),
    db.whatsAppTemplate.count({ where: { status: "draft" } }),
    db.whatsAppTemplate.count({ where: { status: "PENDING" } }),
    db.setting.findUnique({ where: { key: "meta_leads" } }),
    db.pipeline.findMany({ select: { slug: true, name: true, isDefault: true, whatsappNumberId: true }, orderBy: { position: "asc" } }),
    db.setting.findUnique({ where: { key: "meta_ads" } }),
    db.adSpend.aggregate({ where: { date: { gte: daysAgo(30) } }, _sum: { spend: true } }),
    db.setting.findUnique({ where: { key: "whatsapp_copy" } }),
    db.setting.findUnique({ where: { key: "whatsapp_forward" } }),
    db.setting.findUnique({ where: { key: "meta_leads_audit" } }),
    savedWhatsAppNumbers(),
  ]);
  const mainNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  // Funnels on a number the account no longer lists (or not read yet)
  const strayFunnels = pipelines.filter((p) => p.whatsappNumberId && !numbers?.numbers.some((n) => n.id === p.whatsappNumberId));
  const copy = copyRow?.value as { off?: boolean; by?: string; at?: string } | undefined;
  const oldCrm = (forwardRow?.value as { url?: string | null } | undefined)?.url;
  const audit = auditRow?.value as MetaLeadsAudit | undefined;
  const google = await googleLinks();
  const myGoogle = google.find((g) => g.user.id === user.id)?.link ?? null;
  const ads = adsRow?.value as MetaAdsState | undefined;
  const forms = formsRow?.value as
    | {
        at?: string;
        error?: string | null;
        found?: number;
        created?: number;
        forms?: Record<string, string>;
        names?: Record<string, { name: string; page: string; funnel: string | null }>;
      }
    | undefined;
  const fallbackFunnel = (pipelines.find((p) => p.isDefault) ?? pipelines[0])?.name ?? "funil padrão";
  const funnelName = (slug: string | null) => pipelines.find((p) => p.slug === slug)?.name ?? fallbackFunnel;
  const owner = user.role === "OWNER";

  return (
    <div className="grid gap-4 px-6 pb-10 xl:grid-cols-2">
      <Card className={`space-y-3 xl:col-span-2 ${settings.testMode ? "ring-2 ring-amber-300" : ""}`}>
        <div className="flex items-center gap-3">
          <span className={`flex h-10 w-10 items-center justify-center rounded-xl text-white ${settings.testMode ? "bg-amber-500" : "bg-emerald-600"}`}>
            {settings.testMode ? <FlaskConical size={20} /> : <ShieldCheck size={20} />}
          </span>
          <div className="flex-1">
            <h2 className="font-semibold">{settings.testMode ? "Modo teste ligado" : "Modo real: mensagens vão para todos os leads"}</h2>
            <p className="text-sm text-slate-500">
              No modo teste tudo funciona (IA, automações, funil), mas WhatsApp e e-mail só saem de verdade para os contatos da lista. Para os
              outros leads a mensagem fica registrada como &quot;simulada&quot;. Desligue quando estiver tudo certo.
            </p>
          </div>
        </div>
        <form action={saveTestModeAction} className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <fieldset disabled={!owner} className="contents">
            <label className="block text-sm">
              Contatos de teste (celulares e e-mails, um por linha)
              <textarea
                name="testContacts"
                rows={3}
                defaultValue={settings.testContacts.join("\n")}
                placeholder={"41999990000\nwellington@banneg.com.br"}
                className={`${inputCls} font-mono`}
              />
            </label>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" name="testMode" defaultChecked={settings.testMode} /> Modo teste
              </label>
              <label className="flex max-w-56 items-start gap-2 text-sm" title="As filas de leads antigos e os primeiros contatos continuam simulados">
                <input type="checkbox" name="answerInbound" defaultChecked={settings.answerInbound} className="mt-1" /> Responder de verdade quem
                escreveu nas últimas 24 h
              </label>
              <button className={btnCls}>Salvar</button>
            </div>
          </fieldset>
        </form>
      </Card>

      <Block icon={Bot} color="#4f46e5" title="IA: SDRs Duda e Alice" missing={has("ANTHROPIC_API_KEY")}>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Crie uma chave em console.anthropic.com &gt; API Keys e coloque crédito na conta.</Step>
          <Step>Cole a chave na variável ANTHROPIC_API_KEY do servidor.</Step>
          <Step>Teste aqui e depois converse com a SDR no Simulador.</Step>
        </ol>
        <TestButton kind="ai" label="Testar IA" />
        <AudioCheck />
      </Block>

      <Block
        icon={MessageCircle}
        color="#16a34a"
        title="WhatsApp oficial (Meta)"
        missing={has("WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN")}
      >
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Meta Business &gt; Usuários do sistema: gere um token permanente com whatsapp_business_messaging (WHATSAPP_TOKEN).</Step>
          <Step>No app do WhatsApp: ID do número (WHATSAPP_PHONE_NUMBER_ID), ID da conta (WHATSAPP_BUSINESS_ACCOUNT_ID) e a chave secreta do app (WHATSAPP_APP_SECRET).</Step>
          <Step>Cadastre o webhook abaixo e assine o campo &quot;messages&quot;.</Step>
        </ol>
        <TestButton kind="whatsapp" label="Verificar número" />
        <TestButton kind="templates_submit" label={`Enviar modelos para aprovação da Meta (${drafts} aguardando envio)`} />
        <TestButton kind="templates_sync" label={`Conferir aprovação (${templates} aprovados, ${pending} em análise)`} />
        <TestButton kind="templates" label="Importar modelos já aprovados na Meta" />
        <TestButton kind="webhook_here" label="Receber as mensagens do WhatsApp neste CRM" />
        <TestButton kind="webhook_back" label="Devolver as mensagens ao CRM antigo" />
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
          {copy?.off ? (
            <span className="text-emerald-700">
              Atendimento só neste CRM: o CRM antigo não recebe mais as mensagens do WhatsApp
              {copy.by && copy.at ? ` (${copy.by}, ${relTime(new Date(copy.at))})` : ""}.
            </span>
          ) : oldCrm ? (
            <span className="text-amber-700">Uma cópia de cada mensagem ainda vai para o CRM antigo ({new URL(oldCrm).host}): os dois recebem as conversas.</span>
          ) : (
            <span className="text-slate-500">Nenhuma cópia vai para o CRM antigo.</span>
          )}
        </div>
        {copy?.off ? (
          <TestButton kind="webhook_copy_on" label="Voltar a mandar cópia para o CRM antigo" />
        ) : (
          <TestButton kind="webhook_copy_off" label="Atender só neste CRM (parar a cópia para o CRM antigo)" />
        )}
        <TestButton kind="whatsapp_send" label="Enviar mensagem de teste">
          <input name="phone" required placeholder="Seu celular com DDD" className={`${inputCls} w-56!`} />
        </TestButton>
        <div className="space-y-2 border-t border-slate-100 pt-3 text-sm">
          <p className="text-slate-600">
            <span className="font-medium text-slate-800">Números da conta:</span> cada funil começa as conversas pelo número escolhido na tela do funil;
            os modelos aprovados valem para todos os números da conta.
          </p>
          {numbers?.numbers.length ? (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {numbers.numbers.map((n) => {
                const using = pipelines.filter((p) => (p.whatsappNumberId ?? mainNumberId) === n.id);
                return (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1.5">
                    <span className="text-slate-700">
                      <span className="font-medium">{n.display}</span>
                      {n.name && ` · ${n.name}`}
                      {n.id === mainNumberId && (
                        <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200">principal</span>
                      )}
                    </span>
                    <span className="text-xs text-slate-500">
                      {n.quality && `Qualidade ${n.quality} · `}
                      {using.length ? using.map((p) => p.name).join(", ") : "nenhum funil"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-slate-500">Clique em Verificar número para listar os números da conta do WhatsApp.</p>
          )}
          {strayFunnels.map((p) => (
            <p key={p.slug ?? p.name} className="text-xs text-amber-700">
              O funil {p.name} usa o número de ID {p.whatsappNumberId}, que não está na lista da Meta.
            </p>
          ))}
          {numbers?.at && (
            <p className={`text-xs ${numbers.error ? "text-amber-700" : "text-slate-500"}`}>
              {numbers.error ? `Última tentativa de ler a lista ${relTime(new Date(numbers.at))}: ${numbers.error}` : `Lista lida da Meta ${relTime(new Date(numbers.at))}.`}
            </p>
          )}
        </div>
      </Block>

      <Block icon={Webhook} color="#0f766e" title="Recebimento de mensagens (webhook)" missing={has("WHATSAPP_VERIFY_TOKEN")}>
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs text-slate-500">URL de retorno para colar na Meta</div>
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs">
              <Copy size={14} className="text-slate-400" /> {origin}/api/whatsapp/webhook
            </div>
          </div>
          <div className="text-xs text-slate-500">Token de verificação: o mesmo valor de WHATSAPP_VERIFY_TOKEN.</div>
          <div className={lastInbound ? "text-emerald-700" : "text-slate-500"}>
            {lastInbound ? `Última mensagem recebida ${relTime(lastInbound.createdAt)}.` : "Nenhuma mensagem recebida ainda. Responda a mensagem de teste para conferir."}
          </div>
          <div className="text-xs text-slate-500">
            Leads do site e formulários: POST em {origin}/api/leads com o cabeçalho Authorization: Bearer LEADS_API_TOKEN.
          </div>
        </div>
      </Block>

      <Block icon={ClipboardList} color="#1877f2" title="Formulários do Facebook e Instagram" missing={process.env.META_LEADS_TOKEN || process.env.WHATSAPP_TOKEN ? [] : ["META_LEADS_TOKEN"]}>
        <p className="text-sm text-slate-600">
          O CRM lê os leads novos direto dos formulários a cada 2 minutos e coloca cada um no funil certo (franquia, produtos ou sindicatos, pelo nome do
          formulário). Um formulário novo é lido desde 3 dias antes, e duas vezes por dia o CRM confere os últimos 30 dias de todos os formulários.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Meta Business &gt; Usuários do sistema: no usuário do WhatsApp, atribua a Página do Banneg com controle total.</Step>
          <Step>Gere um token novo desse usuário com leads_retrieval, pages_show_list, pages_read_engagement e pages_manage_ads e salve no Vercel como META_LEADS_TOKEN.</Step>
          <Step>Clique em Conferir formulários: os leads novos começam a entrar em até 2 minutos.</Step>
        </ol>
        {forms?.at && (
          <div className={`text-sm ${forms.error ? "text-amber-700" : "text-emerald-700"}`}>
            {forms.error
              ? `Última tentativa ${relTime(new Date(forms.at))}: ${forms.error}`
              : `Lido ${relTime(new Date(forms.at))}: ${forms.found ?? 0} formulários ativos, ${forms.created ?? 0} leads novos trazidos até agora.`}
          </div>
        )}
        {!forms?.error && forms?.names && Object.keys(forms.names).length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {Object.entries(forms.names)
              .sort(([, a], [, b]) => a.name.localeCompare(b.name))
              .map(([id, f]) => (
                <li key={id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <span className="truncate text-slate-700">{f.name}</span>
                  <FormFunnelSelect
                    formId={id}
                    value={forms.forms?.[id] ?? ""}
                    automatic={funnelName(funnelForForm(f.name))}
                    funnels={pipelines.filter((p): p is typeof p & { slug: string } => !!p.slug)}
                  />
                </li>
              ))}
          </ul>
        )}
        <TestButton kind="meta_forms" label="Conferir formulários" />
        {audit && (
          <div className="space-y-2 text-sm">
            <div className={audit.error ? "text-amber-700" : audit.missing.length ? "text-red-700" : "text-emerald-700"}>
              {audit.error
                ? `Conferência ${relTime(new Date(audit.at))}: ${audit.error}`
                : `Conferência ${relTime(new Date(audit.at))}: ${audit.total} leads nos formulários nos últimos ${audit.days} dias, ${
                    audit.missing.length ? `${audit.missing.length} não estão no CRM` : "todos estão no CRM"
                  }.`}
            </div>
            {audit.missing.length > 0 && (
              <ul className="max-h-60 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {audit.missing.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="truncate text-slate-700">{m.name ?? "Sem nome"}</span>
                    <span className="shrink-0 text-xs text-slate-500">
                      {m.form} · {new Date(m.at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <TestButton kind="meta_audit" label="Conferir leads dos últimos 30 dias" />
        {audit && audit.missing.length > 0 && (
          <TestButton kind="meta_bring" label={`Trazer os ${audit.missing.length} que faltam (entram como lead novo e a IA manda a primeira mensagem)`} />
        )}
      </Block>

      <Block icon={BadgeDollarSign} color="#0866ff" title="Investimento dos anúncios (Meta Ads)" missing={process.env.META_ADS_TOKEN || process.env.META_LEADS_TOKEN ? [] : ["META_LEADS_TOKEN"]}>
        <p className="text-sm text-slate-600">
          O CRM lê quanto cada campanha gastou por dia e cruza com os leads que ela trouxe. O Painel mostra custo por lead, por reunião e por venda, por
          campanha e por funil.
        </p>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Meta Business &gt; Usuários do sistema &gt; CRM Banneg: em Atribuir ativos &gt; Contas de anúncios, dê acesso de leitura à conta do Banneg.</Step>
          <Step>Gere o token de novo com as permissões de antes mais ads_read e troque o valor de META_LEADS_TOKEN no Vercel.</Step>
          <Step>Clique em Conferir anúncios. Na primeira leitura vêm os últimos 90 dias.</Step>
        </ol>
        {ads?.at && (
          <div className={`text-sm ${ads.error ? "text-amber-700" : "text-emerald-700"}`}>
            {ads.error
              ? `Última tentativa ${relTime(new Date(ads.at))}: ${ads.error}`
              : `Lido ${relTime(new Date(ads.at))}: ${(ads.accounts ?? []).map((a) => a.name).join(", ")}. Investimento nos últimos 30 dias: ${(spend30._sum.spend ?? 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}.`}
          </div>
        )}
        <TestButton kind="meta_ads" label="Conferir anúncios" />
      </Block>

      <Block icon={Mail} color="#0284c7" title="E-mails automáticos" missing={has("SMTP_HOST", "SMTP_USER", "SMTP_PASS")}>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>E-mail da Locaweb (expansao@banneg.com.br): SMTP_HOST=email-ssl.com.br, SMTP_PORT=465, SMTP_USER=o e-mail completo.</Step>
          <Step>SMTP_PASS (ou SMTP_PASSWORD) é a senha dessa caixa de e-mail. No Gmail seria uma senha de app, não a senha normal.</Step>
        </ol>
        <TestButton kind="email" label="Enviar e-mail de teste">
          <input name="to" type="email" defaultValue={user.email} className={`${inputCls} w-64!`} />
        </TestButton>
      </Block>

      <div id="google" className="xl:col-span-2">
        <Block icon={CalendarDays} color="#d97706" title="Google Agenda (reuniões com Meet)" missing={has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")}>
          <GoogleResult result={sp.google} detail={sp.detalhe} />
          <p className="text-sm text-slate-600">
            Com a agenda conectada, a IA só oferece horários livres de verdade, e toda reunião (marcada pela IA ou por você na página do lead) entra no
            Google Agenda com link do Meet. O lead recebe o link no WhatsApp e, se tiver e-mail, o convite do Google.
          </p>
          {has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET").length > 0 ? (
            <ol className="list-decimal space-y-1.5 pl-5">
              <Step>
                Entre em <span className="font-medium">console.cloud.google.com</span> com a conta do Banneg e crie um projeto (por exemplo &quot;CRM Banneg&quot;).
              </Step>
              <Step>Em APIs e serviços &gt; Biblioteca, ative a &quot;Google Calendar API&quot;.</Step>
              <Step>
                Em Google Auth Platform (tela de permissão OAuth), preencha o nome &quot;CRM Banneg&quot; e escolha o público <span className="font-medium">Interno</span>
                {" "}(só contas @banneg.com.br, sem revisão do Google). Se só aparecer Externo, escolha Externo e depois clique em &quot;Publicar app&quot;: em teste o
                Google desconecta a agenda a cada 7 dias.
              </Step>
              <Step>
                Em Clientes, crie um cliente OAuth do tipo &quot;Aplicativo da Web&quot;. Em &quot;URIs de redirecionamento autorizados&quot;, cole:
                <span className="mt-1 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs">
                  <Copy size={14} className="text-slate-400" /> {origin}/api/google/callback
                </span>
              </Step>
              <Step>
                Copie o ID do cliente e a chave secreta para a Vercel (projeto crm-banneg &gt; Settings &gt; Environment Variables) como GOOGLE_CLIENT_ID e
                GOOGLE_CLIENT_SECRET. Não cole as chaves no chat. Depois é só publicar de novo e voltar aqui para conectar.
              </Step>
            </ol>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                {myGoogle ? (
                  <>
                    <span className="text-sm text-emerald-700">
                      Sua agenda está conectada: <span className="font-medium">{myGoogle.email}</span>.
                    </span>
                    <form action={disconnectGoogleAction}>
                      <button className={btnGhostCls}>Desconectar</button>
                    </form>
                  </>
                ) : (
                  <a href="/api/google/connect" className={btnCls}>
                    <CalendarDays size={16} /> Conectar minha Agenda Google
                  </a>
                )}
              </div>
              {!myGoogle && (
                <p className="text-xs text-slate-500">
                  Se o Google responder &quot;redirect_uri_mismatch&quot;, abra o cliente OAuth no Google Cloud (APIs e serviços &gt; Credenciais) e adicione
                  em &quot;URIs de redirecionamento autorizados&quot;: <span className="font-mono">{origin}/api/google/callback</span>
                </p>
              )}
              <ul className="space-y-1 text-sm text-slate-600">
                {users.map((u) => {
                  const g = google.find((x) => x.user.id === u.id)?.link;
                  return (
                    <li key={u.id}>
                      <span className="font-medium text-slate-800">{u.name}</span>:{" "}
                      {g
                        ? `reuniões na agenda ${g.email} (conectada ${relTime(new Date(g.connectedAt))}).`
                        : google[0]
                          ? `ainda não conectou; as reuniões entram na agenda ${google[0].link.email} com ${u.name} convidado.`
                          : "ainda não conectou."}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <CalendarCheck />
          <TestButton kind="calendar" label="Testar agenda">
            <select name="userId" defaultValue={user.id} className={`${inputCls} w-56!`}>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </TestButton>
        </Block>
      </div>
    </div>
  );
}
