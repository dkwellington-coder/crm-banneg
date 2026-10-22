import { Suspense, type ReactNode } from "react";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { cofDeadline, dateTimeBr, sizeLabel } from "@/lib/cof";
import { CofUpload } from "./CofUpload";
import { MetaCapiForm } from "./MetaCapiForm";
import { CAPI_JOB, capiStatus, capiReport, type CapiEvent } from "@/lib/meta-capi";
import { Card, Loading, PageHeader, btnCls, btnGhostCls, fmt, inputCls } from "@/components/ui";
import {
  logoutAction,
  removeDocumentAction,
  retryJobAction,
  saveAgentAction,
  saveEmailTemplateAction,
  saveKnowledgeAction,
  saveMacroAction,
  saveSettingsAction,
  removeUserAccessAction,
  saveUserAction,
  saveWaTemplateAction,
} from "../../actions";

export default function ConfigPage() {
  return (
    <>
      <PageHeader title="Ajustes" subtitle="SDRs de IA, base de conhecimento, e-mails automáticos, modelos e equipe." />
      <Suspense fallback={<Loading />}>
        <Config />
      </Suspense>
    </>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <Card className="space-y-3">
      <div id={id}>
        <h2 className="font-bold">{title}</h2>
        {hint && <p className="text-sm text-slate-500">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

const ENV_CHECKS: [string, string[]][] = [
  ["WhatsApp oficial (Meta)", ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"]],
  ["IA (Claude)", ["ANTHROPIC_API_KEY"]],
  ["E-mail (SMTP)", ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]],
  ["Google Agenda", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
  ["Formulários do site", ["LEADS_API_TOKEN"]],
  ["Portal de indicações", ["PORTAL_LEADS_TOKEN"]],
  ["Agendador", ["CRON_SECRET"]],
];

async function Config() {
  const user = await requireUser();
  const owner = user.role === "OWNER";
  const [settings, agents, knowledge, emails, waTemplates, macros, users, jobs, documents, cofs] = await Promise.all([
    getSettings(),
    db.sdrAgent.findMany({ orderBy: { name: "asc" } }),
    db.knowledgeItem.findMany({ orderBy: { title: "asc" } }),
    db.emailTemplate.findMany({ orderBy: [{ key: "asc" }] }),
    db.whatsAppTemplate.findMany({ orderBy: { name: "asc" } }),
    db.macro.findMany({ orderBy: { title: "asc" } }),
    db.user.findMany({ orderBy: { name: "asc" } }),
    db.job.findMany({ orderBy: { createdAt: "desc" }, take: 60, include: { lead: { select: { name: true, phone: true } } } }),
    db.franchiseDocument.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, size: true, sha256: true, uploadedBy: true, createdAt: true },
    }),
    db.cofDelivery.findMany({
      orderBy: { sentAt: "desc" },
      take: 50,
      select: {
        id: true,
        leadId: true,
        to: true,
        sentAt: true,
        sentBy: true,
        openedAt: true,
        downloadedAt: true,
        confirmedAt: true,
        confirmIp: true,
        smtpResponse: true,
        lead: { select: { name: true } },
      },
    }),
  ]);
  const now = new Date();
  const capi = owner ? await capiStatus() : null;
  const capiTotals = owner ? await capiReport() : [];
  const capiLogs = owner ? await db.job.findMany({ where: { type: CAPI_JOB }, orderBy: { createdAt: "desc" }, take: 20 }) : [];

  return (
    <div className="grid gap-4 px-4 pb-6 max-md:[overflow-wrap:anywhere] md:px-6 xl:grid-cols-2 [&>*]:min-w-0">
      {owner && <Section id="meta-capi" title="API de Conversões Meta" hint="Prospecção e meta · eventos de formulários no funil Franquias. Nenhuma mensagem é enviada ao lead.">
        <MetaCapiForm configured={capi!.configured} />
        <p className="text-xs text-slate-500">Novo → Lead; Qualificado → Lead qualificado; Reunião marcada → Reuniao agendada; Reunião realizada → Reuniao realizada; Ganho → Franquia vendida; Perdido/Descartado → Desqualificado. As demais etapas usam o próprio nome. Com o gerente não confirma reunião realizada.</p>
        <h3 className="font-semibold">Últimos 20 envios</h3>
        <ul className="text-sm">{capiTotals.map((row, i) => <li key={i}>{row.event}: {row.count} {row.status === "DONE" ? "enviados" : row.status === "FAILED" ? "com erro definitivo" : "pendentes"}{row.error ? ` · ${row.error}` : ""}</li>)}</ul>
        {!capiLogs.length && <p className="text-sm">Nenhum evento registrado.</p>}
        <ul className="space-y-2 text-sm">{capiLogs.map(job => <li key={job.id} className="border-b pb-2">
          <strong>{(job.payload as unknown as CapiEvent).event_name}</strong> · {job.status === "DONE" ? "ok" : job.lastError ? "erro" : "aguardando"} · {job.attempts}/4 tentativas · {dateTimeBr(job.createdAt)}
          <p>{job.lastError || job.result || "Aguardando processamento e credenciais."}</p>
        </li>)}</ul>
      </Section>}
      <Section id="integracoes" title="Integrações" hint="Configuradas nas variáveis de ambiente do servidor.">
        <ul className="space-y-1 text-sm">
          {ENV_CHECKS.map(([label, keys]) => {
            const missing = keys.filter((k) => !process.env[k]);
            return (
              <li key={label} className="flex justify-between">
                <span>{label}</span>
                <span className={missing.length ? "text-amber-600" : "text-emerald-600"}>
                  {missing.length ? `falta ${missing.join(", ")}` : "conectado"}
                </span>
              </li>
            );
          })}
        </ul>
        <form action={logoutAction}>
          <button className={btnGhostCls}>Sair ({user.name})</button>
        </form>
      </Section>

      <Section id="geral" title="Qualificação e agenda" hint="O que a IA pergunta, a nota mínima para marcar reunião e os horários do gerente.">
        <form action={saveSettingsAction} className="space-y-2">
          <fieldset disabled={!owner} className="space-y-2">
            <label className="block text-sm">
              Empresa
              <input name="companyName" defaultValue={settings.companyName} className={inputCls} />
            </label>
            <label className="block text-sm">
              Link da apresentação (vai nos e-mails como {"{{apresentacao}}"})
              <input name="presentationUrl" defaultValue={settings.presentationUrl} className={inputCls} />
            </label>
            <label className="block text-sm">
              Perguntas de qualificação (uma por linha)
              <textarea name="qualificationQuestions" rows={6} defaultValue={settings.qualificationQuestions.join("\n")} className={inputCls} />
            </label>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <label className="text-sm">
                Score mínimo
                <input name="qualifyScore" type="number" min={0} max={100} defaultValue={settings.qualifyScore} className={inputCls} />
              </label>
              <label className="text-sm">
                Reunião (min)
                <input name="meetingMinutes" type="number" min={15} step={15} defaultValue={settings.meetingMinutes} className={inputCls} />
              </label>
              <label className="text-sm">
                Início (h)
                <input name="hoursStart" type="number" min={0} max={23} defaultValue={settings.businessHours.start} className={inputCls} />
              </label>
              <label className="text-sm">
                Fim (h)
                <input name="hoursEnd" type="number" min={1} max={24} defaultValue={settings.businessHours.end} className={inputCls} />
              </label>
            </div>
            <label className="block text-sm">
              Convidados de toda reunião (um e-mail por linha)
              <textarea name="meetingGuests" rows={2} defaultValue={settings.meetingGuests.join("\n")} placeholder="nome@banneg.com.br" className={inputCls} />
              <span className="text-xs text-slate-500">
                O Google manda o convite com o link do Meet para eles, como para o lead. Ao salvar, eles entram também nas reuniões já marcadas.
              </span>
            </label>
            <p className="text-xs text-slate-500">Follow-ups e lembretes agora ficam nas automações de cada etapa, em Funil › Editar funil.</p>
            <button className={btnCls}>Salvar</button>
          </fieldset>
        </form>
      </Section>

      <Section id="sdrs" title="SDRs de IA" hint="Cada lead novo vai para a SDR ativa com menos leads em atendimento.">
        {[...agents, null].map((a) => (
          <form key={a?.id ?? "new"} action={saveAgentAction} className="space-y-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!owner} className="space-y-2">
              <input type="hidden" name="id" defaultValue={a?.id ?? ""} />
              <div className="flex gap-2">
                <input name="name" required defaultValue={a?.name ?? ""} placeholder="Nome da nova SDR" className={inputCls} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="active" defaultChecked={a?.active ?? true} /> ativa
                </label>
              </div>
              <textarea name="persona" rows={3} defaultValue={a?.persona ?? ""} placeholder="Personalidade e jeito de falar" className={inputCls} />
              <button className={btnGhostCls}>{a ? "Salvar" : "Adicionar SDR"}</button>
            </fieldset>
          </form>
        ))}
      </Section>

      <Section id="conhecimento" title="Base de conhecimento" hint="A IA só responde com o que estiver aqui: investimento, retorno, suporte, regiões, perguntas frequentes. Apague o título para remover.">
        {[...knowledge, null].map((k) => (
          <form key={k?.id ?? "new"} action={saveKnowledgeAction} className="space-y-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!owner} className="space-y-2">
              <input type="hidden" name="id" defaultValue={k?.id ?? ""} />
              <input name="title" defaultValue={k?.title ?? ""} placeholder="Novo assunto (ex.: Investimento inicial)" className={inputCls} />
              <textarea name="content" rows={k ? 4 : 2} defaultValue={k?.content ?? ""} placeholder="O que a IA pode dizer sobre isso" className={inputCls} />
              <button className={btnGhostCls}>{k ? "Salvar" : "Adicionar"}</button>
            </fieldset>
          </form>
        ))}
      </Section>

      <Section id="emails" title="E-mails automáticos" hint="Variáveis: {{nome}}, {{empresa}}, {{parceiro}}, {{produto}}, {{cidade}}, {{apresentacao}}. Dia = dias depois do lead entrar. boas_vindas_* vai para todo lead novo; nutricao_* para quem entra em Nutrição. No e-mail cof: {{documentos}} e {{link_cof}} (o link de confirmação de recebimento).">
        {[...emails, null].map((e) => (
          <form key={e?.key ?? "new"} action={saveEmailTemplateAction} className="space-y-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!owner} className="space-y-2">
              <div className="flex gap-2">
                <input name="key" required defaultValue={e?.key ?? ""} readOnly={!!e} placeholder="chave (ex.: boas_vindas_10)" className={`${inputCls} w-48!`} />
                <input name="name" required defaultValue={e?.name ?? ""} placeholder="Nome" className={inputCls} />
                <input name="sequenceDay" type="number" min={0} defaultValue={e?.sequenceDay ?? ""} placeholder="Dia" className={`${inputCls} w-20!`} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="active" defaultChecked={e?.active ?? true} /> ativo
                </label>
              </div>
              <input name="subject" required defaultValue={e?.subject ?? ""} placeholder="Assunto" className={inputCls} />
              <textarea name="body" required rows={e ? 6 : 3} defaultValue={e?.body ?? ""} placeholder="Texto do e-mail" className={inputCls} />
              <button className={btnGhostCls}>{e ? "Salvar" : "Adicionar e-mail"}</button>
            </fieldset>
          </form>
        ))}
      </Section>

      <Section
        id="cof"
        title="COF e documentos da franquia"
        hint="A Circular de Oferta de Franquia, os balanços e o contrato. Vão por e-mail, com o assunto COF, quando a automação “Enviar a COF” roda ou alguém clica em “Enviar COF agora” no lead."
      >
        {documents.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="text-xs text-slate-500">
                    {sizeLabel(d.size)} · {fmt(d.createdAt)} por {d.uploadedBy} · impressão digital {d.sha256?.slice(0, 12)}
                  </div>
                </div>
                {user.role !== "SELLER" && (
                  <form action={removeDocumentAction.bind(null, d.id)}>
                    <button className="text-xs text-slate-400 hover:text-red-600">tirar</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-amber-700">Nenhum documento ainda: a automação cria uma tarefa em vez de mandar a COF.</p>
        )}
        {user.role !== "SELLER" && <CofUpload />}
      </Section>

      <Section
        id="cofs"
        title="Registro de COFs enviadas"
        hint="Cópia de cada e-mail como ele saiu (.eml) e o comprovante: quando o lead abriu, baixou e confirmou o recebimento, com o IP. A Lei 13.966 pede 10 dias entre a COF e o contrato ou qualquer pagamento."
      >
        {cofs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 pr-2">Lead</th>
                  <th className="pr-2">Enviada</th>
                  <th className="pr-2">Abriu</th>
                  <th className="pr-2">Confirmou</th>
                  <th className="pr-2">Pode assinar</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cofs.map((c) => {
                  const deadline = cofDeadline(c);
                  return (
                    <tr key={c.id} className="align-top">
                      <td className="py-1.5 pr-2">
                        <a href={`/leads/${c.leadId}`} className="font-medium text-brand hover:underline">
                          {c.lead.name ?? c.to}
                        </a>
                        <div className="text-slate-500">{c.to}</div>
                      </td>
                      <td className="pr-2">
                        {dateTimeBr(c.sentAt)}
                        <div className="text-slate-500">{c.sentBy}</div>
                      </td>
                      <td className="pr-2">{c.openedAt ? dateTimeBr(c.openedAt) : "—"}</td>
                      <td className="pr-2">
                        {c.confirmedAt ? (
                          <>
                            <span className="text-emerald-700">{dateTimeBr(c.confirmedAt)}</span>
                            <div className="text-slate-500">IP {c.confirmIp ?? "?"}</div>
                          </>
                        ) : (
                          <span className="text-amber-700">aguardando</span>
                        )}
                      </td>
                      <td className={`pr-2 ${deadline <= now ? "text-emerald-700" : "text-slate-600"}`}>
                        {deadline <= now ? "liberado" : `a partir de ${dateTimeBr(deadline).slice(0, 10)}`}
                      </td>
                      <td>
                        <a href={`/api/cof-email/${c.id}`} className="text-brand hover:underline">
                          cópia .eml
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Nenhuma COF enviada ainda.</p>
        )}
      </Section>

      <Section id="modelos" title="Modelos do WhatsApp" hint="Cadastre aqui os modelos já aprovados no Meta, com o mesmo nome. Use {{1}} para o primeiro nome; nas automações você escolhe o que vai em cada {{1}}, {{2}}, {{3}}... (nome, SDR, loja parceira, produto). Finalidades: first_contact, followup, reminder, reengagement, prospeccao. Os importados do CRM antigo (importado) só vão pelo nome, nas automações.">
        {[...waTemplates, null].map((t) => (
          <form key={t?.id ?? "new"} action={saveWaTemplateAction} className="space-y-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!owner} className="space-y-2">
              <div className="flex gap-2">
                <input name="name" defaultValue={t?.name ?? ""} readOnly={!!t} placeholder="nome_do_modelo" className={inputCls} />
                <input name="purpose" defaultValue={t?.purpose ?? "reengagement"} className={`${inputCls} w-40!`} />
                <input name="language" defaultValue={t?.language ?? "pt_BR"} className={`${inputCls} w-24!`} />
                <label className="flex items-center gap-1 text-sm">
                  <input type="checkbox" name="active" defaultChecked={t?.active ?? true} /> ativo
                </label>
              </div>
              <textarea name="body" rows={2} defaultValue={t?.body ?? ""} placeholder="Texto do modelo, igual ao aprovado" className={inputCls} />
              <button className={btnGhostCls}>{t ? "Salvar" : "Adicionar modelo"}</button>
            </fieldset>
          </form>
        ))}
      </Section>

      <Section id="macros" title="Macros" hint="Respostas prontas para a equipe. Apague o título para remover.">
        {[...macros, null].map((m) => (
          <form key={m?.id ?? "new"} action={saveMacroAction} className="space-y-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!!m && user.role === "SELLER"} className="space-y-2">
              <input type="hidden" name="id" defaultValue={m?.id ?? ""} />
              <input name="title" defaultValue={m?.title ?? ""} placeholder="Nova macro" className={inputCls} />
              <textarea name="body" rows={2} defaultValue={m?.body ?? ""} className={inputCls} />
              <button className={`${btnGhostCls} ${m && user.role === "SELLER" ? "hidden" : ""}`}>{m ? "Salvar" : "Adicionar macro"}</button>
            </fieldset>
          </form>
        ))}
      </Section>

      <Section id="equipe" title="Equipe" hint="Gerentes recebem as reuniões marcadas pela IA. Agenda Google = e-mail da agenda do gerente.">
        {[...users, null].map((u) => (
          <form key={u?.id ?? "new"} action={saveUserAction} className="flex flex-wrap gap-2 border-t border-slate-100 pt-2 first:border-0 first:pt-0">
            <fieldset disabled={!owner} className="contents">
              <input name="name" required defaultValue={u?.name ?? ""} placeholder="Nome" className={`${inputCls} w-40!`} />
              <input name="email" required type="email" defaultValue={u?.email ?? ""} readOnly={!!u} placeholder="E-mail" className={`${inputCls} w-56!`} />
              <select name="role" defaultValue={u?.role ?? "MANAGER"} className={`${inputCls} w-36!`}>
                <option value="OWNER">Proprietário</option>
                <option value="MANAGER">Gerente</option>
                <option value="SELLER">Vendedor</option>
              </select>
              <input name="calendarId" defaultValue={u?.calendarId ?? ""} placeholder="Agenda Google" className={`${inputCls} w-48!`} />
              <input name="password" type="password" placeholder={u ? "Nova senha (opcional)" : "Senha"} className={`${inputCls} w-40!`} />
              <button className={btnGhostCls}>{u ? "Salvar" : "Adicionar"}</button>
              {u && owner && u.id !== user.id && (
                <button
                  formAction={removeUserAccessAction.bind(null, u.id)}
                  title="Desconecta a pessoa de todos os aparelhos e troca a senha. Para devolver o acesso, dê uma nova senha aqui."
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Tirar acesso
                </button>
              )}
            </fieldset>
          </form>
        ))}
      </Section>

      <Section id="automacoes" title="Registro de automações" hint="Tudo o que a IA e as automações fizeram ou vão fazer, com erro e nova tentativa.">
        <div className="max-h-96 overflow-auto text-sm">
          <table className="w-full">
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-2 text-xs text-slate-500">{fmt(j.runAt)}</td>
                  <td className="py-1 pr-2">{j.type}</td>
                  <td className="py-1 pr-2">{j.lead?.name ?? j.lead?.phone ?? "—"}</td>
                  <td className={`py-1 pr-2 ${j.status === "FAILED" ? "text-red-600" : j.status === "DONE" ? "text-emerald-700" : "text-slate-500"}`}>
                    {j.status}
                    {j.attempts > 1 ? ` (${j.attempts}x)` : ""}
                    <div className="text-xs text-slate-500">{j.lastError ?? j.result}</div>
                  </td>
                  <td>
                    {j.status === "FAILED" && owner && (
                      <form action={retryJobAction.bind(null, j.id)}>
                        <button className="text-xs text-brand underline">tentar de novo</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
