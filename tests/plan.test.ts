import { describe, expect, it } from "vitest";
import { planFromDecision } from "@/lib/plan";
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
    sendCof: false,
    reason: "faltam dados",
    summary: "",
    ...over,
  };
}

describe("planFromDecision", () => {
  it("keeps qualifying on continue", () => {
    const p = planFromDecision(decision({}), slots, 60);
    expect(p.status).toBe("AI_QUALIFYING");
    expect(p.stopAi).toBe(false);
  });

  it("does not offer a meeting below the minimum score", () => {
    const p = planFromDecision(decision({ decision: "offer_meeting", score: 40 }), slots, 60);
    expect(p.status).toBe("AI_QUALIFYING");
  });

  it("marks qualified when the score is high enough", () => {
    const p = planFromDecision(decision({ decision: "offer_meeting", score: 80 }), slots, 60);
    expect(p.status).toBe("QUALIFIED");
    expect(p.stageKey).toBe("qualificado");
  });

  it("books the chosen slot and stops the AI", () => {
    const p = planFromDecision(decision({ decision: "book_meeting", score: 85, slotIndex: 1 }), slots, 60);
    expect(p.status).toBe("MEETING_BOOKED");
    expect(p.slot).toEqual(slots[1]);
    expect(p.stopAi).toBe(true);
  });

  it("creates a task instead of booking a slot that does not exist", () => {
    const p = planFromDecision(decision({ decision: "book_meeting", score: 85, slotIndex: 7 }), slots, 60);
    expect(p.status).toBe("QUALIFIED");
    expect(p.slot).toBeNull();
    expect(p.handoffTask).toMatch(/horário/);
  });

  it("hands off to a human with the reason", () => {
    const p = planFromDecision(decision({ decision: "handoff", reason: "quer desconto" }), slots, 60);
    expect(p.status).toBe("HANDED_OFF");
    expect(p.handoffTask).toContain("quer desconto");
    expect(p.stopAi).toBe(true);
  });

  it("starts nurturing and disqualifies", () => {
    expect(planFromDecision(decision({ decision: "nurture" }), slots, 60).startNurture).toBe(true);
    expect(planFromDecision(decision({ decision: "disqualify" }), slots, 60).stageKey).toBe("descartado");
  });

  it("keeps only valid fields and drops an invalid email", () => {
    const p = planFromDecision(
      decision({
        extracted: { name: "Ana Souza", email: "nao tenho", city: "Curitiba", state: "PR", capital: "R$ 300 mil", timeline: null, experience: null, decisionMaker: "ela" },
      }),
      slots,
      60,
    );
    expect(p.fields).toEqual({ name: "Ana Souza", city: "Curitiba", state: "PR" });
    expect(p.qualification).toEqual({ capital: "R$ 300 mil", decisionMaker: "ela" });
  });
});
