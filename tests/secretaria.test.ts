// Secretária (Wellington, 2026-11-26): the AI secretary on her own WhatsApp chip, in a group with him and the team.
// Pure parts: Brasília dates, when she chases a task, who is who, @mentions, what the server posts, the morning list,
// and that someone from outside the team cannot make her book or send anything.
import { describe, expect, it, vi } from "vitest";

process.env.CRON_SECRET ||= "segredo-de-teste";
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

import {
  DEFAULT_SECRETARY,
  callsHer,
  firstNudge,
  memberByName,
  memberByPhone,
  morningText,
  nextBusinessMorning,
  parseBr,
  parseSecretary,
  withMentions,
} from "@/lib/secretary";
import { SILENT, buildSystemPrompt, buildUserTurn, levelOf, runTool, trusted, type TurnContext } from "@/lib/secretary-ai";

const br = (s: string) => new Date(`${s}-03:00`);
const members = [
  { name: "Wellington", phone: "17981600088", email: "wellington@banneg.com.br", role: "socio" as const },
  { name: "Odair Bellentani", phone: "5517991112222", email: "odair.bellentani@banneg.com.br" },
];

describe("Brasília dates", () => {
  it("reads a time and a date alone (9h)", () => {
    expect(parseBr("2026-11-27T10:00")?.toISOString()).toBe("2026-11-27T13:00:00.000Z");
    expect(parseBr("2026-11-27")?.toISOString()).toBe("2026-11-27T12:00:00.000Z");
    expect(parseBr("amanhã")).toBeNull();
    expect(parseBr("")).toBeNull();
  });

  it("chases at the due time, or the next business morning when it falls at night or on a weekend", () => {
    expect(firstNudge({ kind: "tarefa", dueAt: br("2026-11-27T15:00") })?.toISOString()).toBe(br("2026-11-27T15:00").toISOString());
    // Friday 22h -> Monday 9h
    expect(firstNudge({ kind: "retorno", dueAt: br("2026-11-27T22:00") })?.toISOString()).toBe(br("2026-11-30T09:00").toISOString());
    // Saturday -> Monday
    expect(firstNudge({ kind: "tarefa", dueAt: br("2026-11-28T10:00") })?.toISOString()).toBe(br("2026-11-30T09:00").toISOString());
    // Early morning (6h) -> same day 9h
    expect(firstNudge({ kind: "tarefa", dueAt: br("2026-11-26T06:00") })?.toISOString()).toBe(br("2026-11-26T09:00").toISOString());
    expect(firstNudge({ kind: "lembrete", dueAt: br("2026-11-27T15:00") })).toBeNull();
    expect(firstNudge({ kind: "tarefa", dueAt: null })).toBeNull();
    expect(nextBusinessMorning(br("2026-11-27T10:00")).toISOString()).toBe(br("2026-11-30T09:00").toISOString());
  });
});

describe("who is who", () => {
  it("finds a member by phone in any format and by name", () => {
    expect(memberByPhone(members, "5517981600088")?.name).toBe("Wellington");
    expect(memberByPhone(members, "551781600088")?.name).toBe("Wellington");
    expect(memberByPhone(members, "17991112222")?.name).toBe("Odair Bellentani");
    expect(memberByPhone(members, "5511999999999")).toBeNull();
    expect(memberByName(members, "@odair")?.name).toBe("Odair Bellentani");
    expect(memberByName(members, "Odair Bellentani")?.email).toBe("odair.bellentani@banneg.com.br");
    expect(memberByName(members, "Maria")).toBeNull();
  });

  it("turns @Name into a WhatsApp mention", () => {
    const out = withMentions("@Odair, consegue mandar o contrato? @Wellington fica sabendo. @Maria não é do grupo.", members);
    expect(out.text).toBe("@5517991112222, consegue mandar o contrato? @5517981600088 fica sabendo. @Maria não é do grupo.");
    expect(out.mentions).toEqual(["5517991112222", "5517981600088"]);
    expect(withMentions("sem ninguém", members).mentions).toEqual([]);
  });
});

