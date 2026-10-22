import type { StageKind } from "@prisma/client";

// Cotações, the funnel the Portal de indicações sends the stores' clients to
export const QUOTES_FUNNEL = "parceiro-veiculos";

export type StageMoveBlock = { need: "reason" | "apolice" | "reopen"; error: string };
// What the move action answers the screen: nothing when the lead moved
export type MoveResult = { error?: string; need?: StageMoveBlock["need"] };
/**
 * What happened to a won sale a person takes back to an open stage. new: a new deal starts, and the store keeps the sale
 * closed. undone: the sale did not happen, and the store follows the lead again.
 */
export type ReopenChoice = "new" | "undone";
export const isReopenChoice = (v: unknown): v is ReopenChoice => v === "new" || v === "undone";

type MoveLead = { stageId: string; externalId: string | null; pipeline: { slug: string | null }; stage?: { kind: StageKind } };
type MoveStage = { id: string; kind: StageKind; pipeline?: { slug: string | null } | null };

/** A quote (or any store's referral) is only won with its policy attached: the store is told it was issued. */
export function needsApolice(lead: Pick<MoveLead, "externalId" | "pipeline">, stage?: Pick<MoveStage, "pipeline">) {
  return lead.pipeline.slug === QUOTES_FUNNEL || stage?.pipeline?.slug === QUOTES_FUNNEL || !!lead.externalId?.startsWith("portal:");
}

/**
 * What a person must give before moving a lead to this stage: the reason of a loss (the store reads it), the policy of
 * a won quote, and what happened to a won sale taken back to an open stage while a store still follows the lead
 * (storeFollows): only the person knows whether the store's sale stands. null when the move may go. Automatic moves do
 * not pass here.
 */
export function checkStageMove(
  lead: MoveLead,
  stage: MoveStage,
  { reason, hasApolice, storeFollows = false, reopen }: { reason?: string | null; hasApolice: boolean; storeFollows?: boolean; reopen?: ReopenChoice | null },
): StageMoveBlock | null {
  if (lead.stageId === stage.id) return null;
  if (stage.kind === "LOST" && !reason?.trim()) return { need: "reason", error: "Informe o motivo da perda." };
  if (stage.kind === "WON" && needsApolice(lead, stage) && !hasApolice) return { need: "apolice", error: "Anexe a apólice (no consórcio, o contrato) antes de marcar como Ganho." };
  if (lead.stage?.kind === "WON" && stage.kind === "OPEN" && storeFollows && !isReopenChoice(reopen)) {
    return { need: "reopen", error: "Diga se a venda foi desfeita ou se é um novo atendimento." };
  }
  return null;
}
