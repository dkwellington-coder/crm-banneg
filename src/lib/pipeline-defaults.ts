import type { PrismaClient, StageKind } from "@prisma/client";

/**
 * The "Expansão" funnel the CRM ships with. Its stage keys are what the AI SDR moves leads by;
 * every automation below is an ordinary rule the team can edit or switch off on the funnel editor.
 */
export const DEFAULT_STAGES: { key: string; name: string; color: string; kind?: StageKind }[] = [
  { key: "novo", name: "Novo", color: "#64748b" },
  { key: "qualificando", name: "IA qualificando", color: "#0ea5e9" },
  { key: "qualificado", name: "Qualificado", color: "#8b5cf6" },
  { key: "reuniao", name: "Reunião marcada", color: "#f59e0b" },
  { key: "nao_compareceu", name: "Não compareceu", color: "#f97316" },
  { key: "com_gerente", name: "Com o gerente", color: "#ec4899" },
  { key: "proposta", name: "Proposta enviada", color: "#14b8a6" },
  { key: "nutricao", name: "Nutrição", color: "#94a3b8" },
  { key: "ganho", name: "Ganho", color: "#16a34a", kind: "WON" },
  { key: "perdido", name: "Perdido", color: "#dc2626", kind: "LOST" },
  { key: "descartado", name: "Descartado", color: "#71717a", kind: "LOST" },
];

/** The message after a missed meeting; outside the 24 h window it goes as this approved template. */
export const NO_SHOW_TEMPLATE = {
  name: "banneg_reuniao_nao_compareceu",
  category: "UTILITY",
  // Its own purpose: a message typed outside the window never borrows it
  purpose: "no_show",
  body: "Poxa, {{1}}, você não conseguiu participar da nossa reunião. Ainda tem interesse em conversar sobre a franquia do Banneg? Se sim, me responda aqui que a gente reagenda.",
  buttons: ["Quero reagendar", "Agora não"],
} as const;

const NO_SHOW_MESSAGE = {
  text: "Poxa, {{nome}}, você não conseguiu participar da nossa reunião. Ainda tem interesse em conversar sobre a franquia do Banneg? Se sim, me responda aqui que a gente reagenda.",
  buttons: [...NO_SHOW_TEMPLATE.buttons],
  templateName: NO_SHOW_TEMPLATE.name,
  templateParams: ["nome"],
};

const MIN = 1;
const HOUR = 60;
const DAY = 24 * HOUR;

type DefaultRule = {
  stage: string;
  trigger?: "enter" | "idle" | "answer";
  delay: number;
  action: string;
  // toStage is a stage key, resolved to an id when installed
  config?: {
    text?: string;
    templateKey?: string;
    title?: string;
    toStage?: string;
    templateName?: string;
    templateParams?: string[];
    buttons?: string[];
    answers?: string[];
  };
  runAfterLeaving?: boolean;
};

export const DEFAULT_RULES: DefaultRule[] = [
  { stage: "novo", delay: 0, action: "ai_on" },
  { stage: "novo", delay: 5 * MIN, action: "email", config: { templateKey: "boas_vindas_0" }, runAfterLeaving: true },
  { stage: "novo", delay: 2 * DAY, action: "email", config: { templateKey: "boas_vindas_2" }, runAfterLeaving: true },
  { stage: "novo", delay: 5 * DAY, action: "email", config: { templateKey: "boas_vindas_5" }, runAfterLeaving: true },
  {
    stage: "qualificando",
    trigger: "idle",
    delay: 1 * DAY,
    action: "whatsapp",
    config: { text: "Oi, {{nome}}! Conseguiu ver minha mensagem? Fico à disposição para tirar suas dúvidas sobre a franquia." },
  },
  {
    stage: "qualificando",
    trigger: "idle",
    delay: 3 * DAY,
    action: "whatsapp",
    config: { text: "{{nome}}, passando para saber se ainda faz sentido conversarmos sobre a franquia {{empresa}}." },
  },
  {
    stage: "qualificando",
    trigger: "idle",
    delay: 7 * DAY,
    action: "whatsapp",
    config: { text: "Vou encerrar por aqui para não te incomodar, {{nome}}. Se quiser retomar, é só responder esta mensagem." },
  },
  { stage: "qualificando", trigger: "idle", delay: 8 * DAY, action: "move", config: { toStage: "nutricao" } },
  { stage: "qualificado", delay: 2 * DAY, action: "task", config: { title: "Lead qualificado há 2 dias sem reunião: ligar" } },
  // Missed the meeting: the AI comes back to offer new times; a few minutes undo a card dragged here by mistake
  { stage: "nao_compareceu", delay: 0, action: "ai_on" },
  { stage: "nao_compareceu", delay: 2 * MIN, action: "whatsapp", config: NO_SHOW_MESSAGE },
  {
    stage: "nao_compareceu",
    trigger: "answer",
    delay: 0,
    action: "whatsapp",
    config: { answers: ["Agora não"], text: "Tudo bem, {{nome}}! Obrigado por avisar. Quando quiser retomar, é só me chamar aqui." },
  },
  { stage: "nao_compareceu", trigger: "answer", delay: 1 * MIN, action: "move", config: { answers: ["Agora não"], toStage: "nutricao" } },
  { stage: "nao_compareceu", trigger: "idle", delay: 2 * DAY, action: "move", config: { toStage: "nutricao" } },
  { stage: "com_gerente", delay: 3 * DAY, action: "task", config: { title: "Lead com o gerente há 3 dias: dar retorno" } },
  { stage: "proposta", trigger: "idle", delay: 2 * DAY, action: "task", config: { title: "Cobrar retorno da proposta enviada" } },
  { stage: "nutricao", delay: 7 * DAY, action: "email", config: { templateKey: "nutricao_7" } },
  { stage: "nutricao", delay: 30 * DAY, action: "email", config: { templateKey: "nutricao_30" } },
  { stage: "ganho", delay: 0, action: "task", config: { title: "Iniciar onboarding do novo franqueado" } },
  {
    stage: "perdido",
    delay: 90 * DAY,
    action: "whatsapp",
    config: { text: "Oi, {{nome}}! Faz um tempo que conversamos. Ainda pensa em abrir sua franquia {{empresa}}?" },
  },
  { stage: "perdido", delay: 90 * DAY, action: "ai_on" },
  { stage: "perdido", delay: 90 * DAY, action: "move", config: { toStage: "qualificando" } },
];

/** Creates the default funnel with its stages and automations. Safe to call twice. */
export async function installDefaultPipeline(db: PrismaClient) {
  const existing = await db.pipeline.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  const pipeline = await db.pipeline.create({ data: { name: "Expansão", isDefault: true, position: 0 } });
  const ids = new Map<string, string>();
  for (const [position, s] of DEFAULT_STAGES.entries()) {
    const stage = await db.stage.create({ data: { ...s, kind: s.kind ?? "OPEN", position, pipelineId: pipeline.id } });
    ids.set(s.key, stage.id);
  }
  const perStage = new Map<string, number>();
  for (const r of DEFAULT_RULES) {
    const position = perStage.get(r.stage) ?? 0;
    perStage.set(r.stage, position + 1);
    const { toStage, ...config } = r.config ?? {};
    await db.automationRule.create({
      data: {
        stageId: ids.get(r.stage)!,
        trigger: r.trigger ?? "enter",
        delayMinutes: r.delay,
        action: r.action,
        config: toStage ? { ...config, toStageId: ids.get(toStage)! } : config,
        runAfterLeaving: r.runAfterLeaving ?? false,
        position,
      },
    });
  }
  return pipeline;
}
