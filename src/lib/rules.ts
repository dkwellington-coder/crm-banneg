// Pure helpers for automation rules, shared by the server engine and the funnel editor.

export const ACTIONS = {
  whatsapp: { label: "Enviar WhatsApp", icon: "message" },
  email: { label: "Enviar e-mail", icon: "mail" },
  task: { label: "Criar tarefa", icon: "check" },
  move: { label: "Mover para etapa", icon: "arrow" },
  ai_on: { label: "Ativar SDR de IA", icon: "bot" },
  ai_off: { label: "Pausar a IA", icon: "pause" },
} as const;

export type ActionKey = keyof typeof ACTIONS;
export type RuleTrigger = "enter" | "idle";

export type RuleConfig = { text?: string; templateKey?: string; title?: string; toStageId?: string; sdrId?: string };

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

export function triggerLabel(trigger: string, delayMinutes: number) {
  if (trigger === "idle") return `Sem resposta do lead por ${delayLabel(delayMinutes)}`;
  return delayMinutes === 0 ? "Assim que entrar na etapa" : `${delayLabel(delayMinutes)} depois de entrar`;
}

export function actionLabel(action: string, config: RuleConfig, names: { stages?: Record<string, string>; emails?: Record<string, string> } = {}) {
  switch (action) {
    case "whatsapp":
      return `Enviar WhatsApp: “${config.text ?? ""}”`;
    case "email":
      return `Enviar e-mail “${names.emails?.[config.templateKey ?? ""] ?? config.templateKey}”`;
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
    .replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/** Same-delay rules run in the order shown on screen. */
export function ruleRunAt(base: Date, delayMinutes: number, position: number) {
  return new Date(base.getTime() + delayMinutes * 60_000 + position * 1000);
}
