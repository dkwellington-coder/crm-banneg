// Tarefas screen (Wellington, 2026-11-26): each task under the right heading, by its due day in Brasília
import { describe, expect, it } from "vitest";
import { taskGroup } from "@/lib/task-groups";

describe("task headings", () => {
  // Thursday 2026-11-26, 17:45 in Brasília
  const now = new Date("2026-11-26T20:45:00Z");
  it("groups by the Brasília day", () => {
    expect(taskGroup(null, now)).toBe("Sem prazo");
    expect(taskGroup(new Date("2026-11-26T12:00:00Z"), now)).toBe("Atrasadas");
    expect(taskGroup(new Date("2026-11-27T02:30:00Z"), now)).toBe("Hoje"); // 23h30 today in Brasília
    expect(taskGroup(new Date("2026-11-27T03:30:00Z"), now)).toBe("Amanhã"); // 00h30 tomorrow
    expect(taskGroup(new Date("2026-12-03T15:00:00Z"), now)).toBe("Próximos dias");
    expect(taskGroup(new Date("2026-12-04T15:00:00Z"), now)).toBe("Mais para frente");
  });
});