describe("what the WhatsApp server posts", () => {
  it("a group message with who wrote and what it answers", () => {
    const e = parseSecretary({
      EventType: "messages",
      message: {
        chatid: "120363000@g.us",
        messageid: "G1",
        isGroup: true,
        messageTimestamp: 1764150000000,
        text: "marca reunião amanhã 10h",
        senderName: "Wellington",
        sender_pn: "5517981600088@s.whatsapp.net",
        quoted: { text: "Qual horário?" },
      },
    });
    expect(e).toMatchObject({ kind: "message", isGroup: true, chatId: "120363000@g.us", phone: "5517981600088", name: "Wellington", body: "marca reunião amanhã 10h", quoted: "Qual horário?", audio: false });
  });

  it("an audio waits for its transcription; reactions and empty ones are left out", () => {
    const audio = parseSecretary({ EventType: "messages", message: { chatid: "120363000@g.us", messageid: "A1", mediaType: "ptt", type: "media" } });
    expect(audio).toMatchObject({ kind: "message", audio: true });
    expect(parseSecretary({ EventType: "messages", message: { chatid: "x@g.us", type: "reaction", messageid: "R" } }).kind).toBe("ignore");
    expect(parseSecretary({ EventType: "messages", message: { chatid: "x@g.us", messageid: "E", text: "  " } }).kind).toBe("ignore");
    expect(parseSecretary({ EventType: "media", message: { chatid: "x@g.us", messageid: "A1" }, media: { saved: true } })).toEqual({ kind: "media", chatId: "x@g.us", externalId: "A1", saved: true });
  });
});

describe("the morning list", () => {
  const now = br("2026-11-30T08:00");
  const tasks = [
    { title: "Mandar contrato", assignee: "Odair Bellentani", dueAt: br("2026-11-30T17:00"), kind: "tarefa" },
    { title: "Retorno da seguradora", assignee: "Wellington", dueAt: br("2026-12-02T09:00"), kind: "retorno" },
    { title: "Atrasada", assignee: "Odair Bellentani", dueAt: br("2026-11-27T09:00"), kind: "tarefa" },
  ];
  const meetings = [{ startsAt: br("2026-11-30T10:00"), title: "Reunião Banneg · João", meet: "https://meet.google.com/abc" }];

  it("Monday: everything by person, with the week's meetings", () => {
    const text = morningText({ weekly: true, today: "2026-11-30", tasks, meetings, now })!;
    expect(text).toContain("Tarefas da semana");
    expect(text).toContain("*Odair Bellentani:*");
    expect(text).toContain("Retorno da seguradora");
    expect(text).toContain("*atrasada*");
    expect(text).toContain("https://meet.google.com/abc");
  });

  it("other days: only what is due today or late, nothing when there is nothing", () => {
    const text = morningText({ weekly: false, today: "2026-11-30", tasks, meetings: [], now })!;
    expect(text).toContain("Mandar contrato");
    expect(text).toContain("Atrasada");
    expect(text).not.toContain("Retorno da seguradora");
    expect(text).toContain("Mais 1 tarefa em aberto");
    expect(morningText({ weekly: false, today: "2026-11-30", tasks: [], meetings: [], now })).toBeNull();
  });
});

