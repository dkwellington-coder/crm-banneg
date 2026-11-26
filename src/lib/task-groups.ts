import { brClock } from "./secretary";

// The headings of the Tarefas screen, in order (Wellington, 2026-11-26)
export const TASK_GROUPS = ["Atrasadas", "Hoje", "Amanhã", "Próximos dias", "Mais para frente", "Sem prazo"] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number];

const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Which heading a task goes under, by its due day in Brasília. */
export function taskGroup(dueAt: Date | null, now: Date): TaskGroup {
  if (!dueAt) return "Sem prazo";
  if (dueAt < now) return "Atrasadas";
  const today = brClock(now).day;
  const day = brClock(dueAt).day;
  if (day === today) return "Hoje";
  if (day === plusDays(today, 1)) return "Amanhã";
  if (day <= plusDays(today, 7)) return "Próximos dias";
  return "Mais para frente";
}
