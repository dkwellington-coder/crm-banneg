import { z } from "zod";
import { createLead, ensureTask, moveLead, pickSdr, pipelineByRef, stageByKey } from "@/lib/leads";
import { db } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { SEND_ERROR_STAGE } from "@/lib/messaging";
import { STAGE_KEYS } from "@/lib/plan";

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
    Object.entries({ produto: b.produto, empresa: b.empresa, parceiro: b.parceiro, associado: union ? "associado do sindicato" : undefined }).filter(
      ([, v]) => !!v,
    ),
  ) as Record<string, string>;

  // A retry of a referral that already arrived (the portal gave up waiting and sent it again)
  if (b.ref) {
    const seen = await db.leadEvent.findFirst({ where: { type: "lead.form", data: { path: ["ref"], equals: b.ref } }, select: { leadId: true } });
    if (seen) return Response.json({ id: seen.leadId, created: false, moved: false, task: false, repeated: true, ...(await placeOf(seen.leadId)) });
  }

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
  let moved = false;
  let task = false;
  if (!created && b.parceiro) {
    ({ moved } = await referAgain(lead.id, pipeline?.id, b.parceiro, b.produto, source));
    // A person decides what to do with a contact the CRM already had, and the alert tells them
    const title = `Nova indicação da ${b.parceiro}${b.produto ? `: cotar ${b.produto}` : ""}`;
    await ensureTask(lead.id, lead.ownerId, title);
    // The same store referring again (a renewal next year): the open task rings again
    await db.task.updateMany({ where: { leadId: lead.id, title, doneAt: null }, data: { dueAt: new Date() } });
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

/**
 * A partner store referred a contact the CRM already had. A closed or queued lead starts over in the referral's funnel,
 * with this store and product, so the greeting goes out; one someone may be working (or a client already) stays where it is.
 */
async function referAgain(leadId: string, pipelineId: string | undefined, parceiro: string, produto: string | undefined, source: string) {
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, include: { stage: true } });
  const qualification = (lead.qualification ?? {}) as Record<string, unknown>;
  const closed = lead.stage.kind === "LOST" && lead.stage.key !== SEND_ERROR_STAGE.key;
  const entry =
    pipelineId && (closed || lead.stage.key === "fila") && !lead.whatsappOptOut
      ? ((await stageByKey(STAGE_KEYS.NEW, pipelineId)) ?? (await db.stage.findFirst({ where: { pipelineId, kind: "OPEN" }, orderBy: { position: "asc" } })))
      : null;
  if (entry) {
    // Starts over like a new lead: this store and product (never an old product), an SDR and the AI on
    const rest = { ...qualification };
    delete rest.produto;
    await moveLead(leadId, entry.id, `Formulário (${source})`, {
      qualification: { ...rest, parceiro, ...(produto && { produto }) },
      status: "NEW",
      lostReason: null,
      aiPaused: false,
      sdrId: lead.sdrId ?? (await pickSdr())?.id ?? null,
    });
    return { moved: true };
  }
  // Only fills what is missing: the lead's current conversation keeps the store and product it already has
  if (!qualification.parceiro || (produto && !qualification.produto)) {
    await db.lead.update({
      where: { id: leadId },
      data: { qualification: { ...qualification, parceiro: qualification.parceiro ?? parceiro, ...(produto && !qualification.produto && { produto }) } },
    });
  }
  return { moved: false };
}