describe("her prompt and her limits", () => {
  const s = { ...DEFAULT_SECRETARY, name: "Clara", members, checklist: "• RG e CPF", group: { id: "120363000@g.us", name: "Secretária" } };
  const ctx = (over: Partial<TurnContext> = {}): TurnContext => ({ s, chatId: "5511999999999@s.whatsapp.net", isGroup: false, member: null, contact: { phone: "5511999999999", name: "Carlos" }, actor: "Carlos", now: br("2026-11-26T10:00"), ...over });

  it("knows the team, the checklist, the brand rule and how to stay silent", () => {
    const p = buildSystemPrompt(s);
    expect(p).toContain("Clara");
    expect(p).toContain("Odair Bellentani");
    expect(p).toContain("• RG e CPF");
    expect(p).toContain('"o Banneg"');
    expect(p).toContain(SILENT);
    expect(p).toContain("Só envie (enviar_email) depois");
  });

  it("the turn says where she is, today's date and what is new", () => {
    const turn = buildUserTurn({ ctx: ctx(), history: [], fresh: [{ at: br("2026-11-26T09:59"), senderName: "Carlos", senderPhone: "5511999999999", fromMe: false, body: "Oi, quero falar com o Wellington", quotedText: null } as never], tasks: [], drafts: [] });
    expect(turn).toContain("quinta, 26/11/2026 10:00");
    expect(turn).toContain("alguém de fora da equipe: Carlos");
    expect(turn).toContain("Oi, quero falar com o Wellington");
  });

  it("someone from outside the team, in private, cannot book, e-mail or message others", async () => {
    expect(trusted(ctx())).toBe(false);
    expect(trusted(ctx({ isGroup: true }))).toBe(true);
    expect(trusted(ctx({ member: members[1] }))).toBe(true);
    expect(levelOf(ctx({ member: members[0] }))).toBe("socio");
    expect(levelOf(ctx({ member: members[1] }))).toBe("colaborador");
    await expect(runTool("marcar_reuniao", { titulo: "x", inicio: "2026-11-27T10:00" }, ctx())).rejects.toThrow("Só a equipe");
    await expect(runTool("rascunhar_email", { para: ["a@b.com"], assunto: "x", corpo: "y" }, ctx())).rejects.toThrow("Só a equipe");
    await expect(runTool("mandar_mensagem", { para: "5511988887777", texto: "oi" }, ctx())).rejects.toThrow("só dá para mandar recado no grupo");
  });

  it("a collaborator works on their own things and asks the partners in the group for a meeting with a lead", async () => {
    const odair = ctx({ member: members[1], actor: "Odair Bellentani" });
    await expect(runTool("marcar_reuniao", { titulo: "x", inicio: "2026-11-27T10:00", lead_id: "l1" }, odair)).rejects.toThrow("peça o ok no grupo");
    await expect(runTool("ajustar_grupo", { foto_logo: true }, odair)).rejects.toThrow("peça a um sócio no grupo");
    await expect(runTool("criar_tarefa", { titulo: "Ligar para a seguradora", tipo: "tarefa", responsavel: "Wellington" }, odair)).rejects.toThrow("só anota tarefa ou lembrete para si mesmo");
    await expect(runTool("mandar_mensagem", { para: "Wellington", texto: "oi" }, odair)).rejects.toThrow("recado no grupo");
  });

  it("the prompt splits partners (group) and collaborators (private)", () => {
    const p = buildSystemPrompt(s);
    expect(p).toMatch(/Sócios \(estão no grupo\):\n- Wellington/);
    expect(p).toMatch(/Colaboradores \(falam com você no privado\):\n- Odair Bellentani/);
  });

  it("in the team group a partner asks everything and the rest of the team works as collaborators", () => {
    expect(levelOf(ctx({ isGroup: true, team: true, member: members[0] }))).toBe("socio");
    expect(levelOf(ctx({ isGroup: true, team: true, member: { name: "Ana", phone: "17991234567", email: "" } }))).toBe("colaborador");
  });
});

describe("the team group", () => {
  const her = { name: "Jessica Montenegro", phone: "5517976027768" };
  it("she acts only when called by name, @mentioned or answered", () => {
    expect(callsHer(her, { body: "Jéssica, anota pra Ana o relatório até sexta" })).toBe(true);
    expect(callsHer(her, { body: "bom dia jessica!" })).toBe(true);
    expect(callsHer(her, { body: "bom dia, pessoal" })).toBe(false);
    expect(callsHer(her, { body: "Jessicaaa" })).toBe(false);
    expect(callsHer(her, { body: "@5517976027768 pode ver?", mentioned: ["5517976027768"] })).toBe(true);
    expect(callsHer(her, { body: "feito", quotedSender: "5517976027768" })).toBe(true);
  });
});

