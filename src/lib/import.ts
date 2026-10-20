import type { LeadStatus, Prisma } from "@prisma/client";
import { db } from "./db";
import { mapRow, parseCsv } from "./csv";
import { funnelStart, pipelineByRef, pickSdr, startAutomations } from "./leads";
import { normalizePhone, phoneVariants } from "./whatsapp";

const CHUNK = 500;

type Target = { pipelineId: string; open: string; optOut: string; lost: string; whatsappNumberId: string | null; sdrId: string | null };

/** Where imported leads land in a funnel: the queue when it has one, Descartado and Perdido for the rest. */
async function targetFor(pipelineId: string): Promise<Target> {
  const stages = await db.stage.findMany({ where: { pipelineId }, orderBy: { position: "asc" } });
  if (!stages.length) throw new Error("Este funil não tem etapas.");
  const byKey = (k: string) => stages.find((s) => s.key === k)?.id;
  const firstLost = stages.find((s) => s.kind === "LOST")?.id;
  const open = byKey("fila") ?? byKey("novo") ?? stages[0].id;
  const optOut = byKey("descartado") ?? firstLost ?? open;
  // The funnel's own WhatsApp number and SDR, as for a lead created there one by one
  const funnel = await funnelStart(pipelineId);
  return { pipelineId, open, optOut, lost: byKey("perdido") ?? optOut, whatsappNumberId: funnel.whatsappNumberId, sdrId: funnel.sdr?.id ?? null };
}

/**
 * Imports a CSV in bulk (thousands of rows in a few seconds). Each lead goes to the funnel named
 * in its "funil" column or to the one the import was started from, into its queue ("Na fila") when
 * it has one. Who asked not to be contacted goes to Descartado with both opt-outs on, lost leads to
 * Perdido, won ones are left out. Leads already in the CRM (same phone, with or without the 9, or
 * same e-mail) and repeated rows are skipped. Nothing is sent unless startAi is on.
 */
export async function importLeads(text: string, opts: { pipelineId: string; startAi: boolean; actor: string }) {
  const rows = parseCsv(text).map(mapRow);
  // Phones (both ways, with and without the 9) and e-mails already in the CRM, then the ones seen in the file
  const inCrm = new Set<string>();
  for (const l of await db.lead.findMany({ select: { phone: true, email: true } })) {
    if (l.phone) for (const v of phoneVariants(l.phone)) inCrm.add(v);
    if (l.email) inCrm.add(l.email.toLowerCase());
  }
  const inFile = new Set<string>();
  const targets = new Map<string, Target>();
  const target = async (ref: string | null) => {
    const pipelineId = (ref && (await pipelineByRef(ref))?.id) || opts.pipelineId;
    if (!targets.has(pipelineId)) targets.set(pipelineId, await targetFor(pipelineId));
    return targets.get(pipelineId)!;
  };
  const sdrs = await db.sdrAgent.findMany({ where: { active: true }, select: { id: true } });
  const first = await pickSdr();
  if (first) sdrs.sort((a, b) => (a.id === first.id ? -1 : b.id === first.id ? 1 : 0));

  const count = { created: 0, queued: 0, optOut: 0, lost: 0, existing: 0, repeated: 0, won: 0, empty: 0 };
  const data: Prisma.LeadCreateManyInput[] = [];
  // Each lead's history line, by phone|e-mail (what createManyAndReturn hands back)
  const notes = new Map<string, string>();
  for (const row of rows) {
    const phone = row.phone ? normalizePhone(row.phone) : null;
    const email = row.email?.trim().toLowerCase() || null;
    if (!phone && !email) {
      count.empty++;
      continue;
    }
    if (row.won) {
      count.won++;
      continue;
    }
    // With a phone, the phone decides (two people can share an e-mail); without one, the e-mail
    const keys = phone ? phoneVariants(phone) : [email!];
    if (keys.some((k) => inCrm.has(k))) {
      count.existing++;
      continue;
    }
    if (keys.some((k) => inFile.has(k))) {
      count.repeated++;
      continue;
    }
    keys.forEach((k) => inFile.add(k));
    const t = await target(row.funnel);
    const [stageId, status, lostReason]: [string, LeadStatus, string | null] = row.optOut
      ? [t.optOut, "DISQUALIFIED", "Pediu para não receber mensagens."]
      : row.lost
        ? [t.lost, "LOST", row.oldStage ? `Perdido antes da importação (${row.oldStage}).` : "Perdido antes da importação."]
        : [t.open, "NEW", null];
    if (row.optOut) count.optOut++;
    else if (row.lost) count.lost++;
    else count.queued++;
    const before = [row.oldStage && `etapa "${row.oldStage}"`, row.oldStatus && `status ${row.oldStatus}`].filter(Boolean).join(", ");
    const contact = row.lastContactAt ? `, último contato em ${row.lastContactAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : "";
    const index = data.length;
    notes.set(`${phone ?? ""}|${email ?? ""}`, `Importado (origem: ${row.source}${before ? `; antes estava em ${before}` : ""}${contact}).`);
    data.push({
      name: row.name ?? null,
      phone,
      email,
      city: row.city?.trim() || null,
      state: row.state?.trim() || null,
      source: row.source,
      campaign: row.campaign || null,
      externalId: row.externalId ?? null,
      pipelineId: t.pipelineId,
      stageId,
      status,
      lostReason,
      whatsappOptOut: row.optOut,
      emailOptOut: row.optOut,
      lastContactAt: row.lastContactAt,
      // Whoever imported the file knows these leads: they wait in the queue without lighting the "new lead" alert
      seenAt: new Date(),
      sdrId: t.sdrId ?? (sdrs.length ? sdrs[index % sdrs.length].id : null),
      whatsappNumberId: t.whatsappNumberId,
      ...(row.createdAt && { createdAt: row.createdAt }),
    });
  }

  const created: { id: string; stageId: string; status: LeadStatus }[] = [];
  for (let i = 0; i < data.length; i += CHUNK) {
    const part = data.slice(i, i + CHUNK);
    // skipDuplicates covers a phone that reached the CRM by WhatsApp during the import
    const rowsIn = await db.lead.createManyAndReturn({ data: part, skipDuplicates: true, select: { id: true, phone: true, email: true, stageId: true, status: true } });
    await db.leadEvent.createMany({
      data: rowsIn.map((l) => ({
        leadId: l.id,
        type: "lead.created",
        actor: opts.actor,
        summary: notes.get(`${l.phone ?? ""}|${l.email ?? ""}`) ?? "Importado.",
      })),
    });
    created.push(...rowsIn);
  }
  count.created = created.length;
  if (opts.startAi) {
    for (const l of created) if (l.status === "NEW") await startAutomations(await db.lead.findUniqueOrThrow({ where: { id: l.id } }));
  }
  return count;
}

export function importSummary(c: Awaited<ReturnType<typeof importLeads>>) {
  const parts = [`${c.created} leads importados: ${c.queued} para atender, ${c.optOut} que pediram para não receber mensagens (em Descartado), ${c.lost} perdidos.`];
  const skipped = [
    c.existing && `${c.existing} já estavam no CRM`,
    c.repeated && `${c.repeated} repetidos no arquivo`,
    c.won && `${c.won} já fechados`,
    c.empty && `${c.empty} sem telefone nem e-mail`,
  ].filter(Boolean);
  if (skipped.length) parts.push(`Ficaram de fora: ${skipped.join(", ")}.`);
  return parts.join(" ");
}
