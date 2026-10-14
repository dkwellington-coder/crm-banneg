import { describe, expect, it } from "vitest";
import { actionLabel, delayLabel, fillVariables, splitDelay, triggerLabel } from "@/lib/rules";
import { isTestContact } from "@/lib/settings";
import { currentPeriod, pace, periodRange, shiftPeriod } from "@/lib/goals";

describe("automation rules", () => {
  it("shows delays the way people type them", () => {
    expect(splitDelay(2880)).toEqual({ amount: 2, unit: "d" });
    expect(splitDelay(90)).toEqual({ amount: 90, unit: "min" });
    expect(splitDelay(120)).toEqual({ amount: 2, unit: "h" });
    expect(delayLabel(0)).toBe("na hora");
    expect(delayLabel(1440)).toBe("1 dia");
    expect(triggerLabel("idle", 4320)).toBe("Sem resposta do lead por 3 dias");
    expect(triggerLabel("enter", 0)).toBe("Assim que entrar na etapa");
  });

  it("fills variables and tidies the text when the name is missing", () => {
    expect(fillVariables("Oi, {{nome}}! Tudo bem?", { nome: "Ana" })).toBe("Oi, Ana! Tudo bem?");
    expect(fillVariables("Oi, {{nome}}! Tudo bem?", { nome: "" })).toBe("Oi! Tudo bem?");
    expect(fillVariables("{{nome}}, passando aqui.", { nome: "" })).toBe("Passando aqui.");
    expect(fillVariables("Vou encerrar, {{nome}}. Se quiser", { nome: "" })).toBe("Vou encerrar. Se quiser");
  });

  it("describes actions in plain words", () => {
    expect(actionLabel("move", { toStageId: "s1" }, { stages: { s1: "Nutrição" } })).toBe("Mover para “Nutrição”");
    expect(actionLabel("move", { toStageId: "gone" }, { stages: {} })).toBe("Mover para “etapa removida”");
  });
});

describe("goals", () => {
  it("uses São Paulo month boundaries", () => {
    expect(currentPeriod(new Date("2026-11-01T02:00:00Z"))).toBe("2026-10");
    expect(currentPeriod(new Date("2026-11-01T03:00:00Z"))).toBe("2026-11");
    expect(periodRange("2026-10").start.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
  });

  it("projects the month at the current pace", () => {
    // Half of October gone, 10 of 30 done
    const mid = new Date(periodRange("2026-10").start.getTime() + 15.5 * 86_400_000);
    const p = pace(10, 30, "2026-10", mid);
    expect(p.projected).toBe(20);
    expect(p.onTrack).toBe(false);
    expect(p.daysLeft).toBe(16);
    expect(p.perDay).toBeCloseTo(20 / 16);
    expect(pace(30, 30, "2026-10", mid)).toMatchObject({ percent: 100, onTrack: true });
  });
});

describe("test mode", () => {
  it("matches test contacts in any format", () => {
    const s = { testContacts: ["(41) 99999-0000", "Wellington@Banneg.com.br"] };
    expect(isTestContact(s, "5541999990000")).toBe(true);
    expect(isTestContact(s, "wellington@banneg.com.br")).toBe(true);
    expect(isTestContact(s, "5541999990001")).toBe(false);
    expect(isTestContact({ testContacts: [] }, "5541999990000")).toBe(false);
  });
});
