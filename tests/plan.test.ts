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

  it("books the chosen slot and keeps the AI following the lead", () => {
    const p = planFromDecision(decision({ decision: "book_meeting", score: 85, slotIndex: 1 }), slots);
    expect(p.status).toBe("MEETING_BOOKED");
    expect(p.slot).toEqual(slots[1]);
    expect(p.stopAi).toBe(false);
    expect(p.cancelMeeting).toBe(false);
  });

  describe("with a meeting already booked", () => {
    const booked = { hasMeeting: true };

    it("keeps the lead in Reunião marcada while it talks or asks for other times", () => {
      expect(planFromDecision(decision({}), slots, booked)).toMatchObject({ status: "MEETING_BOOKED", stageKey: "reuniao", stopAi: false, cancelMeeting: false });
      expect(planFromDecision(decision({ decision: "offer_meeting" }), slots, booked)).toMatchObject({ stageKey: "reuniao", cancelMeeting: false });
    });

    it("reschedules: books the new time and cancels the old meeting", () => {
      const p = planFromDecision(decision({ decision: "book_meeting", slotIndex: 0 }), slots, booked);
      expect(p).toMatchObject({ status: "MEETING_BOOKED", stageKey: "reuniao", slot: slots[0], cancelMeeting: true, stopAi: false });
    });

    it("keeps the meeting when the new time is no longer free", () => {
      const p = planFromDecision(decision({ decision: "book_meeting", slotIndex: 9 }), slots, booked);
      expect(p).toMatchObject({ stageKey: "reuniao", slot: null, cancelMeeting: false });
      expect(p.handoffTask).toMatch(/remarcar/);
    });

    it("cancels: the meeting leaves the agenda and the lead goes back to Qualificado", () => {
      const p = planFromDecision(decision({ decision: "cancel_meeting" }), slots, booked);
      expect(p).toMatchObject({ status: "QUALIFIED", stageKey: "qualificado", cancelMeeting: true, stopAi: false });
    });

    it("still stops on a handoff to the gerente", () => {
      expect(planFromDecision(decision({ decision: "handoff", reason: "quer falar com alguém" }), slots, booked)).toMatchObject({ stageKey: "com_gerente", stopAi: true });
    });
  });

  it("ignores a cancel when there is no meeting", () => {
    expect(planFromDecision(decision({ decision: "cancel_meeting" }), slots)).toMatchObject({ stageKey: "qualificando", cancelMeeting: false });
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
