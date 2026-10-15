import { Suspense, type ReactNode } from "react";
import { headers } from "next/headers";
import { Bot, CalendarDays, ClipboardList, Copy, FlaskConical, Mail, MessageCircle, ShieldCheck, Webhook, type LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { Card, Loading, PageHeader, btnCls, inputCls, relTime } from "@/components/ui";
import { saveTestModeAction } from "../../actions";
import { TestButton } from "./TestButton";

export default function IntegracoesPage() {
  return (
    <>
      <PageHeader title="Integrações" subtitle="O que está conectado, o que falta e um botão para testar cada parte antes de ligar para os leads." />
      <Suspense fallback={<Loading />}>
        <Integrations />
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

async function Integrations() {
  const user = await requireUser();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const [settings, lastInbound, users, templates, drafts, pending, formsRow] = await Promise.all([
    getSettings(),
    db.message.findFirst({ where: { direction: "IN", channel: "WHATSAPP" }, orderBy: { createdAt: "desc" } }),
    db.user.findMany({ where: { role: { in: ["OWNER", "MANAGER"] } }, orderBy: { name: "asc" } }),
    db.whatsAppTemplate.count({ where: { active: true } }),
    db.whatsAppTemplate.count({ where: { status: "draft" } }),
    db.whatsAppTemplate.count({ where: { status: "PENDING" } }),
    db.setting.findUnique({ where: { key: "meta_leads" } }),
  ]);
  const forms = formsRow?.value as { at?: string; error?: string | null; found?: number; created?: number } | undefined;
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
        <TestButton kind="whatsapp_send" label="Enviar mensagem de teste">
          <input name="phone" required placeholder="Seu celular com DDD" className={`${inputCls} w-56!`} />
        </TestButton>
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
          formulário). O CRM antigo continua recebendo também, então nada é cortado.
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
        <TestButton kind="meta_forms" label="Conferir formulários" />
      </Block>

      <Block icon={Mail} color="#0284c7" title="E-mails automáticos" missing={has("SMTP_HOST", "SMTP_USER", "SMTP_PASS")}>
        <ol className="list-decimal space-y-1 pl-5">
          <Step>Gmail/Google Workspace: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465, SMTP_USER=seu e-mail.</Step>
          <Step>SMTP_PASS é uma senha de app (Conta Google &gt; Segurança &gt; Senhas de app), não a senha normal.</Step>
        </ol>
        <TestButton kind="email" label="Enviar e-mail de teste">
          <input name="to" type="email" defaultValue={user.email} className={`${inputCls} w-64!`} />
        </TestButton>
      </Block>

      <Block icon={CalendarDays} color="#d97706" title="Google Agenda (reuniões com Meet)" missing={has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN")}>
        <p className="text-sm text-slate-600">
          Com a agenda conectada, a IA só oferece horários livres de verdade e a reunião já entra no Google Agenda do gerente com link do Meet.
          Sem ela, a reunião fica só no CRM.
        </p>
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
  );
}
