// Secretária, end to end (Wellington, 2026-11-26): her number connected on Banneg's own WhatsApp server posts the partners'
// group to the CRM; she reads a burst of messages, anota a tarefa, answers in the group, and chases the collaborator in private
// at the due time. The WhatsApp server and Google (fetch) and the AI are stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.CRON_SECRET = "segredo-de-teste";
process.env.SUPPORT_WA_URL = "https://wa.banneg.app/";
process.env.SUPPORT_WA_ADMIN_TOKEN = "admin";

vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendEmail: vi.fn(async () => "id1") }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {}, after() {} }));

// The AI's answers, in order: each turn of the loop takes the next one
const script: unknown[] = [];
const seen: { system: string; user: unknown }[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = {
      messages: {
        create: async (req: { system: { text: string }[]; messages: { content: unknown }[] }) => {
          seen.push({ system: req.system[0].text, user: req.messages[0].content });
          const next = script.shift();
          if (!next) throw new Error("sem resposta roteirizada");
          return next;
        },
      },
    };
  },
}));

const GROUP = { id: "120363009999@g.us", name: "Sócios Banneg" };
const msg = (id: string, text: string, from = "5517981600088", name = "Wellington") => ({
  EventType: "messages",
  message: { chatid: GROUP.id, messageid: id, isGroup: true, fromMe: false, messageTimestamp: Date.now(), text, senderName: name, sender_pn: `${from}@s.whatsapp.net` },
});

