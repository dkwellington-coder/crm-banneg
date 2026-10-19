import { z } from "zod";
import { createLead, pipelineByRef } from "@/lib/leads";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";

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
    Object.entries({ produto: b.produto, empresa: b.empresa, parceiro: b.parceiro, associado: union ? "associado do sindicato" : undefined }).filter(
      ([, v]) => !!v,
    ),
  ) as Record<string, string>;

  const { lead, created } = await createLead(
    {
      name: b.name || b.nome,
      phone,
      email,
      city: b.city || b.cidade,
      state: b.state || b.estado,
      source,
      campaign: b.campaign || b.campanha,
      pipelineId: pipeline?.id,
      qualification,
    },
    `Formulário (${source})`,
  );
  if (!created && b.produto) await logEvent(lead.id, "lead.form", "Formulário", `Pediu informações de ${b.produto} de novo.`);
  // A lead that already existed keeps its funnel, but learns which store sent it this time
  if (!created && b.parceiro) {
    await db.lead.update({ where: { id: lead.id }, data: { qualification: { ...(lead.qualification as object), parceiro: b.parceiro } } });
  }
  if (b.observacao) await logEvent(lead.id, "lead.form", source, b.observacao);

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
  return Response.json({ id: lead.id, created, referral }, { status: created ? 201 : 200 });
}
