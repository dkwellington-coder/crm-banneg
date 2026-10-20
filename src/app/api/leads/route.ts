import { z } from "zod";
import { adoptReferral, createLead, joinedInto, leadThatQuoted, pipelineByRef, referExisting, type NewLeadInput } from "@/lib/leads";
import { cancelGreetings } from "@/lib/automations";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { REFERRAL_FUNNEL } from "@/lib/plan";
import { isWindowOpen, normalizePhone, phoneVariants } from "@/lib/whatsapp";

const text = (max: number) => z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v).trim().slice(0, max)).optional();

// English keys (our own forms) or Portuguese ones (Clube Sincomércio and the older landing pages)
const LeadInput = z.object({
  name: text(200),
  nome: text(200),
  phone: text(40),
  whatsapp: text(40),
  telefone: text(40),
  email: text(200),
  city: text(120),
  cidade: text(120),
  state: text(60),
  estado: text(60),
  source: text(80),
  origem: text(80),
  campaign: text(200),
  campanha: text(200),
  // Which funnel: its short name ("sindicatos", "produtos") or its name
  pipeline: text(80),
  funil: text(80),
  produto: text(120),
  empresa: text(160),
  indicado_nome: text(160),
  indicado_whatsapp: text(40),
  // Portal de indicações: the partner store that referred the client ({{parceiro}}) and the client's file as text
  parceiro: text(160),
  observacao: text(4000),
  // The sender's id for this request ("portal:<id>"): the same referral sent again changes nothing
  ref: text(120),
  associado_sindicato: z.union([z.boolean(), z.string()]).optional(),
});

function authorized(header: string | null) {
  // One token per site, so one can be revoked without breaking the others
  const tokens = [process.env.LEADS_API_TOKEN, process.env.SITE_LEADS_TOKEN, process.env.PORTAL_LEADS_TOKEN].filter(Boolean);
  return tokens.some((t) => header === `Bearer ${t}`);
}

// Site forms, landing pages and ad integrations post new leads here.
export async function POST(request: Request) {
  if (!authorized(request.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = LeadInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  const phone = b.phone || b.whatsapp || b.telefone;
  const email = b.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) ? b.email : undefined;
  if (!phone && !email) return Response.json({ error: "phone or email required" }, { status: 400 });

  const union = b.associado_sindicato === true || b.associado_sindicato === "true" || /sincomercio|sindicato/i.test(`${b.campanha ?? ""} ${b.funil ?? ""}`);
  const pipeline = (await pipelineByRef(b.pipeline || b.funil)) ?? (union ? await pipelineByRef("sindicatos") : null);
  const source = b.source || b.origem || "site";
  const qualification = Object.fromEntries(
    Object.entries({
      produto: b.produto,
      empresa: b.empresa,
      parceiro: b.parceiro,
      // The funnel the store referred the client to: the AI speaks for the store only there
      [REFERRAL_FUNNEL]: b.parceiro ? pipeline?.id : undefined,
      associado: union ? "associado do sindicato" : undefined,
    }).filter(([, v]) => !!v),
  ) as Record<string, string>;

  // A referral must land in its own funnel: never in the default one, greeted with another funnel's pitch
  if ((b.ref || b.parceiro) && (b.pipeline || b.funil) && !pipeline) {
    return Response.json({ error: `funil '${b.pipeline || b.funil}' não existe no CRM` }, { status: 422 });
  }

  // A retry of a referral that already arrived: the lead it created carries the ref, a contact the CRM had gets it on its timeline
  if (b.ref) {
    const seen =
      (await db.lead.findFirst({ where: { externalId: b.ref }, select: { id: true } }))?.id ??
      (await db.leadEvent.findFirst({ where: { type: "lead.form", data: { path: ["ref"], equals: b.ref } }, select: { leadId: true } }))?.leadId;
    if (seen) return Response.json({ id: seen, created: false, moved: false, task: false, repeated: true, ...(await placeOf(seen)) });
  }

  const input: NewLeadInput = {
    name: b.name || b.nome,
    phone,
    email,
    city: b.city || b.cidade,
    state: b.state || b.estado,
    source,
    campaign: b.campaign || b.campanha,
    externalId: b.ref,
    pipelineId: pipeline?.id,
    qualification,
  };
  const actor = `Formulário (${source})`;
  // The client sent the store's ready message ("Pedido ABC123") before the referral got here, maybe from another phone:
  // a conversation that began with it is this referral's new lead; a contact the CRM had is referred again
  const wrote = b.ref ? await leadThatQuoted(b.ref, input.name) : null;
  const found = !wrote
    ? await createLead(input, actor)
    : wrote.own
      ? { lead: await adoptReferral(wrote.lead, input, actor), created: true }
      : { lead: wrote.lead, created: false };
  const created = found.created;
  // The phone the store typed for a client whose referral went on in the lead she wrote from: referred again, she goes there
  const lead = (!wrote && !created && b.parceiro ? await joinedInto(found.lead, input.name) : null) ?? found.lead;
  if (wrote && !wrote.own) {
    const typed = phone ? normalizePhone(phone) : null;
    const elsewhere = typed && lead.phone && !phoneVariants(lead.phone).includes(typed) ? `; a loja informou o número ${typed}` : "";
    await logEvent(lead.id, "lead.duplicate", actor, `Entrou de novo pela origem "${source}": já tinha escrito com o código desta indicação${elsewhere}.`);
  }
  if (!created && b.produto) await logEvent(lead.id, "lead.form", "Formulário", `Pediu informações de ${b.produto} de novo.`);
  let moved = false;
  let task = false;
  if (!created && b.parceiro) {
    ({ moved } = await referExisting(lead.id, pipeline?.id, b.parceiro, b.produto, actor));
    // The client already wrote this referral's message and is still in Meta's window (maybe answered since): no greeting
    // waits for her. Written more than 24 h ago, the greeting is the only way back to her and goes
    if (wrote && isWindowOpen(wrote.lead.lastInboundAt)) await cancelGreetings(lead.id);
    task = true;
  }
  if (b.observacao || b.ref) await logEvent(lead.id, "lead.form", source, b.observacao || "Indicação recebida.", b.ref ? { ref: b.ref } : undefined);

  // The member referred someone: that person becomes a lead too, credited to who referred
  let referral: string | undefined;
  if (b.indicado_whatsapp && b.indicado_whatsapp.replace(/\D/g, "").length >= 10) {
    const r = await createLead(
      {
        name: b.indicado_nome,
        phone: b.indicado_whatsapp,
        source: `Indicação de ${b.name || b.nome || "associado"}`,
        campaign: b.campaign || b.campanha,
        pipelineId: pipeline?.id,
        qualification: Object.fromEntries(Object.entries({ produto: b.produto, indicadoPor: b.name || b.nome }).filter(([, v]) => !!v)) as Record<string, string>,
      },
      "Indicação",
    );
    referral = r.lead.id;
  }
  return Response.json({ id: lead.id, created, referral, moved, task, ...(await placeOf(lead.id)) }, { status: created ? 201 : 200 });
}

/** The funnel and column the lead is in, by name, so the sender can say where it went. */
async function placeOf(leadId: string) {
  const l = await db.lead.findUnique({ where: { id: leadId }, select: { pipeline: { select: { name: true } }, stage: { select: { name: true } } } });
  return { pipeline: l?.pipeline.name ?? null, stage: l?.stage.name ?? null };
}
