// What the portal tells the CRM of a referral (a note, a cancellation, the cancellation taken back) and the e-mail it asks
// the CRM to send a partner. Only with the portal's token; a cancellation closes the lead only when nobody else's deal
// goes with it; each notice counts once. The partner's e-mail is the CRM's own text, with only the names and a link to
// the portal from outside, so it is the one notice that may leave the company's domain. The validation and the texts
// always run; the routes only when TEST_DATABASE_URL is set. The mail server and the portal (fetch) are stubbed, and
// nothing leaves the machine.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead, Stage } from "@prisma/client";
import { emailHtml } from "@/lib/email";
import { PORTAL_EMAIL_TO, partnerNotice, partnerNoticeInput, queuePortalEmail } from "@/lib/portal-email";
import { PortalReferralInput, REOPENED_IN_PORTAL } from "@/lib/portal-referral";
import { REFERRAL_FUNNEL } from "@/lib/plan";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; body: string; replyTo?: string }[] }));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (to: string, subject: string, body: string, _a?: unknown, _h?: unknown, replyTo?: string) => {
    mail.sent.push({ to, subject, body, replyTo });
    return `<id${mail.sent.length}@teste>`;
  }),
}));

const PORTAL = "https://portal.banneg.com.br";
const partner = { ref: "aviso1", para: "Ana@Lotus.com.br", nome: "Ana", tipo: "PENDENCIA", sobre: "a indicação de Maria", link: `${PORTAL}/loja/clientes/c1#conversa-banneg` };
const note = { ref: "portal:cli1", aviso: "av1", acao: "NOTA", texto: "Dados corrigidos no portal pelo Banneg: Placa: ABC1D23 → ABC1D24", autor: "Wellington" };
const FOOTER = "Este é um aviso automático do Banneg. Para falar com a equipe, responda pelo portal.";

