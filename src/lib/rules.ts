// Pure helpers for automation rules, shared by the server engine and the funnel editor.

export const ACTIONS = {
  whatsapp: { label: "Enviar WhatsApp", icon: "message" },
  email: { label: "Enviar e-mail", icon: "mail" },
  cof: { label: "Enviar a COF por e-mail", icon: "file" },
  task: { label: "Criar tarefa", icon: "check" },
  move: { label: "Mover para etapa", icon: "arrow" },
  ai_on: { label: "Ativar SDR de IA", icon: "bot" },
  ai_off: { label: "Pausar a IA", icon: "pause" },
} as const;

export type ActionKey = keyof typeof ACTIONS;
// daily: the stage is a queue and the rule releases up to perDay leads each business day
// answer: the lead answered with one of config.answers (usually a button it tapped)
export type RuleTrigger = "enter" | "idle" | "daily" | "answer";

export type RuleConfig = {
  text?: string;
  templateKey?: string;
  title?: string;
  toStageId?: string;
  sdrId?: string;
  // WhatsApp: Meta template used when the 24 h window is closed (without one, the message waits for the lead)
  templateName?: string;
  // WhatsApp: the variable that fills each {{1}}, {{2}}... of that template; empty = {{1}} the name and {{2}} the SDR
  templateParams?: string[];
  // WhatsApp: quick reply buttons shown with the text
  buttons?: string[];
  // daily: how many leads leave the queue per business day
  perDay?: number;
  // answer: what the lead answered, usually the title of a button it tapped
  answers?: string[];
  // answer: the AI also answers the message (by default the stage's own messages do)
  aiReplies?: boolean;
  // WhatsApp: what goes instead when a person (an affiliate), not a store, referred the lead and the message speaks of
  // {{parceiro}} ("corretora oficial da {{parceiro}}" would read wrong). Without it such a lead gets nothing
  pessoa?: PersonVersion;
};

export type PersonVersion = { text?: string; templateName?: string; templateParams?: string[] };

const PARTNER_VAR = /\{\{\s*parceiro\s*\}\}/;

/** The message names the referrer: {{parceiro}} in its text or in what fills its Meta template. */
export function speaksOfPartner(config: Pick<RuleConfig, "text" | "templateParams">) {
  return PARTNER_VAR.test(config.text ?? "") || !!config.templateParams?.includes("parceiro");
}

/**
 * The rule as it goes to a lead a person referred: the person version's text, template and variables in place of the
 * store's (never the store's template as a fallback); null when the rule has no person version with a text.
 */
export function forPerson(config: RuleConfig): RuleConfig | null {
  const p = config.pessoa;
  if (!p?.text?.trim()) return null;
  return { ...config, text: p.text, templateName: p.templateName, templateParams: p.templateParams };
}

const normalizeAnswer = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Whether what the lead wrote is one of the rule's answers: the tapped button, or the same words typed. */
export function matchesAnswer(body: string, answers: string[] = []) {
  const said = normalizeAnswer(body);
  return !!said && answers.some((a) => normalizeAnswer(a) === said);
}

export const UNITS = [
  { key: "min", label: "minutos", minutes: 1 },
  { key: "h", label: "horas", minutes: 60 },
  { key: "d", label: "dias", minutes: 1440 },
] as const;

/** 2880 → { amount: 2, unit: "d" } so the editor shows the number the person typed. */
export function splitDelay(minutes: number): { amount: number; unit: (typeof UNITS)[number]["key"] } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "d" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "h" };
  return { amount: minutes, unit: "min" };
}

export function delayLabel(minutes: number) {
  if (minutes === 0) return "na hora";
  const { amount, unit } = splitDelay(minutes);
  const word = unit === "d" ? (amount === 1 ? "dia" : "dias") : unit === "h" ? (amount === 1 ? "hora" : "horas") : "min";
  return `${amount} ${word}`;
}

export function triggerLabel(trigger: string, delayMinutes: number, config: RuleConfig = {}) {
  if (trigger === "daily") return `Fila: ${config.perDay ?? 100} leads por dia útil, das 9h às 18h`;
  if (trigger === "idle") return `Sem resposta do lead por ${delayLabel(delayMinutes)}`;
  if (trigger === "answer") return `Quando o lead responder ${(config.answers ?? []).map((a) => `“${a}”`).join(" ou ")}${config.aiReplies ? " (a IA também responde)" : ""}`;
  return delayMinutes === 0 ? "Assim que entrar na etapa" : `${delayLabel(delayMinutes)} depois de entrar`;
}

export function actionLabel(action: string, config: RuleConfig, names: { stages?: Record<string, string>; emails?: Record<string, string> } = {}) {
  switch (action) {
    case "whatsapp":
      return `Enviar WhatsApp: “${config.text ?? ""}”${config.buttons?.length ? ` [${config.buttons.join(" · ")}]` : ""}${config.templateName ? ` (fora das 24 h: modelo ${config.templateName})` : ""}${config.pessoa?.text?.trim() ? " · com versão para indicação de pessoa" : ""}`;
    case "email":
      return `Enviar e-mail “${names.emails?.[config.templateKey ?? ""] ?? config.templateKey}”`;
    case "cof":
      return "Enviar por e-mail a COF, os balanços e o contrato (com cópia guardada e confirmação de recebimento)";
    case "task":
      return `Criar tarefa “${config.title ?? ""}”`;
    case "move":
      return `Mover para “${names.stages?.[config.toStageId ?? ""] ?? "etapa removida"}”`;
    case "ai_on":
      return "Ativar a SDR de IA (ela inicia a conversa se ainda não houve contato)";
    case "ai_off":
      return "Pausar a IA neste lead";
    default:
      return action;
  }
}

/** Replaces {{nome}}, {{empresa}}... in a WhatsApp text. Unknown variables become empty. */
export function fillVariables(text: string, vars: Record<string, string>) {
  return text
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,([.!?])/g, "$1")
    .replace(/^[,\s]+/, "")
    .trim()
    // A text that opens with a material link keeps it as is, so it still goes as the video
    .replace(/^(?!https?:\/\/)\p{Ll}/u, (c) => c.toUpperCase());
}

// Brazil has had no daylight saving time since 2019, so São Paulo is a fixed UTC-3.
const SP_OFFSET = -3 * 3600_000;
export const QUIET_HOURS = { from: 21, until: 8 };

/** A time that falls at night in Brasília (21h to 8h) moves to the next 8h. */
export function awakeTime(d: Date) {
  const local = new Date(d.getTime() + SP_OFFSET);
  const hour = local.getUTCHours();
  if (hour >= QUIET_HOURS.until && hour < QUIET_HOURS.from) return d;
  if (hour >= QUIET_HOURS.from) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(QUIET_HOURS.until, 0, 0, 0);
  return new Date(local.getTime() - SP_OFFSET);
}

/**
 * Same-delay rules run in the order shown on screen. A follow-up (`awake`) never lands at night:
 * it waits for the morning.
 */
export function ruleRunAt(base: Date, delayMinutes: number, position: number, awake = false) {
  const at = new Date(base.getTime() + delayMinutes * 60_000);
  return new Date((awake ? awakeTime(at) : at).getTime() + position * 1000);
}

/** WhatsApp follow-ups an hour or more later wait for the morning; a reply right away, a first contact or an e-mail go at once. */
export const isNudge = (rule: { action: string; delayMinutes: number }) => rule.action === "whatsapp" && rule.delayMinutes >= 60;

/** How many {{1}}, {{2}}... a Meta template asks for. */
export function templateSlots(body: string) {
  return Math.max(0, ...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
}
