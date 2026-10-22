import { describe, expect, it } from "vitest";
import { actionLabel, delayLabel, fillVariables, splitDelay, templateSlots, triggerLabel } from "@/lib/rules";
import { DEFAULT_SETTINGS, isTestContact, messageVars, whatsappIsReal } from "@/lib/settings";
import { currentPeriod, pace, periodRange, shiftPeriod, todayRange, workingDays } from "@/lib/goals";

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

  it("names the partner store that referred the lead", () => {
    const text = "Oi, {{nome}}! Aqui é a {{sdr}}, do {{empresa}}, somos a corretora oficial da {{parceiro}}.";
    const lead = { name: "Maria Souza", city: null, qualification: { parceiro: "Lotus Veículos" } };
    expect(fillVariables(text, messageVars(DEFAULT_SETTINGS, lead, "Duda"))).toBe(
      "Oi, Maria! Aqui é a Duda, do Banneg, somos a corretora oficial da Lotus Veículos.",
    );
    expect(messageVars(DEFAULT_SETTINGS, { name: "Ana", city: null }).parceiro).toBe("");
  });

  it("counts the slots of a Meta template", () => {
    expect(templateSlots("Oi, {{1}}! Aqui é a {{2}}, da {{3}}. Cotação de {{4}}?")).toBe(4);
    expect(templateSlots("Oi, {{1}}!")).toBe(1);
    expect(templateSlots("Sem variáveis")).toBe(0);
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

  it("projects the month at the current pace, counting only working days", () => {
    // Friday 16 October at noon: 11.5 of October's 22 working days gone, 10 of 30 done
    const mid = new Date(periodRange("2026-10").start.getTime() + 15.5 * 86_400_000);
    expect(workingDays("2026-10")).toBe(22);
    const p = pace(10, 30, "2026-10", mid);
    expect(p.projected).toBe(Math.round(10 / (11.5 / 22)));
    expect(p.onTrack).toBe(false);
    // Today plus the 10 weekdays left
    expect(p.daysLeft).toBe(11);
    expect(p.perDay).toBeCloseTo(20 / 11);
    expect(pace(30, 30, "2026-10", mid)).toMatchObject({ percent: 100, onTrack: true });
  });

  it("spreads a month's goal over its working days", () => {
    expect(pace(0, 44, "2026-10", new Date("2026-10-16T15:00:00Z")).dailyTarget).toBe(2);
    expect(workingDays("2026-11")).toBe(21);
    // Saturday 17 October in São Paulo starts at 03:00 UTC
    expect(todayRange(new Date("2026-10-17T02:59:00Z")).start.toISOString()).toBe("2026-10-16T03:00:00.000Z");
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

  it("recognizes a released number that WhatsApp sends without the 9", () => {
    const s = { testContacts: ["61 98765-4321"] };
    expect(isTestContact(s, "556187654321")).toBe(true);
    expect(isTestContact({ testContacts: ["61 8765-4321"] }, "5561987654321")).toBe(true);
    expect(isTestContact(s, "556193258574")).toBe(false);
  });

  it("in test mode can still answer whoever wrote in the last 24 hours", () => {
    const now = Date.now();
    const wrote = { phone: "5511987650000", lastInboundAt: new Date(now - 60_000) };
    const never = { phone: "5511987650000", lastInboundAt: null };
    const base = { testMode: true, testContacts: [], answerInbound: false };
    expect(whatsappIsReal(base, wrote)).toBe(false);
    expect(whatsappIsReal({ ...base, answerInbound: true }, wrote)).toBe(true);
    expect(whatsappIsReal({ ...base, answerInbound: true }, never)).toBe(false);
    expect(whatsappIsReal({ ...base, answerInbound: true }, { ...wrote, lastInboundAt: new Date(now - 25 * 3_600_000) })).toBe(false);
    expect(whatsappIsReal({ ...base, testMode: false }, never)).toBe(true);
  });
});
