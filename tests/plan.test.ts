import { describe, expect, it } from "vitest";
import { isSubjectHandoffKey, planFromDecision, subjectHandoffStage } from "@/lib/plan";
import type { SdrDecision } from "@/lib/sdr";

const slots = [
  { startsAt: new Date("2026-10-15T13:00:00Z"), endsAt: new Date("2026-10-15T13:30:00Z") },
  { startsAt: new Date("2026-10-15T14:00:00Z"), endsAt: new Date("2026-10-15T14:30:00Z") },
];

function decision(over: Partial<SdrDecision>): SdrDecision {
  return {
    reply: "Ok!",
    extracted: { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null },
    score: 50,
    temperature: "morno",
    decision: "continue",
    slotIndex: null,
    handoffTo: null,
    sendCof: false,
    reason: "faltam dados",
    summary: "",
    ...over,
  };
}

describe("planFromDecision", () => {
  it("keeps qualifying on continue", () => {
    const p = planFromDecision(decision({}), slots);
    expect(p.status).toBe("AI_QUALIFYING");
    expect(p.stopAi).toBe(false);
  });

  it("goes to the meeting when the lead asks to talk, even before the score (the times already went in the reply)", () => {
    expect(planFromDecision(decision({ decision: "offer_meeting", score: 40 }), slots)).toMatchObject({ status: "QUALIFIED", stageKey: "qualificado" });
    // No free time to offer: it keeps talking
    expect(planFromDecision(decision({ decision: "offer_meeting", score: 80 }), []).status).toBe("AI_QUALIFYING");
  });

  it("marks qualified when the score is high enough", () => {
    const p = planFromDecision(decision({ decision: "offer_meeting", score: 80 }), slots);
    expect(p.status).toBe("QUALIFIED");
    expect(p.stageKey).toBe("qualificado");
  });

  it("books the chosen slot and stops the AI", () => {
    const p = planFromDecision(decision({ decision: "book_meeting", score: 85, slotIndex: 1 }), slots);
    expect(p.status).toBe("MEETING_BOOKED");
    expect(p.slot).toEqual(slots[1]);
    expect(p.stopAi).toBe(true);
  });

  it("creates a task instead of booking a slot that does not exist", () => {
    const p = planFromDecision(decision({ decision: "book_meeting", score: 85, slotIndex: 7 }), slots);
    expect(p.status).toBe("QUALIFIED");
    expect(p.slot).toBeNull();
    expect(p.handoffTask).toMatch(/horário/);
  });

  it("hands off to a human with the reason", () => {
    const p = planFromDecision(decision({ decision: "handoff", reason: "quer desconto" }), slots);
    expect(p.status).toBe("HANDED_OFF");
    expect(p.handoffTask).toContain("quer desconto");
    expect(p.stopAi).toBe(true);
  });

  it("starts nurturing and disqualifies", () => {
    expect(planFromDecision(decision({ decision: "nurture" }), slots).startNurture).toBe(true);
    expect(planFromDecision(decision({ decision: "disqualify" }), slots).stageKey).toBe("descartado");
  });

  it("keeps only valid fields and drops an invalid email", () => {
    const p = planFromDecision(
      decision({
        extracted: { name: "Ana Souza", email: "nao tenho", city: "Curitiba", state: "PR", capital: "R$ 300 mil", timeline: null, experience: null, decisionMaker: "ela" },
      }),
      slots,
    );
    expect(p.fields).toEqual({ name: "Ana Souza", city: "Curitiba", state: "PR" });
    expect(p.qualification).toEqual({ capital: "R$ 300 mil", decisionMaker: "ela" });
  });
});

describe("subject handoff stages", () => {
  const stages = [{ name: "Consórcio: com consultor" }, { name: "Telemedicina: conferir pagamento" }];
  it("finds the stage the AI named, ignoring case and accents, only on a handoff", () => {
    expect(subjectHandoffStage(decision({ decision: "handoff", handoffTo: "consorcio: com consultor" }), stages)).toBe(stages[0]);
    expect(subjectHandoffStage(decision({ decision: "handoff", handoffTo: "Seguro viagem" }), stages)).toBeNull();
    expect(subjectHandoffStage(decision({ decision: "handoff", handoffTo: null }), stages)).toBeNull();
    expect(subjectHandoffStage(decision({ decision: "continue", handoffTo: "Consórcio: com consultor" }), stages)).toBeNull();
  });

  it("only com_ stages other than the default one are subject stages", () => {
    expect(["com_consorcio", "com_telemedicina"].every(isSubjectHandoffKey)).toBe(true);
    expect(["com_gerente", "novo", null].some(isSubjectHandoffKey)).toBe(false);
  });
});
