// Wellington's own WhatsApp on "Proposta enviada" (2026-11-19): messages through Uazapi, the follow-ups only while the
// lead has not answered. Pure parts only; Uazapi's answers are read defensively.
import { describe, expect, it } from "vitest";
import { answeredSince, chatOf, personalFirstName } from "@/lib/personal-whatsapp";
import { actionLabel, fillVariables, isNudge, ruleRunAt } from "@/lib/rules";

const SENT = new Date("2026-11-20T15:00:00Z");

describe("the lead's answer on the personal WhatsApp", () => {
  it("a message from the lead after ours counts, in seconds or milliseconds", () => {
    const ours = { fromMe: true, messageTimestamp: SENT.getTime() };
    expect(answeredSince({ messages: [ours, { fromMe: false, messageTimestamp: SENT.getTime() + 60_000 }] }, SENT)).toBe(true);
    expect(answeredSince([ours, { fromMe: false, messageTimestamp: SENT.getTime() / 1000 + 60 }], SENT)).toBe(true);
  });

  it("what the lead wrote before, or only our own messages, is no answer", () => {
    expect(answeredSince({ messages: [{ fromMe: false, messageTimestamp: SENT.getTime() - 1 }, { fromMe: true, messageTimestamp: SENT.getTime() }] }, SENT)).toBe(false);
  });

  it("a history it can't read is unknown, so nothing goes", () => {
    expect(answeredSince({}, SENT)).toBeNull();
    expect(answeredSince({ messages: [] }, SENT)).toBeNull();
    expect(answeredSince({ messages: [{ text: "oi" }] }, SENT)).toBeNull();
    expect(answeredSince(null, SENT)).toBeNull();
  });

  it("the chat comes from Uazapi's answer, else from the number", () => {
    expect(chatOf({ chatid: "551799999999@s.whatsapp.net" }, "5517999999999")).toBe("551799999999@s.whatsapp.net");
    expect(chatOf({ messageid: "x" }, "5517999999999")).toBe("5517999999999@s.whatsapp.net");
  });
});

describe("the personal message", () => {
  it("names the lead by the first name, written as a person writes it", () => {
    expect(personalFirstName("joão pedro silva")).toBe("João");
    expect(personalFirstName("MARIA SOUZA")).toBe("Maria");
    expect(personalFirstName("McDonald Silva")).toBe("McDonald");
    expect(personalFirstName("5517999990000")).toBe("");
    expect(personalFirstName(null)).toBe("");
  });

  it("reads well with and without the name", () => {
    const text = "{{nome}}, estou aqui novamente pra saber sobre o Banneg, o que achou?";
    expect(fillVariables(text, { nome: "Ana" })).toBe("Ana, estou aqui novamente pra saber sobre o Banneg, o que achou?");
    expect(fillVariables(text, { nome: "" })).toBe("Estou aqui novamente pra saber sobre o Banneg, o que achou?");
    expect(fillVariables("Olá, {{nome}}! Sou Wellington", { nome: "" })).toBe("Olá! Sou Wellington");
  });

  it("days later it never goes at night, and the funnel shows what it does", () => {
    const rule = { action: "whatsapp_pessoal", delayMinutes: 1440 };
    expect(isNudge(rule)).toBe(true);
    // Entered at 22h Brasília: a day later is 22h again, so it waits for 8h
    expect(ruleRunAt(new Date("2026-11-20T01:00:00Z"), 1440, 0, true).toISOString()).toBe("2026-11-21T11:00:00.000Z");
    expect(actionLabel("whatsapp_pessoal", { text: "Oi", ifNoReply: true })).toBe("Enviar do WhatsApp pessoal (Uazapi), se o lead não respondeu à anterior: “Oi”");
  });
});