describe.skipIf(!dbUrl)("the secretary in the partners' group", () => {
  let db: typeof import("@/lib/db").db;
  let sec: typeof import("@/lib/secretary");
  let ai: typeof import("@/lib/secretary-ai");
  const sent: { number: string; text: string; mentions?: string[] }[] = [];

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    sec = await import("@/lib/secretary");
    ai = await import("@/lib/secretary-ai");
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: string }) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === "/send/text") {
        sent.push(body);
        return Response.json({ messageid: `OUT${sent.length}` });
      }
      if (path === "/instance/status") return Response.json({ instance: { status: "connected", owner: "5517900001111" }, status: { connected: true } });
      return Response.json({ ok: true });
    });
  });

  beforeEach(async () => {
    sent.length = 0;
    script.length = 0;
    seen.length = 0;
    await db.$executeRawUnsafe('TRUNCATE "User","Setting","Job","SecretaryMessage","SecretaryTask","SecretaryEmail" CASCADE');
    await db.user.create({ data: { name: "Wellington", email: "wellington@banneg.com.br", role: "OWNER", passwordHash: "x" } });
    const { sealToken } = await import("@/lib/support");
    await sec.saveSecretary({
      token: sealToken("tok-sec"),
      webhookKey: "chave",
      group: GROUP,
      name: "Clara",
      members: [
        { name: "Wellington", phone: "17981600088", email: "wellington@banneg.com.br", role: "socio" },
        { name: "Ana Souza", phone: "17991234567", email: "ana@banneg.com.br", role: "colaborador" },
      ],
    });
  });

  it("refuses a post with the wrong key or token, and other groups", async () => {
    expect((await sec.receiveSecretary("outra", msg("X1", "oi"))).ok).toBe(false);
    expect((await sec.receiveSecretary("chave", { ...msg("X2", "oi"), token: "outro" })).ok).toBe(false);
    const other = await sec.receiveSecretary("chave", { ...msg("X3", "oi"), message: { ...msg("X3", "oi").message, chatid: "999@g.us" } });
    expect(other).toMatchObject({ ok: true, ignored: "outro grupo" });
    expect(await db.secretaryMessage.count()).toBe(0);
  });

  it("reads the burst once, anota a tarefa da colaboradora, answers in the group and chases her in private", async () => {
    await sec.receiveSecretary("chave", msg("M1", "Clara, a Ana precisa me mandar o contrato do franqueado"));
    await sec.receiveSecretary("chave", msg("M2", "até sexta às 15h"));
    // Same message twice (the server tries again): kept once
    await sec.receiveSecretary("chave", msg("M2", "até sexta às 15h"));
    expect(await db.secretaryMessage.count()).toBe(2);
    const job = await db.job.findFirstOrThrow({ where: { type: "secretaria.turn", status: "PENDING" } });
    expect(job.payload).toEqual({ chatId: GROUP.id });

    script.push(
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "criar_tarefa", input: { titulo: "Mandar o contrato do franqueado", tipo: "tarefa", responsavel: "Ana", prazo: "2026-11-27T15:00" } }],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Anotado! @Ana manda o contrato até sexta às 15h. Eu cobro." }] },
    );
    const result = await ai.runSecretaryTurn(GROUP.id, new Date("2026-11-26T12:00:00Z"));
    expect(result).toContain("Respondeu");
    // Both messages in one turn, as new; the team and the checklist in her prompt
    expect(String(seen[0].user)).toContain("a Ana precisa me mandar o contrato");
    expect(String(seen[0].user)).toContain("até sexta às 15h");
    expect(seen[0].system).toContain("Ana Souza");

    const task = await db.secretaryTask.findFirstOrThrow();
    expect(task).toMatchObject({ assignee: "Ana Souza", assigneePhone: "17991234567", createdBy: "Wellington", kind: "tarefa" });
    expect(task.nextNudgeAt?.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    // Her answer in the group, with Ana mentioned by her number
    expect(sent[0]).toEqual({ number: GROUP.id, text: "Anotado! @5517991234567 manda o contrato até sexta às 15h. Eu cobro.", mentions: ["5517991234567"] });
    expect(await db.secretaryMessage.count({ where: { handledAt: null } })).toBe(0);
    expect(await db.secretaryMessage.count({ where: { fromMe: true } })).toBe(1);

    // Nothing new: no second answer
    expect(await ai.runSecretaryTurn(GROUP.id)).toBe("Nada novo.");

    // Friday 15h: Ana is chased in private (she is not in the group); next time is Monday 9h
    sent.length = 0;
    await sec.runSecretaryCron(new Date("2026-11-27T18:01:00Z"));
    expect(sent).toHaveLength(1);
    expect(sent[0].number).toBe("5517991234567@s.whatsapp.net");
    expect(sent[0].text).toContain("Cobrando");
    expect(sent[0].text).toContain("Mandar o contrato do franqueado");
    const after = await db.secretaryTask.findFirstOrThrow();
    expect(after.nudges).toBe(1);
    expect(after.nextNudgeAt?.toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("stays silent when the partners talk among themselves, and keeps the messages read", async () => {
    await sec.receiveSecretary("chave", msg("S1", "bom dia, sócio!"));
    script.push({ stop_reason: "end_turn", content: [{ type: "text", text: ai.SILENT }] });
    expect(await ai.runSecretaryTurn(GROUP.id)).toBe("Ficou em silêncio.");
    expect(sent).toHaveLength(0);
    expect(await db.secretaryMessage.count({ where: { handledAt: null } })).toBe(0);
  });

  it("when the AI fails, the messages stay unread for the next try", async () => {
    await sec.receiveSecretary("chave", msg("F1", "marca reunião amanhã"));
    await expect(ai.runSecretaryTurn(GROUP.id)).rejects.toThrow("sem resposta roteirizada");
    expect(await db.secretaryMessage.count({ where: { handledAt: null } })).toBe(1);
  });

  it("an audio waits for the server's file before she answers", async () => {
    await sec.receiveSecretary("chave", { ...msg("A1", ""), message: { ...msg("A1", "").message, mediaType: "ptt", type: "media" } });
    const m = await db.secretaryMessage.findFirstOrThrow();
    expect(m).toMatchObject({ kind: "audio", mediaStatus: "aguardando" });
    expect(await ai.runSecretaryTurn(GROUP.id)).toBe("Esperando o áudio terminar de baixar.");
  });

  it("the Monday list goes once, with the open tasks by person", async () => {
    await db.secretaryTask.create({ data: { title: "Enviar proposta", assignee: "Wellington", dueAt: new Date("2026-12-01T13:00:00Z") } });
    const monday = new Date("2026-11-30T11:05:00Z");
    await sec.runSecretaryCron(monday);
    await sec.runSecretaryCron(new Date(monday.getTime() + 60_000));
    const lists = sent.filter((x) => x.text.includes("Tarefas da semana"));
    expect(lists).toHaveLength(1);
    expect(lists[0].number).toBe(GROUP.id);
    expect(lists[0].text).toContain("Enviar proposta");
  });

  it("the team group: keeps the chatter quiet, learns who is who, answers when called and chases there", async () => {
    const TEAM = { id: "120363008888@g.us", name: "Equipe Banneg" };
    await sec.saveSecretary({ teamGroup: TEAM, phone: "5517976027768" });
    const tmsg = (id: string, text: string, from: string, name: string) => ({ ...msg(id, text, from, name), message: { ...msg(id, text, from, name).message, chatid: TEAM.id } });
    await sec.receiveSecretary("chave", tmsg("T1", "pessoal, evento de franqueados dia 5", "5517992223333", "Carla Lima"));
    expect(await db.job.count({ where: { type: "secretaria.turn" } })).toBe(0);
    expect(await db.secretaryMessage.count({ where: { chatId: TEAM.id, handledAt: null } })).toBe(0);
    expect((await sec.getTeamPeople()).map((p) => p.name)).toEqual(["Carla Lima"]);

    await sec.receiveSecretary("chave", tmsg("T2", "Clara, anota pra Carla mandar os convites até quarta 18h", "5517981600088", "Wellington"));
    expect(await db.job.count({ where: { type: "secretaria.turn", status: "PENDING" } })).toBe(1);
    script.push(
      { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "criar_tarefa", input: { titulo: "Mandar os convites do evento", responsavel: "Carla", prazo: "2026-12-02T18:00" } }] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Anotado, @Carla: convites até quarta 18h." }] },
    );
    await ai.runSecretaryTurn(TEAM.id, new Date("2026-11-26T12:00:00Z"));
    // The chatter came as context, the call as new
    expect(String(seen[0].user)).toContain("evento de franqueados");
    expect(seen[0].system).toContain("Carla Lima");
    const task = await db.secretaryTask.findFirstOrThrow();
    expect(task).toMatchObject({ assignee: "Carla Lima", assigneePhone: "5517992223333", chatId: TEAM.id });
    expect(sent[0]).toEqual({ number: TEAM.id, text: "Anotado, @5517992223333: convites até quarta 18h.", mentions: ["5517992223333"] });
    // Chased in the team group, not in private
    sent.length = 0;
    await sec.runSecretaryCron(new Date("2026-12-02T21:01:00Z"));
    expect(sent.find((x) => x.text.includes("Cobrando"))?.number).toBe(TEAM.id);
  });
});

