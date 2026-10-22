import { createHash } from "node:crypto";
import type { Lead } from "@prisma/client";
import { db } from "./db";
import { cycleStart, REF_EVENTS } from "./portal-status";

// A policy is a PDF or a photo of it; sent in pieces, since a Vercel request takes at most 4.5 MB
export const MAX_LEAD_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const APOLICE = "APOLICE";

const TYPES: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
const ACCEPTED = new Set(Object.values(TYPES));

/** The accepted type of a file: what the browser said, else its extension (some browsers say nothing). null when refused. */
export function leadDocumentType(name: string, mimeType?: string | null) {
  if (mimeType && ACCEPTED.has(mimeType)) return mimeType;
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/** The first bytes match the type, so a renamed file is never served back as a PDF or an image. */
function looksLike(mimeType: string, data: Uint8Array) {
  const head = Buffer.from(data.subarray(0, 1024));
  if (mimeType === "application/pdf") return head.includes("%PDF-");
  if (mimeType === "image/jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mimeType === "image/png") return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return false;
}

/** Starts an upload: an empty file the pieces are added to. */
export async function startLeadDocument(leadId: string, file: { name?: string; mimeType?: string; size?: number }, uploadedBy: string) {
  const name = file.name?.trim().slice(0, 200);
  if (!name || !file.size) return { error: "Arquivo sem nome ou vazio." };
  if (file.size > MAX_LEAD_DOCUMENT_BYTES) return { error: "Arquivo maior que 20 MB." };
  const mimeType = leadDocumentType(name, file.mimeType);
  if (!mimeType) return { error: "Envie a apólice ou o contrato em PDF, JPG ou PNG." };
  // Uploads someone gave up on long ago, on any lead, only take space
  await db.leadDocument.deleteMany({ where: { sha256: null, createdAt: { lt: new Date(Date.now() - 86_400_000) } } });
  const doc = await db.leadDocument.create({
    data: { leadId, kind: APOLICE, name, mimeType, size: file.size, data: new Uint8Array(0), uploadedBy },
    select: { id: true },
  });
  return { id: doc.id };
}

/** One piece, added to the end of the file. False when the upload is not this lead's, already finished, or would get too big. */
export async function appendLeadDocumentChunk(id: string, leadId: string, chunk: Uint8Array) {
  const added = await db.$executeRaw`UPDATE "LeadDocument" SET data = data || ${chunk}
    WHERE id = ${id} AND "leadId" = ${leadId} AND sha256 IS NULL AND octet_length(data) + ${chunk.length} <= ${MAX_LEAD_DOCUMENT_BYTES}`;
  return added > 0;
}

/** A finished upload: its real size and fingerprint (SHA-256). A file that is not what its type says is thrown away. */
export async function finishLeadDocument(id: string, leadId: string) {
  const doc = await db.leadDocument.findFirst({ where: { id, leadId, sha256: null }, select: { data: true, mimeType: true } });
  if (!doc) return { error: "Envio não encontrado ou já concluído." };
  if (!doc.data.length || !looksLike(doc.mimeType, doc.data)) {
    await db.leadDocument.delete({ where: { id } });
    return { error: "O arquivo não é um PDF, JPG ou PNG válido." };
  }
  const sha256 = createHash("sha256").update(doc.data).digest("hex");
  return db.leadDocument.update({
    where: { id },
    data: { sha256, size: doc.data.length },
    select: { id: true, name: true, size: true, sha256: true, mimeType: true },
  });
}

/**
 * The lead has a finished policy for its current sale. One attached before the lead started over (another referral, or a
 * won deal reopened) was for the earlier sale (cycleStart), so a renewal is never won on last year's policy. leaving: the
 * lead is about to leave its stage (cycleStart), so the move that brought it there is already behind it.
 */
export async function hasApolice(lead: Pick<Lead, "id" | "stageEnteredAt">, leaving = false) {
  const events = await db.leadEvent.findMany({ where: { leadId: lead.id, type: { in: REF_EVENTS } }, select: { data: true, createdAt: true } });
  const reached = cycleStart(events, lead.stageEnteredAt.toISOString(), leaving);
  // The new sale starts when the lead leaves the close the referral found: a policy attached before that (a sale won by
  // a rule, its policy sent later) is still the earlier sale's. The move into the stage the lead is in is logged just
  // after its stageEnteredAt and only counts once the lead leaves it: the policy the person attached to win straight out
  // of that close is the new sale's
  const until = leaving ? {} : { lt: lead.stageEnteredAt };
  const left = reached
    ? await db.leadEvent.findFirst({
        where: { leadId: lead.id, type: "stage.changed", createdAt: { gt: reached, ...until } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      })
    : null;
  const since = left?.createdAt ?? reached;
  const where = { leadId: lead.id, kind: APOLICE, sha256: { not: null }, ...(since && { createdAt: { gte: since } }) };
  return (await db.leadDocument.count({ where })) > 0;
}
