import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserTurn } from "@/lib/sdr";
import { DEFAULT_SETTINGS } from "@/lib/settings";

describe("SDR prompt", () => {
  const base = { agentName: "Duda", persona: "Simpática e objetiva.", settings: DEFAULT_SETTINGS, knowledge: [{ title: "Investimento", content: "A partir de R$ 150 mil." }] };

  it("puts the knowledge base and qualification questions in the cached system prompt", () => {
    const s = buildSystemPrompt(base);
    expect(s).toContain("Duda");
    expect(s).toContain("A partir de R$ 150 mil.");
    expect(s).toContain("Capital disponível");
  });

  it("lists the free slots by day, numbered, and wraps the conversation as data", () => {
    const u = buildUserTurn({
      ...base,
      lead: { name: "Ana", phone: "5511", email: null, city: null, state: null, source: "site", qualification: {}, summary: null },
      transcript: [{ direction: "IN", author: "Ana", body: "Oi, quero saber da franquia", at: new Date("2026-10-14T15:00:00Z") }],
      slots: [
        { startsAt: new Date("2026-10-15T13:00:00Z"), endsAt: new Date("2026-10-15T13:30:00Z") },
        { startsAt: new Date("2026-10-15T18:00:00Z"), endsAt: new Date("2026-10-15T18:30:00Z") },
        { startsAt: new Date("2026-10-16T12:00:00Z"), endsAt: new Date("2026-10-16T12:30:00Z") },
      ],
      now: new Date("2026-10-14T15:01:00Z"),
    });
    expect(u).toContain("quinta-feira, 15/10: 0) 10:00 · 1) 15:00");
    expect(u).toContain("sexta-feira, 16/10: 2) 09:00");
    expect(u).toContain("<conversa>");
    expect(u).toContain("LEAD: Oi, quero saber da franquia");
    expect(u).not.toContain("5511");
  });
});