describe("referral notice input", () => {
  it("takes a note, a cancellation and a reopening, and only a reopening may come without a text", () => {
    expect(PortalReferralInput.parse(note)).toEqual(note);
    expect(PortalReferralInput.parse({ ...note, acao: "CANCELAR", texto: "  Cliente desistiu  " }).texto).toBe("Cliente desistiu");
    expect(PortalReferralInput.parse({ ...note, acao: "REABRIR", texto: undefined }).texto).toBe("");
    expect(PortalReferralInput.parse({ ...note, acao: "REABRIR", texto: "" }).acao).toBe("REABRIR");
    for (const acao of ["CANCELAR", "NOTA"]) {
      expect(PortalReferralInput.safeParse({ ...note, acao, texto: "  \n " }).success, acao).toBe(false);
      expect(PortalReferralInput.safeParse({ ...note, acao, texto: undefined }).success, acao).toBe(false);
    }
  });

  it("refuses another kind of ref, an unknown action and a missing aviso or author", () => {
    for (const bad of [
      { ref: "site:abc" },
      { ref: "" },
      { ref: `portal:${"x".repeat(120)}` },
      { aviso: "" },
      { aviso: "x".repeat(121) },
      { acao: "APAGAR" },
      { autor: " \r\n " },
      { autor: undefined },
      { texto: "x".repeat(8001) },
    ]) {
      expect(PortalReferralInput.safeParse({ ...note, ...bad }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(PortalReferralInput.safeParse(null).success).toBe(false);
  });

  it("keeps the author on one line and cuts a long note or author instead of losing it", () => {
    expect(PortalReferralInput.parse({ ...note, autor: " Wellington\r\nBanneg " }).autor).toBe("Wellington Banneg");
    expect(PortalReferralInput.parse({ ...note, autor: "W".repeat(200) }).autor).toHaveLength(80);
    const long = PortalReferralInput.parse({ ...note, texto: `Recado de Lotus Veículos no portal: ${"x".repeat(2000)}` }).texto;
    expect(long).toHaveLength(2000);
    expect(long.endsWith("…")).toBe(true);
    // Line breaks in a note stay: it is the timeline's text, not a header
    expect(PortalReferralInput.parse({ ...note, texto: "Linha 1\nLinha 2" }).texto).toBe("Linha 1\nLinha 2");
  });
});

describe("partner notice input", () => {
  const input = partnerNoticeInput(PORTAL);

  it("takes a notice with a link to the portal, and lowercases the address", () => {
    expect(input.parse(partner)).toEqual({ ...partner, para: "ana@lotus.com.br" });
    // Any partner's address: a store, an affiliate's gmail
    expect(input.parse({ ...partner, para: "joao.silva@gmail.com" }).para).toBe("joao.silva@gmail.com");
    // No sobre, or an empty one, is the same: the general conversation
    expect(input.parse({ ...partner, sobre: undefined }).sobre).toBeUndefined();
    expect(input.parse({ ...partner, sobre: "  " }).sobre).toBeUndefined();
    for (const tipo of ["PENDENCIA", "RECADO", "CANCELAMENTO"]) expect(input.parse({ ...partner, tipo }).tipo).toBe(tipo);
  });

  it("only links to a page of this portal", () => {
    for (const link of [
      "https://golpe.com/loja",
      "https://portal.banneg.com.br.golpe.com/loja",
      "https://portal.banneg.com.brx/loja",
      "http://portal.banneg.com.br/loja",
      PORTAL,
      `${PORTAL}/loja https://golpe.com`,
      `${PORTAL}/loja"onmouseover="x`,
      `${PORTAL}/${"x".repeat(500)}`,
      "javascript:alert(1)",
    ]) {
      expect(input.safeParse({ ...partner, link }).success, link.slice(0, 60)).toBe(false);
    }
    expect(input.parse({ ...partner, link: ` ${PORTAL}/loja/mensagens ` }).link).toBe(`${PORTAL}/loja/mensagens`);
    // Another portal address set in the CRM: links to it, and only to it
    expect(partnerNoticeInput("http://portal.local").safeParse(partner).success).toBe(false);
    expect(partnerNoticeInput("http://portal.local").parse({ ...partner, link: "http://portal.local/loja" }).link).toBe("http://portal.local/loja");
  });

  it("keeps the names on one line and short, and never lets them carry a link or an address", () => {
    expect(input.parse({ ...partner, nome: "Ana\r\nBcc: x" }).nome).toBe("Ana Bcc: x");
    expect(input.parse({ ...partner, nome: "Maria-Clara D'Ávila" }).nome).toBe("Maria-Clara D'Ávila");
    expect(input.parse({ ...partner, nome: "J.R." }).nome).toBe("J.R.");
    for (const bad of [
      { nome: "" },
      { nome: " \n " },
      { nome: "A".repeat(81) },
      { sobre: "a indicação de " + "M".repeat(70) },
      { nome: "Ana, pague em golpe.com" },
      { nome: "veja https://x" },
      { nome: "www.golpe" },
      { sobre: "ana@golpe.com" },
      { para: "não é e-mail" },
      { para: "a@b@c.com" },
      { para: undefined },
      { tipo: "BOLETO" },
      { ref: "" },
      { ref: "x".repeat(121) },
    ]) {
      expect(input.safeParse({ ...partner, ...bad }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
});

describe("partner notice texts", () => {
  const link = `${PORTAL}/loja/clientes/c1#conversa-banneg`;

  it("a pendência and a message, about a referral or not", () => {
    expect(partnerNotice({ nome: "Ana", tipo: "PENDENCIA", sobre: "a indicação de Maria", link })).toEqual({
      assunto: "O Banneg precisa de você no portal de indicações",
      texto: `Olá, Ana.\n\nO Banneg deixou uma pendência para você, sobre a indicação de Maria.\n\nPara ver e responder, entre no portal:\n${link}\n\n${FOOTER}`,
    });
    expect(partnerNotice({ nome: "Ana", tipo: "PENDENCIA", link }).texto).toContain("O Banneg deixou uma pendência para você.\n\n");
    expect(partnerNotice({ nome: "Ana", tipo: "RECADO", link: `${PORTAL}/loja/mensagens` })).toEqual({
      assunto: "Você tem um recado do Banneg no portal de indicações",
      texto: `Olá, Ana.\n\nO Banneg deixou um recado para você.\n\nPara ver e responder, entre no portal:\n${PORTAL}/loja/mensagens\n\n${FOOTER}`,
    });
    expect(partnerNotice({ nome: "Ana", tipo: "RECADO", sobre: "a indicação de Maria", link }).texto).toContain(
      "O Banneg deixou um recado para você, sobre a indicação de Maria.",
    );
  });

  it("a cancellation, which has nothing to answer", () => {
    expect(partnerNotice({ nome: "Ana", tipo: "CANCELAMENTO", sobre: "a indicação de Maria", link })).toEqual({
      assunto: "O Banneg cancelou uma indicação no portal",
      texto: `Olá, Ana.\n\nO Banneg cancelou a indicação de Maria. O motivo está no portal.\n\nPara ver, entre no portal:\n${link}\n\n${FOOTER}`,
    });
    expect(partnerNotice({ nome: "Ana", tipo: "CANCELAMENTO", link }).texto).toContain("O Banneg cancelou uma indicação sua. O motivo está no portal.");
  });

  it("the link is the e-mail's one clickable link", () => {
    const html = emailHtml(partnerNotice({ nome: "Ana", tipo: "RECADO", link }).texto);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`<a href="${link}">`);
  });
});

describe("the portal's own notices", () => {
  it("never leave the company's domain, whoever queues them; only the CRM's own text may", async () => {
    // Refused before the queue is even looked at
    for (const para of ["cliente@gmail.com", "x@banneg.com.br.evil.com", "x@evilbanneg.com.br", "@banneg.com.br", "a@b@banneg.com.br"]) {
      await expect(queuePortalEmail({ ref: "x", para, assunto: "a", texto: "b", responderPara: undefined }), para).rejects.toThrow("O portal só manda e-mail para endereços @banneg.com.br.");
    }
  });
});

describe.skipIf(!dbUrl)("referral notice route", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let api: typeof import("@/app/api/portal/indicacao/route");
  let st: Record<"novo" | "contato" | "ganho" | "perdido" | "erro", Stage>;
  let cotacoes: { id: string };
  const env = { url: process.env.PORTAL_URL, token: process.env.PORTAL_LEADS_TOKEN };
  const post = (body: unknown, auth = "Bearer portal-token") =>
    api.POST(new Request("http://x/api/portal/indicacao", { method: "POST", headers: { authorization: auth }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const answer = async (body: unknown) => {
    const res = await post(body);
    return { status: res.status, body: await res.json() };
  };
  const cancel = (over: Record<string, unknown> = {}) => ({ ...note, aviso: "av-cancel", acao: "CANCELAR", texto: "Cliente comprou com outra corretora", ...over });
  const current = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });
  const events = (leadId: string) => db.leadEvent.findMany({ where: { leadId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    api = await import("@/app/api/portal/indicacao/route");
    // The stage notice a move queues is never sent here, but nothing could reach a real portal anyway
    vi.stubGlobal("fetch", async () => Response.json({ ok: true, atualizados: 1, ignorados: [] }));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [["PORTAL_URL", env.url], ["PORTAL_LEADS_TOKEN", env.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    process.env.PORTAL_URL = "http://portal.local/";
    process.env.PORTAL_LEADS_TOKEN = "portal-token";
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","LeadDocument","Lead","SdrAgent","AutomationRule","Stage","Pipeline","User","Setting" CASCADE',
    );
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    // Cotações without automations, so a move only does what is tested here
    cotacoes = await db.pipeline.create({ data: { name: "Cotações", slug: "parceiro-veiculos" } });
    const make = (name: string, position: number, kind: Stage["kind"] = "OPEN", key: string | null = null) =>
      db.stage.create({ data: { pipelineId: cotacoes.id, name, position, kind, key } });
    st = {
      novo: await make("Novo", 0, "OPEN", "novo"),
      contato: await make("Em contato", 1),
      ganho: await make("Ganho", 2, "WON"),
      erro: await make("Erro no WhatsApp", 3, "LOST", "erro_envio"),
      perdido: await make("Perdido", 4, "LOST", "perdido"),
    };
  });

  const newLead = (externalId: string | null = "portal:cli1", over: Partial<Pick<Lead, "stageId" | "pipelineId" | "lostReason">> & { qualification?: Record<string, string> } = {}) =>
    db.lead.create({
      data: { name: "Maria Souza", source: "Parceiro Lotus", externalId, pipelineId: cotacoes.id, stageId: st.contato.id, qualification: { parceiro: "Lotus Veículos", [REFERRAL_FUNNEL]: cotacoes.id }, ...over },
    });
  const filed = (leadId: string, ref: string, extra: object = {}) =>
    db.leadEvent.create({ data: { leadId, type: "lead.form", actor: "Portal", summary: "Indicação recebida.", data: { ref, ...extra } } });

  it("refuses another site's token and a bad body, and answers lead_nao_encontrado for a referral the CRM never got", async () => {
    await newLead();
    expect((await post(note, "Bearer outro")).status).toBe(401);
    expect((await post(note, "")).status).toBe(401);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...note, acao: "APAGAR" })).status).toBe(400);
    expect((await post({ ...note, acao: "CANCELAR", texto: "" })).status).toBe(400);
    expect(await answer({ ...note, ref: "portal:outra" })).toEqual({ status: 404, body: { error: "lead_nao_encontrado" } });
    // A ref closed as a duplicate is not the referral's lead (it went on in the one with its lead.form)
    await newLead("portal:dup#duplicado", { stageId: st.perdido.id });
    expect((await post({ ...note, ref: "portal:dup" })).status).toBe(404);
    expect(await db.leadEvent.count()).toBe(0);
  });

  it("a note goes on the lead's timeline, by the portal's author, and moves nothing", async () => {
    const lead = await newLead();
    expect(await answer(note)).toEqual({ status: 200, body: { ok: true, lead: lead.id, repeated: false, moved: false } });
    expect(await events(lead.id)).toMatchObject([{ type: "portal.nota", actor: "Portal (Wellington)", summary: note.texto, data: { ref: "portal:cli1", aviso: "av1" } }]);
    expect((await current(lead.id)).stageId).toBe(st.contato.id);
  });

  it("a cancellation taken back is told to the team, and the lead stays where it is", async () => {
    const lead = await newLead("portal:cli1", { stageId: st.perdido.id, lostReason: "Cancelada no portal: Cliente desistiu" });
    expect((await answer({ ...note, aviso: "av2", acao: "REABRIR", texto: "" })).body).toEqual({ ok: true, lead: lead.id, repeated: false, moved: false });
    expect(await events(lead.id)).toMatchObject([{ type: "portal.reaberta", actor: "Portal (Wellington)", summary: REOPENED_IN_PORTAL, data: { ref: "portal:cli1", aviso: "av2" } }]);
    expect(REOPENED_IN_PORTAL).toBe("O Banneg desfez no portal o cancelamento desta indicação. Se a equipe for atender de novo, mova o lead.");
    expect(await current(lead.id)).toMatchObject({ stageId: st.perdido.id, lostReason: "Cancelada no portal: Cliente desistiu" });
  });

  it("a cancellation closes an open lead as lost: the reason goes to the store, the AI stops and the alert goes away", async () => {
    const lead = await newLead();
    const reply = await db.job.create({ data: { type: "sdr.reply", leadId: lead.id, runAt: new Date(Date.now() + 60_000) } });
    expect(await answer(cancel())).toEqual({ status: 200, body: { ok: true, lead: lead.id, repeated: false, moved: true } });
    const now = await current(lead.id);
    expect(now).toMatchObject({ stageId: st.perdido.id, status: "LOST", aiPaused: true, lostReason: "Cancelada no portal: Cliente comprou com outra corretora" });
    expect(now.alertsClearedAt).not.toBeNull();
    expect(now.seenAt).not.toBeNull();
    expect((await db.job.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe("CANCELLED");
    // The store hears it through the stage notice, as any loss
    expect(await db.job.count({ where: { leadId: lead.id, type: "portal.status", status: "PENDING" } })).toBe(1);
    expect((await events(lead.id)).map((e) => [e.type, e.actor, e.summary])).toEqual([
      ["portal.cancelada", "Portal (Wellington)", "O Banneg cancelou esta indicação no portal: Cliente comprou com outra corretora"],
      ["stage.changed", "Portal (Wellington)", "Em contato → Perdido"],
    ]);
  });

  it("finds the lead a referral reached later, by its file, and cuts a long reason for the lead", async () => {
    const lead = await newLead(null);
    await filed(lead.id, "portal:cli1");
    const texto = "x".repeat(1000);
    expect((await answer(cancel({ texto }))).body).toMatchObject({ lead: lead.id, moved: true });
    expect((await current(lead.id)).lostReason).toBe(`Cancelada no portal: ${texto}`.slice(0, 500));
  });

  it("leaves a closed lead, another referral's deal and another funnel's deal where they are, and says why", async () => {
    const won = await newLead("portal:won", { stageId: st.ganho.id });
    expect((await answer(cancel({ ref: "portal:won", aviso: "a1" }))).body).toEqual({ ok: true, lead: won.id, repeated: false, moved: false, motivo: "lead fechado" });
    expect((await current(won.id)).stageId).toBe(st.ganho.id);
    expect((await events(won.id)).map((e) => e.type)).toEqual(["portal.cancelada"]);

    const lost = await newLead("portal:lost", { stageId: st.perdido.id, lostReason: "Achou caro" });
    expect((await answer(cancel({ ref: "portal:lost", aviso: "a2" }))).body.motivo).toBe("lead fechado");
    expect((await current(lost.id)).lostReason).toBe("Achou caro");

    // A second store referred the same client: her deal goes on
    const shared = await newLead("portal:one");
    await filed(shared.id, "portal:two");
    expect((await answer(cancel({ ref: "portal:one", aviso: "a3" }))).body).toMatchObject({ moved: false, motivo: "outras indicações" });
    expect((await answer(cancel({ ref: "portal:two", aviso: "a4" }))).body).toMatchObject({ moved: false, motivo: "outras indicações" });
    expect((await current(shared.id)).stageId).toBe(st.contato.id);

    // A renewal found the old sale closed and reopened the lead: the old referral keeps its sale, the new one goes on
    const renewed = await newLead("portal:old");
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    await filed(renewed.id, "portal:new", { closedRefs: ["portal:old"], closedAt: day(30), reachedAt: day(20), openedAt: day(20) });
    expect((await answer(cancel({ ref: "portal:old", aviso: "a5" }))).body).toMatchObject({ moved: false, motivo: "outras indicações" });

    // The team works the client in another funnel (a franchise): not the store's deal
    const produtos = await db.pipeline.create({ data: { name: "Produtos", slug: "produtos" } });
    const negociacao = await db.stage.create({ data: { pipelineId: produtos.id, name: "Em negociação", position: 0 } });
    await db.stage.create({ data: { pipelineId: produtos.id, name: "Perdido", position: 1, kind: "LOST", key: "perdido" } });
    const elsewhere = await newLead("portal:fra", { pipelineId: produtos.id, stageId: negociacao.id });
    expect((await answer(cancel({ ref: "portal:fra", aviso: "a6" }))).body).toMatchObject({ moved: false, motivo: "outro funil" });
    expect((await current(elsewhere.id)).stageId).toBe(negociacao.id);
    // None of them heard of a move, and the store none
    expect(await db.job.count({ where: { type: "portal.status" } })).toBe(0);
  });

  it("goes to the funnel's first lost stage without a Perdido, never to Erro no WhatsApp", async () => {
    const outro = await db.pipeline.create({ data: { name: "Consórcio", slug: "consorcio" } });
    const aberto = await db.stage.create({ data: { pipelineId: outro.id, name: "Em contato", position: 0 } });
    await db.stage.create({ data: { pipelineId: outro.id, name: "Erro no WhatsApp", position: 1, kind: "LOST", key: "erro_envio" } });
    const q = { parceiro: "Lotus Veículos", [REFERRAL_FUNNEL]: outro.id };
    const lead = await newLead("portal:c1", { pipelineId: outro.id, stageId: aberto.id, qualification: q });
    expect((await answer(cancel({ ref: "portal:c1", aviso: "b1" }))).body).toMatchObject({ moved: false, motivo: "funil sem etapa de perdido" });
    expect((await current(lead.id)).stageId).toBe(aberto.id);

    const desistiu = await db.stage.create({ data: { pipelineId: outro.id, name: "Desistiu", position: 2, kind: "LOST" } });
    expect((await answer(cancel({ ref: "portal:c1", aviso: "b2" }))).body).toMatchObject({ moved: true });
    expect((await current(lead.id)).stageId).toBe(desistiu.id);
  });

  it("counts each notice once, even after the lead moved, and a new notice again", async () => {
    const lead = await newLead();
    expect((await answer(cancel())).body.moved).toBe(true);
    // The portal never heard the answer and sends it again; meanwhile the team took the lead back
    await leads.moveLead(lead.id, st.contato.id, "Gerente", {}, { rules: false });
    expect(await answer(cancel())).toEqual({ status: 200, body: { ok: true, lead: lead.id, repeated: true, moved: false } });
    expect((await current(lead.id)).stageId).toBe(st.contato.id);
    expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "portal.cancelada" } })).toBe(1);

    expect((await answer(note)).body.repeated).toBe(false);
    expect((await answer(note)).body).toEqual({ ok: true, lead: lead.id, repeated: true, moved: false });
    expect((await answer({ ...note, aviso: "av9" })).body.repeated).toBe(false);
    expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "portal.nota" } })).toBe(2);
  });
});

