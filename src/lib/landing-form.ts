import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { logEvent } from "./events";
import { createLead, ensureTask, pipelineByRef } from "./leads";

/**
 * The franchise form of the landing page (franquia.banneg.com.br shows it in an iframe). It used to live on a separate
 * capture service; now the CRM serves it and creates the lead itself, in Vendas de Franquias.
 */

// The pages allowed to show the form, and to hear from it (its height, the confirmed lead)
export const FORM_PARENTS = ["https://franquia.banneg.com.br", "https://master.banneg.com.br", "https://banneg-franquia-premium.dkwellington.chatgpt.site"];
export const FORM_SOURCE = "Landing franquia";
const PRIVACY_URL = "https://banneg-franquia-premium.dkwellington.chatgpt.site/privacidade.html";
const FUNNEL = "franquias";
export const AGAIN_TASK = "Lead preencheu o formulário da franquia de novo: chamar";
// More than this from one connection in an hour is a robot
const PER_HOUR = 20;

export const STATES: [string, string][] = [
  ["AC", "Acre"],
  ["AL", "Alagoas"],
  ["AP", "Amapá"],
  ["AM", "Amazonas"],
  ["BA", "Bahia"],
  ["CE", "Ceará"],
  ["DF", "Distrito Federal"],
  ["ES", "Espírito Santo"],
  ["GO", "Goiás"],
  ["MA", "Maranhão"],
  ["MT", "Mato Grosso"],
  ["MS", "Mato Grosso do Sul"],
  ["MG", "Minas Gerais"],
  ["PA", "Pará"],
  ["PB", "Paraíba"],
  ["PR", "Paraná"],
  ["PE", "Pernambuco"],
  ["PI", "Piauí"],
  ["RJ", "Rio de Janeiro"],
  ["RN", "Rio Grande do Norte"],
  ["RS", "Rio Grande do Sul"],
  ["RO", "Rondônia"],
  ["RR", "Roraima"],
  ["SC", "Santa Catarina"],
  ["SP", "São Paulo"],
  ["SE", "Sergipe"],
  ["TO", "Tocantins"],
];
export const CAPITAL = ["Menos de R$ 20 mil", "R$ 20 mil a R$ 30 mil", "Acima de R$ 30 mil até R$ 50 mil", "Acima de R$ 50 mil", "Dependo de financiamento"];
export const START = ["Até 30 dias", "De 31 a 90 dias", "Mais de 90 dias", "Estou pesquisando"];
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid", "utm_referrer"];

export class FormError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const str = (v: unknown, max = 200) => {
  if (v == null) return "";
  if (typeof v !== "string" || v.length > max) throw new FormError("Confira os campos informados.");
  return v.trim();
};

export type LandingLead = {
  eventId: string;
  name: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  capital: string;
  start: string;
  utm: Record<string, string>;
  landingUrl: string;
};

