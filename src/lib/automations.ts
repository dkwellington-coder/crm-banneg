import type { AutomationRule, Lead, Prisma, Stage } from "@prisma/client";
import { db } from "./db";
import { enqueue } from "./queue";
import { matchesAnswer, ruleRunAt, type RuleConfig } from "./rules";
import { REFERRAL_FUNNEL, STAGE_KEYS } from "./plan";

export type RuleJobPayload = {
  ruleId: string;
  stageId: string;
  // When the lead entered the stage; a later re-entry is a different run
  enteredAt: string;
  idle: boolean;
  // runAfterLeaving: survives the lead moving on
  keep: boolean;
  // idle rules: the lead must not have written after this
  since: string;
};

/**
 * Schedules the stage's rules for a lead that just entered it ("enter" and "idle"), or only the
 * "idle" ones again after the lead wrote back, which restarts the "sem resposta" clock.
 */
export async function scheduleStageRules(lead: Pick<Lead, "id" | "stageId" | "stageEnteredAt">, only?: "idle") {
  const rules = await db.automationRule.findMany({
    // "daily" rules are not per lead: the batch runner releases a few leads a day (lib/batches)
    where: { stageId: lead.stageId, active: true, trigger: only ?? { in: ["enter", "idle"] } },
    orderBy: { position: "asc" },
  });
  const now = new Date();
  for (const rule of rules) {
    const idle = rule.trigger === "idle";
    const base = idle ? now : lead.stageEnteredAt;
    const payload: RuleJobPayload = {
      ruleId: rule.id,
      stageId: lead.stageId,
      enteredAt: lead.stageEnteredAt.toISOString(),
      idle,
      keep: rule.runAfterLeaving,
      since: now.toISOString(),
    };
    await enqueue("rule.run", {
      leadId: lead.id,
      payload,
      runAt: ruleRunAt(base, rule.delayMinutes, rule.position),
      dedupeKey: `rule:${rule.id}:${lead.id}:${idle ? now.toISOString() : payload.enteredAt}`,
      maxAttempts: rule.action === "whatsapp" || rule.action === "email" ? 5 : 3,
    });
  }
  return rules.length;
}

/**
 * The lead answered: runs the stage's "answer" rules whose answer matches (usually the button it
 * tapped), in order. Says whether any matched, so the AI stays quiet while the stage's own
 * messages answer, unless a rule asks the AI to answer too.
 */
export async function scheduleAnswerRules(lead: Pick<Lead, "id" | "stageId" | "stageEnteredAt">, body: string, messageKey: string) {
  const rules = await db.automationRule.findMany({
    where: { stageId: lead.stageId, active: true, trigger: "answer" },
    orderBy: { position: "asc" },
  });
  const matched = rules.filter((r) => matchesAnswer(body, (r.config as RuleConfig).answers));
  const now = new Date();
  for (const rule of matched) {
    const payload: RuleJobPayload = {
      ruleId: rule.id,
      stageId: lead.stageId,
      enteredAt: lead.stageEnteredAt.toISOString(),
      idle: false,
      keep: false,
      since: now.toISOString(),
    };
    await enqueue("rule.run", {
      leadId: lead.id,
      payload,
      runAt: ruleRunAt(now, rule.delayMinutes, rule.position),
      dedupeKey: `rule:${rule.id}:${lead.id}:answer:${messageKey}`,
      maxAttempts: rule.action === "whatsapp" || rule.action === "email" ? 5 : 3,
    });
  }
  return { matched: matched.length > 0, aiReplies: matched.some((r) => (r.config as RuleConfig).aiReplies) };
}

/**
 * Cancels pending rule runs: the idle ones when the lead answers, the stage-bound ones when it
 * moves on, and all of them when the deal closes.
 */
export async function cancelRuleJobs(leadId: string, which: "idle" | "stage" | "all") {
  const filter: Prisma.JobWhereInput =
    which === "idle"
      ? { payload: { path: ["idle"], equals: true } }
      : which === "stage"
        ? { payload: { path: ["keep"], equals: false } }
        : {};
  await db.job.updateMany({
    where: { leadId, type: "rule.run", status: "PENDING", ...filter },
    data: {
      status: "CANCELLED",
      finishedAt: new Date(),
      dedupeKey: null,
      result: which === "idle" ? "Cancelado: o lead respondeu." : which === "stage" ? "Cancelado: o lead mudou de etapa." : "Cancelado: negócio encerrado.",
    },
  });
}

/**
 * A greeting that waits for the lead: a WhatsApp some minutes after the lead lands in its funnel's first stage, for a
 * store's referral to that funnel or in a funnel that talks from its own number (Alice's). A lead who writes first (the
 * store's QR code) is answered by the AI instead, for free inside Meta's window. Elsewhere such a message goes as always.
 */
export async function isGreeting(
  rule: Pick<AutomationRule, "trigger" | "action" | "delayMinutes"> & { stage: Pick<Stage, "id" | "pipelineId"> },
  lead: Pick<Lead, "qualification">,
) {
  if (rule.trigger !== "enter" || rule.action !== "whatsapp" || rule.delayMinutes <= 0) return false;
  const pipelineId = rule.stage.pipelineId;
  const referred = (lead.qualification as Record<string, unknown> | null)?.[REFERRAL_FUNNEL] === pipelineId;
  if (!referred) {
    const funnel = await db.pipeline.findUnique({ where: { id: pipelineId }, select: { whatsappNumberId: true } });
    if (!funnel?.whatsappNumberId || funnel.whatsappNumberId === process.env.WHATSAPP_PHONE_NUMBER_ID) return false;
  }
  // Where createLead puts new leads: the "novo" stage, else the first one
  const entry =
    (await db.stage.findUnique({ where: { pipelineId_key: { pipelineId, key: STAGE_KEYS.NEW } } })) ??
    (await db.stage.findFirst({ where: { pipelineId }, orderBy: { position: "asc" } }));
  return entry?.id === rule.stage.id;
}

/** The lead wrote first: the greetings waiting for it are cancelled, the AI answers the message. */
export async function cancelGreetings(leadId: string) {
  const pending = await db.job.findMany({ where: { leadId, type: "rule.run", status: "PENDING" }, select: { id: true, payload: true } });
  if (!pending.length) return 0;
  const ruleOf = (j: { payload: Prisma.JsonValue }) => (j.payload as RuleJobPayload).ruleId;
  const rules = await db.automationRule.findMany({ where: { id: { in: pending.map(ruleOf) } }, include: { stage: true } });
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { qualification: true } });
  if (!lead) return 0;
  const greetings = new Set<string>();
  for (const rule of rules) if (await isGreeting(rule, lead)) greetings.add(rule.id);
  const ids = pending.filter((j) => greetings.has(ruleOf(j))).map((j) => j.id);
  if (!ids.length) return 0;
  await db.job.updateMany({
    where: { id: { in: ids }, status: "PENDING" },
    data: { status: "CANCELLED", finishedAt: new Date(), dedupeKey: null, result: "Cancelado: o lead escreveu primeiro." },
  });
  return ids.length;
}