describe.skipIf(!dbUrl)("partner notice route", () => {
  let db: typeof import("@/lib/db").db;
  let jobs: typeof import("@/lib/jobs");
  let api: typeof import("@/app/api/portal/aviso-parceiro/route");
  let team: typeof import("@/app/api/portal/email/route");
  const env = { url: process.env.PORTAL_URL, token: process.env.PORTAL_LEADS_TOKEN };
  const request = (path: string, body: unknown, auth: string) =>
    new Request(`http://x${path}`, { method: "POST", headers: { authorization: auth }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const post = (body: unknown, auth = "Bearer portal-token") => api.POST(request("/api/portal/aviso-parceiro", body, auth));
  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await jobs.runDueJobs()).length === 0) break;
  };

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    jobs = await import("@/lib/jobs");
    api = await import("@/app/api/portal/aviso-parceiro/route");
    team = await import("@/app/api/portal/email/route");
  });
  afterAll(() => {
    for (const [k, v] of [["PORTAL_URL", env.url], ["PORTAL_LEADS_TOKEN", env.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    mail.sent.length = 0;
    process.env.PORTAL_URL = `${PORTAL}/`;
    process.env.PORTAL_LEADS_TOKEN = "portal-token";
    await db.$executeRawUnsafe('TRUNCATE "Job","Setting" CASCADE');
    await db.setting.create({ data: { key: "crm", value: { testMode: true } } });
  });

  it("refuses another site's token, a link outside the portal, and everything without the portal's address", async () => {
    expect((await post(partner, "Bearer outro")).status).toBe(401);
    expect((await post(partner, "")).status).toBe(401);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...partner, link: "https://golpe.com/loja" })).status).toBe(400);
    expect((await post({ ...partner, nome: "Ana, pague em golpe.com" })).status).toBe(400);
    delete process.env.PORTAL_URL;
    const off = await post(partner);
    expect(off.status).toBe(422);
    expect(await off.json()).toEqual({ error: "PORTAL_URL não configurado" });
    // The token is checked first all the same
    expect((await post(partner, "Bearer outro")).status).toBe(401);
    expect(await db.job.count()).toBe(0);
  });

  it("queues the CRM's own text to the partner, answered by the team's box, and sends a repeated ref once", async () => {
    const first = await post(partner);
    expect(first.status).toBe(202);
    const { id, status, repeated } = await first.json();
    expect({ status, repeated }).toEqual({ status: "PENDING", repeated: false });
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    const { assunto, texto } = partnerNotice({ nome: "Ana", tipo: "PENDENCIA", sobre: "a indicação de Maria", link: partner.link });
    expect(job).toMatchObject({ type: "portal.email", maxAttempts: 6 });
    expect(job.payload).toEqual({ ref: "parceiro:aviso1", para: "ana@lotus.com.br", assunto, texto, responderPara: PORTAL_EMAIL_TO });

    const again = await post(partner);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, id, repeated: true, status: "PENDING" });
    // Test mode holds back messages to leads; a partner is not one
    await drain();
    expect(mail.sent).toEqual([{ to: "ana@lotus.com.br", subject: assunto, body: texto, replyTo: "seguros@banneg.com.br" }]);
    expect(await (await post(partner)).json()).toMatchObject({ id, repeated: true, status: "DONE" });
    await drain();
    expect(mail.sent).toHaveLength(1);
  });

  it("the team's route still writes only to the company, and the two kinds of notice never take each other's ref", async () => {
    const outside = await team.POST(request("/api/portal/email", { ref: "x1", para: "ana@lotus.com.br", assunto: "Oi", texto: "Oi" }, "Bearer portal-token"));
    expect(outside.status).toBe(400);
    // Nothing the portal sends makes its own words trusted
    const marked = await team.POST(request("/api/portal/email", { ref: "x2", para: "ana@lotus.com.br", assunto: "Oi", texto: "Oi", trusted: true }, "Bearer portal-token"));
    expect(marked.status).toBe(400);
    const teamNotice = await team.POST(request("/api/portal/email", { ref: "aviso1", assunto: "Recado de Lotus", texto: "Oi" }, "Bearer portal-token"));
    expect(teamNotice.status).toBe(202);
    expect((await post(partner)).status).toBe(202);
    await drain();
    expect(mail.sent.map((m) => m.to).sort()).toEqual(["ana@lotus.com.br", "seguros@banneg.com.br"]);
  });
});