/** What the form sent, checked the way the capture service checked it (robots, consent, the answers it offers). */
export function readLandingForm(b: unknown): LandingLead {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new FormError("Formulário inválido.");
  const f = b as Record<string, unknown>;
  if (typeof f.event_id !== "string" || !/^[a-f0-9-]{36}$/i.test(f.event_id)) throw new FormError("Identificador inválido. Atualize a página.");
  // The hidden field only robots fill, and a form sent faster than a person can type
  if (f.website) throw new FormError("Não foi possível validar o formulário.");
  if (typeof f.elapsed_ms !== "number" || !Number.isFinite(f.elapsed_ms) || f.elapsed_ms < 1500) throw new FormError("Confira os dados e tente novamente.");
  const name = str(f.name);
  const phone = str(f.phone, 40);
  const digits = phone.replace(/\D/g, "").length;
  if (name.length < 2 || digits < 10 || digits > 13) throw new FormError("Informe seu nome e um WhatsApp válido com DDD.");
  const email = str(f.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FormError("Confira o e-mail.");
  const city = str(f.city);
  const state = str(f.state, 2).toUpperCase();
  if (city.length < 2 || !STATES.some(([uf]) => uf === state)) throw new FormError("Informe sua cidade e o estado.");
  const capital = str(f.investment);
  if (!CAPITAL.includes(capital)) throw new FormError("Selecione o capital disponível.");
  const start = str(f.start_window, 80);
  if (!START.includes(start)) throw new FormError("Selecione quando pretende começar.");
  if (f.contact_consent !== true) throw new FormError("Confirme que deseja receber contato sobre a franquia.");
  const given = (f.utm && typeof f.utm === "object" ? f.utm : {}) as Record<string, unknown>;
  const utm = Object.fromEntries(UTM_KEYS.filter((k) => given[k]).map((k) => [k, str(given[k], 500)]));
  return { eventId: f.event_id.toLowerCase(), name, phone, email, city, state, capital, start, utm, landingUrl: str(f.landing_url, 1000) };
}

/** The connection, kept only as a salted hash: enough to count its sends, not to know who it was. */
export function connectionKey(ip: string) {
  return createHash("sha256")
    .update(`${process.env.CRON_SECRET ?? "crm"}|${ip}`)
    .digest("hex")
    .slice(0, 32);
}

/** Creates the lead (or tells the team that a lead already here filled the form again). Sending twice changes nothing. */
export async function takeLandingLead(f: LandingLead, connection: string, now = new Date()) {
  const sent = await db.leadEvent.findFirst({ where: { type: "lead.form", data: { path: ["eventId"], equals: f.eventId } }, select: { leadId: true } });
  if (sent) return { leadId: sent.leadId, created: false, repeated: true };
  const recent = await db.leadEvent.count({
    where: { type: "lead.form", createdAt: { gte: new Date(now.getTime() - 3600_000) }, data: { path: ["connection"], equals: connection } },
  });
  if (recent >= PER_HOUR) throw new FormError("Muitos envios. Aguarde um pouco para tentar novamente.", 429);

  const pipeline = await pipelineByRef(FUNNEL);
  // The same keys the AI fills when it asks, so Duda and Alice do not ask again
  const qualification: Record<string, string> = {
    capital: f.capital,
    timeline: f.start,
    formulario: "Landing de franquia (franquia.banneg.com.br)",
    ...(f.landingUrl && { pagina: f.landingUrl }),
    ...f.utm,
  };
  const { lead, created } = await createLead(
    {
      name: f.name,
      phone: f.phone,
      email: f.email,
      city: f.city,
      state: f.state,
      source: FORM_SOURCE,
      campaign: f.utm.utm_campaign || "Landing franquia",
      pipelineId: pipeline?.id,
      qualification,
    },
    "Formulário da landing",
  );
  if (!created) {
    // Fills in what the lead had not told yet, never over what the AI already learned
    const known = (lead.qualification ?? {}) as Prisma.JsonObject;
    const missing = Object.fromEntries(Object.entries(qualification).filter(([k]) => !known[k]));
    if (Object.keys(missing).length) await db.lead.update({ where: { id: lead.id }, data: { qualification: { ...known, ...missing } } });
    await ensureTask(lead.id, lead.ownerId, AGAIN_TASK);
  }
  await logEvent(lead.id, "lead.form", "Formulário da landing", `Preencheu o formulário de franquia: capital ${f.capital}, quer começar ${f.start.toLowerCase()}. Aceitou receber contato por WhatsApp e e-mail.`, {
    eventId: f.eventId,
    connection,
    consent: true,
  });
  return { leadId: lead.id, created, repeated: false };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The form page, as the Codex redesign drew it: green and white, two columns on a computer, one on a phone. */
export function landingFormPage(postTo: string) {
  const options = (list: string[]) => list.map((o) => `<option>${esc(o)}</option>`).join("");
  const config = JSON.stringify({ postTo, parents: FORM_PARENTS, privacy: PRIVACY_URL }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Conheça sua franquia · BANNEG</title><style>
*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:#16382d;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}.card{max-width:680px;margin:auto;padding:28px;background:#fff;border:1px solid #dce8df;border-radius:22px;box-shadow:0 12px 40px #063e2210}.eyebrow{color:#007348;font-size:11px;font-weight:750;letter-spacing:1.5px;text-transform:uppercase}.top{display:flex;gap:12px;align-items:center}.brand{display:grid;place-items:center;width:42px;height:42px;border-radius:14px;background:#e5f5ea;color:#007348;font-weight:800;font-size:24px}h1{margin:14px 0 7px;font-size:27px;line-height:1.18;letter-spacing:-.7px}.intro{margin:0 0 22px;color:#65786d;font-size:14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:15px}.wide{grid-column:1/-1}label{display:block;font-size:12px;font-weight:650}input:not([type=checkbox]),select{width:100%;min-width:0;min-height:47px;display:block;margin-top:6px;border:1px solid #d7e3db;border-radius:10px;padding:12px;color:#183e2b;background:#f9fbf9;font:14px system-ui}input::placeholder{color:#91a097}input:focus,select:focus{outline:3px solid #a9ddbc;outline-offset:1px;border-color:#05814e}.section{font-size:10px;color:#728278;text-transform:uppercase;letter-spacing:1.3px;border-top:1px solid #edf1ee;padding-top:16px;margin:21px 0 14px;font-weight:750}.consent{display:flex;gap:9px;font-size:11px;line-height:1.6;font-weight:400;color:#66796c;margin-top:20px}.consent input{width:17px;height:17px;flex-shrink:0;margin:2px 0 0;accent-color:#007348}a{color:#007348}button{display:flex;justify-content:center;align-items:center;gap:18px;width:100%;margin-top:19px;border:0;border-radius:11px;padding:16px;background:#007348;color:#fff;font:700 15px system-ui;cursor:pointer;box-shadow:0 5px 13px #00734820}button:hover{background:#005e3b}button:disabled{opacity:.6;cursor:wait}.foot{text-align:center;font-size:10px;color:#7c8c81;margin:12px 0 0}.trap{position:absolute;left:-10000px}#status{font-size:14px;line-height:1.6}#status.error{color:#a12a2a;margin-top:14px}#status.success{padding:22px;background:#eaf7ef;border:1px solid #b8dfc7;border-radius:13px;color:#145739;margin-top:22px}@media(max-width:430px){body{padding:4px}.card{padding:21px 18px;border-radius:17px}h1{font-size:25px}.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body><main class="card"><div class="top"><span class="brand" aria-hidden="true">B</span><div><div class="eyebrow">Banneg · Expansão</div><div style="font-size:11px;color:#728278">Seu próximo negócio começa aqui</div></div></div><h1>Vamos conversar sobre<br>sua franquia?</h1><p class="intro">Conte um pouco sobre você. Nossa equipe ajuda a encontrar o modelo ideal para sua região.</p><form id="lead"><div class="grid"><label class="wide">Nome completo *<input name="name" autocomplete="name" required minlength="2" maxlength="200" placeholder="Como podemos chamar você?"></label><label>WhatsApp com DDD *<input name="phone" type="tel" autocomplete="tel" required maxlength="40" placeholder="(00) 00000-0000"></label><label>E-mail *<input name="email" type="email" autocomplete="email" required maxlength="200" placeholder="voce@email.com"></label><label>Cidade *<input name="city" autocomplete="address-level2" required minlength="2" maxlength="200" placeholder="Sua cidade"></label><label>Estado (UF) *<select name="state" autocomplete="address-level1" required><option value="">Selecione seu estado</option>${STATES.map(([uf, name]) => `<option value="${uf}">${uf} — ${esc(name)}</option>`).join("")}</select></label></div><div class="section">Seu momento de empreender</div><div class="grid"><label>Capital disponível *<select name="investment" required><option value="">Selecione uma faixa</option>${options(CAPITAL)}</select></label><label>Quando pretende começar? *<select name="start_window" required><option value="">Selecione um prazo</option>${options(START)}</select></label></div><label class="trap" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label><label class="consent"><input name="contact" type="checkbox" required><span>Quero receber contato do Banneg sobre a franquia por WhatsApp ou e-mail. Li a <a id="privacy" target="_blank" rel="noopener">política de privacidade</a>.</span></label><button type="submit">Quero conhecer a franquia <span aria-hidden="true">→</span></button><p class="foot">Cadastro gratuito · Sem compromisso</p></form><div id="status" role="status" aria-live="polite"></div></main><script>
const C=${config},q=new URLSearchParams(location.search),start=Date.now(),eventId=crypto.randomUUID();
const f=document.getElementById('lead'),status=document.getElementById('status'),button=f.querySelector('button');
document.getElementById('privacy').href=C.privacy;
const parentOrigin=C.parents.includes(q.get('parent_origin'))?q.get('parent_origin'):null;
function notify(data){if(parentOrigin&&parent!==window)parent.postMessage(data,parentOrigin)}
function height(){notify({type:'banneg-form-height',height:document.documentElement.scrollHeight,form:'principal'})}
new ResizeObserver(height).observe(document.body);
let pending=null;
f.addEventListener('submit',async e=>{e.preventDefault();if(button.disabled)return;button.disabled=true;status.className='';status.textContent='Enviando seu cadastro…';
try{if(!pending){const d=new FormData(f),utm={};for(const k of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid','utm_referrer'])if(q.get(k))utm[k]=q.get(k).slice(0,500);
pending={event_id:eventId,name:d.get('name'),phone:d.get('phone'),email:d.get('email'),city:d.get('city'),state:d.get('state'),investment:d.get('investment'),start_window:d.get('start_window'),website:d.get('website'),contact_consent:d.get('contact')==='on',elapsed_ms:Date.now()-start,utm,landing_url:(q.get('landing_url')||document.referrer||location.href).slice(0,1000)}}
const r=await fetch(C.postTo,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)});const result=await r.json().catch(()=>({}));
if(!r.ok||!result.saved){if(r.status>=400&&r.status<500&&r.status!==429)pending=null;throw Error(result.error||'Não foi possível confirmar o cadastro. Tente novamente.')}
f.hidden=true;status.className='success';status.textContent='Cadastro recebido! A equipe de expansão do Banneg vai falar com você no WhatsApp para apresentar os modelos e tirar suas dúvidas.';notify({type:'banneg-lead-confirmed',form:'principal',event_id:eventId});
}catch(error){status.className='error';status.textContent=error.message;button.disabled=false}height()});
</script></body></html>`;
}

/** Who may show the form in a frame; the page allows nothing else (no outside scripts, posts only to the CRM). */
export const FORM_CSP = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self' ${FORM_PARENTS.join(" ")}`;
