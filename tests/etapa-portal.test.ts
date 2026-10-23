// The lead's stage in the store's portal: a loss always has a reason, a won quote has its policy attached, and each
// stage change of a referral is sent to the portal through the queue. The pure rules always run; the rest only when
// TEST_DATABASE_URL is set. fetch (the portal) is stubbed, and nothing leaves the machine.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lead, Stage } from "@prisma/client";
import { cycleStart, MAX_PORTAL_REFS, portalRefs, portalStatusOf, storeReason } from "@/lib/portal-status";
import { checkStageMove } from "@/lib/stage-move";
import { REFERRAL_FUNNEL } from "@/lib/plan";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

// Who is signed in for the routes and the server action (null = nobody)
const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string; role: "OWNER" | "MANAGER" | "SELLER" } }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  currentUser: vi.fn(async () => session.user),
  requireUser: vi.fn(async () => {
    if (!session.user) throw new Error("sem sessão");
    return session.user;
  }),
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: vi.fn() }));

const stage = (over: Partial<Pick<Stage, "kind" | "key" | "name" | "position">>) => ({ kind: "OPEN" as const, key: null, name: "Etapa", position: 3, ...over });

describe("portal status of a stage", () => {
  it("maps won, lost and open stages, and leaves Erro no WhatsApp out", () => {
    expect(portalStatusOf(stage({ kind: "WON", key: "ganho", name: "Ganho" }), 0)).toBe("FECHADO");
    expect(portalStatusOf(stage({ kind: "LOST", key: "perdido", name: "Perdido" }), 0)).toBe("PERDIDO");
    expect(portalStatusOf(stage({ kind: "LOST", key: "descartado", name: "Descartado" }), 0)).toBe("PERDIDO");
    expect(portalStatusOf(stage({ kind: "LOST", key: "erro_envio", name: "Erro no WhatsApp" }), 0)).toBeNull();
    expect(portalStatusOf(stage({ key: "novo", name: "Novo", position: 2 }), 0)).toBe("NOVO");
    expect(portalStatusOf(stage({ name: "Proposta enviada" }), 0)).toBe("PROPOSTA");
    expect(portalStatusOf(stage({ name: "AGUARDANDO PROPÓSTA" }), 0)).toBe("PROPOSTA");
    expect(portalStatusOf(stage({ key: "qualificando", name: "IA qualificando" }), 0)).toBe("EM_ATENDIMENTO");
    expect(portalStatusOf(stage({ name: "Em contato" }), 0)).toBe("EM_ATENDIMENTO");
  });

  it("reads a funnel made in the CRM, whose stages have no key", () => {
    // BLANK_STAGES: Novo, Em contato, Proposta, Ganho, Perdido
    expect(portalStatusOf(stage({ name: "Novo", position: 0 }), 0)).toBe("NOVO");
    expect(portalStatusOf(stage({ name: "Em contato", position: 1 }), 0)).toBe("EM_ATENDIMENTO");
    expect(portalStatusOf(stage({ name: "Proposta", position: 2 }), 0)).toBe("PROPOSTA");
    expect(portalStatusOf(stage({ kind: "WON", name: "Ganho", position: 3 }), 0)).toBe("FECHADO");
    expect(portalStatusOf(stage({ kind: "LOST", name: "Perdido", position: 4 }), 0)).toBe("PERDIDO");
  });
});

describe("portal refs of a lead", () => {
  it("takes the lead's own ref and the referrals that reached it later, each once", () => {
    const events = [{ data: { ref: "portal:bbb" } }, { data: { ref: "portal:aaa" } }, { data: null }, { data: { ref: "site:x" } }, { data: { ref: "portal:bbb" } }];
    expect(portalRefs("portal:aaa", events)).toEqual(["portal:aaa", "portal:bbb"]);
    expect(portalRefs(null, events)).toEqual(["portal:bbb", "portal:aaa"]);
    expect(portalRefs("meta:123", [])).toEqual([]);
  });

  it("leaves out the referrals a later one found closed, so a won sale or a loss stays as the store saw it", () => {
    const events = [{ data: { ref: "portal:aaa" } }, { data: { ref: "portal:bbb", closedRefs: ["portal:aaa"] } }, { data: { ref: "portal:ccc" } }];
    expect(portalRefs("portal:aaa", events)).toEqual(["portal:bbb", "portal:ccc"]);
  });

  it("until the lead is open again, the close stays with the refs it closed and a referral that found it closed waits", () => {
    const closed = { closedRefs: ["portal:aaa"], closedAt: "T1", reachedAt: "2026-10-20T12:00:00.000Z" };
    const events = [{ data: { ref: "portal:bbb", ...closed } }];
    expect(portalRefs("portal:aaa", events, "T1")).toEqual(["portal:aaa"]);
    // Moved between closed stages (the sale cancelled): still the old deal's
    expect(portalRefs("portal:aaa", events, "T2")).toEqual(["portal:aaa"]);
    // openedAt is written just before the lead enters an open stage: it counts once the lead is there
    const opened = (list: { data: object }[], at: string) => list.map((e) => ({ data: { ...e.data, openedAt: at } }));
    expect(portalRefs("portal:aaa", opened(events, "T3"), "T2")).toEqual(["portal:aaa"]);
    expect(portalRefs("portal:aaa", opened(events, "T3"), "T3")).toEqual(["portal:bbb"]);
    expect(portalRefs("portal:aaa", opened(events, "T3"), "T4")).toEqual(["portal:bbb"]);
    // Another referral to the same close waits too, and both follow the lead once it is open
    const two = [...events, { data: { ref: "portal:ccc", ...closed } }];
    expect(portalRefs("portal:aaa", two, "T2")).toEqual(["portal:aaa"]);
    expect(portalRefs("portal:aaa", opened(two, "T3"), "T3")).toEqual(["portal:bbb", "portal:ccc"]);
    // A close that was no referral's (a franchise sale) says nothing to the referral that found it
    expect(portalRefs(null, [{ data: { ref: "portal:bbb", closedRefs: [], closedAt: "T1" } }], "T1")).toEqual([]);
    // A later close found by a third referral: the second one keeps it, the first stays out
    const later = [...opened(events, "T3"), { data: { ref: "portal:ccc", closedRefs: ["portal:bbb"], closedAt: "T5" } }];
    expect(portalRefs("portal:aaa", later, "T5")).toEqual(["portal:bbb"]);
    expect(portalRefs("portal:aaa", [later[0], ...opened(later.slice(1), "T6")], "T6")).toEqual(["portal:ccc"]);
    // A won deal the lead left for an open stage (lead.reopened, no ref): its referral keeps the sale
    const reopened = [{ data: { closedRefs: ["portal:aaa"], closedAt: "T1", reachedAt: "2026-10-20T12:00:00.000Z", openedAt: "T2" } }];
    expect(portalRefs("portal:aaa", reopened, "T1")).toEqual(["portal:aaa"]);
    expect(portalRefs("portal:aaa", reopened, "T2")).toEqual([]);
  });

  it("a sale starts over only when a referral reopened the lead, from when that referral arrived", () => {
    const first = { data: { ref: "portal:aaa" }, createdAt: new Date("2026-01-05T10:00:00Z") };
    const renewal = {
      data: { ref: "portal:bbb", closedRefs: ["portal:aaa"], closedAt: "T1", reachedAt: "2026-12-01T09:00:00.000Z" },
      createdAt: new Date("2026-11-30T09:00:00Z"),
    };
    expect(cycleStart([first], "T1")).toBeNull();
    // Still in the close the renewal found: the earlier sale goes on, unless the lead is leaving it
    expect(cycleStart([first, renewal], "T1")).toBeNull();
    expect(cycleStart([first, renewal], "T1", true)).toEqual(new Date("2026-12-01T09:00:00.000Z"));
    expect(cycleStart([first, renewal], "T2")).toEqual(new Date("2026-12-01T09:00:00.000Z"));
  });

  it("the store reads the team's reason, never a name or a technical error", () => {
    expect(storeReason("Achou caro")).toBe("Achou caro");
    expect(storeReason("Encerrado sem motivo informado (Wellington)")).toBe("Encerrado sem motivo informado");
    expect(storeReason(null)).toBe("Encerrado sem motivo informado");
    expect(storeReason("WhatsApp não chega neste contato: (#131026) Message undeliverable")).toBe("Não conseguimos falar com o cliente pelo WhatsApp");
  });

  it("leaves out a ref marked as duplicate and stops at the portal's limit", () => {
    expect(portalRefs("portal:aaa#duplicado", [{ data: { ref: "portal:ccc" } }])).toEqual(["portal:ccc"]);
    const many = Array.from({ length: 30 }, (_, i) => ({ data: { ref: `portal:r${i}` } }));
    expect(portalRefs("portal:zzz", many)).toHaveLength(MAX_PORTAL_REFS);
  });
});

describe("checkStageMove", () => {
  const quote = { stageId: "s-novo", externalId: "portal:abc", pipeline: { slug: "parceiro-veiculos" } };
  const franchise = { stageId: "s-novo", externalId: null, pipeline: { slug: null } };
  const won = { id: "s-ganho", kind: "WON" as const };
  const lost = { id: "s-perdido", kind: "LOST" as const };

  it("asks for the reason of a loss", () => {
    expect(checkStageMove(franchise, lost, { hasApolice: false })).toEqual({ need: "reason", error: "Informe o motivo da perda." });
    expect(checkStageMove(franchise, lost, { reason: "   ", hasApolice: false })?.need).toBe("reason");
    expect(checkStageMove(franchise, lost, { reason: "Achou caro", hasApolice: false })).toBeNull();
  });

  it("asks for the policy of a won quote, and only there", () => {
    expect(checkStageMove(quote, won, { hasApolice: false })).toEqual({ need: "apolice", error: "Anexe a apólice (no consórcio, o contrato) antes de marcar como Ganho." });
    expect(checkStageMove(quote, won, { hasApolice: true })).toBeNull();
    // A store's referral in another funnel is a quote too
    expect(checkStageMove({ ...franchise, externalId: "portal:x" }, won, { hasApolice: false })?.need).toBe("apolice");
    // Into Cotações from another funnel
    expect(checkStageMove(franchise, { ...won, pipeline: { slug: "parceiro-veiculos" } }, { hasApolice: false })?.need).toBe("apolice");
    expect(checkStageMove(franchise, won, { hasApolice: false })).toBeNull();
    // Already there: nothing to ask
    expect(checkStageMove({ ...quote, stageId: won.id }, won, { hasApolice: false })).toBeNull();
  });

  it("asks what happened to a won sale a store follows when it goes back to an open stage", () => {
    const sold = { ...quote, stageId: won.id, stage: { kind: "WON" as const } };
    const contato = { id: "s-contato", kind: "OPEN" as const };
    expect(checkStageMove(sold, contato, { hasApolice: false, storeFollows: true })).toEqual({
      need: "reopen",
      error: "Diga se a venda foi desfeita ou se é um novo atendimento.",
    });
    expect(checkStageMove(sold, contato, { hasApolice: false, storeFollows: true, reopen: "new" })).toBeNull();
    expect(checkStageMove(sold, contato, { hasApolice: false, storeFollows: true, reopen: "undone" })).toBeNull();
    // Only the two answers count
    expect(checkStageMove(sold, contato, { hasApolice: false, storeFollows: true, reopen: "talvez" as never })?.need).toBe("reopen");
    // No store sees the sale: nothing to ask
    expect(checkStageMove(sold, contato, { hasApolice: false })).toBeNull();
    // Cancelled (a loss with its reason) or still won: the store hears it as it is
    expect(checkStageMove(sold, lost, { reason: "Cliente cancelou", hasApolice: false, storeFollows: true })).toBeNull();
    expect(checkStageMove(sold, { id: "s-pago", kind: "WON" }, { hasApolice: true, storeFollows: true })).toBeNull();
    // Out of a loss or an open stage there is no sale to ask about
    expect(checkStageMove({ ...quote, stage: { kind: "LOST" } }, contato, { hasApolice: false, storeFollows: true })).toBeNull();
    expect(checkStageMove({ ...quote, stage: { kind: "OPEN" } }, contato, { hasApolice: false, storeFollows: true })).toBeNull();
  });
});

describe.skipIf(!dbUrl)("stage of a referral in the portal", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let jobs: typeof import("@/lib/jobs");
  let portal: typeof import("@/lib/portal");
  let docsRoute: typeof import("@/app/api/leads/[id]/documentos/route");
  let docRoute: typeof import("@/app/api/leads/[id]/documentos/[docId]/route");
  let actions: typeof import("@/app/actions");
  let leadsApi: typeof import("@/app/api/leads/route");
  let st: Record<"novo" | "contato" | "proposta" | "ganho" | "perdido" | "erro", Stage>;
  let cotacoes: { id: string };
  const env = { url: process.env.PORTAL_URL, token: process.env.PORTAL_LEADS_TOKEN };
  const calls: { url: string; headers: Record<string, string>; redirect?: string; body: Record<string, unknown> }[] = [];
  let reply: () => Response = () => Response.json({ ok: true, atualizados: 1, ignorados: [] });

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    jobs = await import("@/lib/jobs");
    portal = await import("@/lib/portal");
    docsRoute = await import("@/app/api/leads/[id]/documentos/route");
    docRoute = await import("@/app/api/leads/[id]/documentos/[docId]/route");
    actions = await import("@/app/actions");
    leadsApi = await import("@/app/api/leads/route");
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; redirect?: string; body: string }) => {
      calls.push({ url, headers: init.headers, redirect: init.redirect, body: JSON.parse(init.body) });
      return reply();
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [["PORTAL_URL", env.url], ["PORTAL_LEADS_TOKEN", env.token]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    calls.length = 0;
    reply = () => Response.json({ ok: true, atualizados: 1, ignorados: [] });
    process.env.PORTAL_URL = "http://portal.local/";
    process.env.PORTAL_LEADS_TOKEN = "teste-local";
    session.user = { id: "u1", name: "Wellington", role: "SELLER" };
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
      proposta: await make("Proposta enviada", 2),
      ganho: await make("Ganho", 3, "WON"),
      perdido: await make("Perdido", 4, "LOST", "perdido"),
      erro: await make("Erro no WhatsApp", 5, "LOST", "erro_envio"),
    };
  });

  const newLead = (externalId: string | null = "portal:cli1", over: Partial<Pick<Lead, "stageId">> = {}) =>
    db.lead.create({ data: { name: "Maria Souza", source: "Parceiro Lotus", externalId, pipelineId: cotacoes.id, stageId: st.novo.id, ...over } });
  const move = (lead: { id: string }, to: Stage, extra = {}) => leads.moveLead(lead.id, to.id, "Gerente", extra, { rules: false });
  const portalJobs = (leadId: string) => db.job.findMany({ where: { leadId, type: "portal.status" }, orderBy: { createdAt: "asc" } });
  const current = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });
  const attach = (leadId: string, createdAt?: Date) =>
    db.leadDocument.create({
      data: { leadId, name: "apolice.pdf", mimeType: "application/pdf", size: 9, sha256: "x", data: new Uint8Array(Buffer.from("%PDF-1.4 ")), uploadedBy: "W", createdAt },
    });
  // The store sends the same client again (Portal de indicações → POST /api/leads)
  const refer = (ref: string) =>
    leadsApi.POST(
      new Request("http://crm.local/api/leads", {
        method: "POST",
        headers: { authorization: "Bearer teste-local" },
        body: JSON.stringify({ name: "Maria Souza", phone: "5541999998888", funil: "parceiro-veiculos", parceiro: "Lotus Veículos", produto: "seguro auto", ref }),
      }),
    );
  const runPortalJobs = async () => {
    await db.job.updateMany({ where: { type: "portal.status", status: "PENDING" }, data: { runAt: new Date() } });
    await jobs.runDueJobs();
  };

  describe("loss reason", () => {
    it("closes with a reason even when the move gives none, and drops it when the lead leaves the lost stages", async () => {
      const lead = await newLead(null);
      await leads.moveLead(lead.id, st.perdido.id, "Automação", {}, { rules: false });
      expect((await current(lead.id)).lostReason).toBe("Encerrado sem motivo informado (Automação)");
      // From one lost stage to another the reason holds
      await move(lead, st.erro);
      expect((await current(lead.id)).lostReason).toBe("Encerrado sem motivo informado (Automação)");
      await move(lead, st.contato);
      expect((await current(lead.id)).lostReason).toBeNull();

      await move(lead, st.perdido, { lostReason: "Achou caro" });
      expect((await current(lead.id)).lostReason).toBe("Achou caro");
      // An empty reason is no reason
      await move(lead, st.contato);
      await move(lead, st.perdido, { lostReason: "" });
      expect((await current(lead.id)).lostReason).toMatch(/^Encerrado sem motivo informado/);
      // Who moves it back may say what to keep
      await move(lead, st.novo, { lostReason: "Voltou a falar" });
      expect((await current(lead.id)).lostReason).toBe("Voltou a falar");
    });

    it("the rule that moves to a lost stage says it was an automation", async () => {
      const lead = await newLead(null, { stageId: st.contato.id });
      expect(await jobs.runAction(lead, "move", { toStageId: st.perdido.id }, "sem resposta em Em contato")).toBe("Movido para Perdido.");
      expect((await current(lead.id)).lostReason).toBe("Automação: sem resposta em Em contato");
      // A rule firing after the team already closed it does not overwrite the team's reason
      await move(lead, st.contato);
      await move(lead, st.perdido, { lostReason: "Comprou com outra corretora" });
      await jobs.runAction(await current(lead.id), "move", { toStageId: st.perdido.id }, "Em contato");
      expect((await current(lead.id)).lostReason).toBe("Comprou com outra corretora");
    });
  });

  describe("loss reason between lost stages", () => {
    const archive = () => db.stage.create({ data: { pipelineId: cotacoes.id, name: "Arquivados", position: 6, kind: "LOST" } });

    it("a rule moving a lost lead to another lost stage keeps the reason it was closed with", async () => {
      const arquivo = await archive();
      const lead = await newLead(null);
      await move(lead, st.perdido, { lostReason: "Fechou com outra corretora" });
      expect(await jobs.runAction(await current(lead.id), "move", { toStageId: arquivo.id }, "sem resposta em Perdido")).toBe("Movido para Arquivados.");
      expect(await current(lead.id)).toMatchObject({ stageId: arquivo.id, lostReason: "Fechou com outra corretora" });
    });

    it("so does the daily batch out of a lost stage", async () => {
      const arquivo = await archive();
      const lead = await db.lead.create({
        data: { name: "Maria Souza", phone: "5541911112222", source: "site", pipelineId: cotacoes.id, stageId: st.perdido.id, lostReason: "Achou caro" },
      });
      await db.automationRule.create({ data: { stageId: st.perdido.id, trigger: "daily", action: "move", config: { toStageId: arquivo.id, perDay: 10 } } });
      const { runDailyBatches } = await import("@/lib/batches");
      // A Wednesday, 10:00 in São Paulo
      expect(await runDailyBatches(new Date("2026-10-21T13:00:00Z"))).toMatchObject({ released: 1 });
      expect(await current(lead.id)).toMatchObject({ stageId: arquivo.id, lostReason: "Achou caro" });
    });
  });

  describe("queue", () => {
    it("queues one notice per stage change of a portal referral", async () => {
      const lead = await newLead();
      await move(lead, st.contato);
      await move(lead, st.proposta);
      const queued = await portalJobs(lead.id);
      expect(queued).toHaveLength(2);
      expect(queued[0]).toMatchObject({ status: "PENDING", maxAttempts: 6, dedupeKey: null });
      expect((queued[1].payload as { stageEnteredAt: string }).stageEnteredAt).toBe((await current(lead.id)).stageEnteredAt.toISOString());
    });

    it("also for a lead the store referred again (its ref only on the timeline)", async () => {
      const lead = await newLead(null);
      await db.leadEvent.create({ data: { leadId: lead.id, type: "lead.form", actor: "Parceiro", summary: "Indicação recebida.", data: { ref: "portal:cli9" } } });
      expect(await portal.leadPortalRefs(lead)).toEqual(["portal:cli9"]);
      await move(lead, st.contato);
      expect(await portalJobs(lead.id)).toHaveLength(1);
    });

    it("queues nothing for a lead without a referral, a duplicate, or with the sync off", async () => {
      const plain = await newLead(null);
      await move(plain, st.contato);
      expect(await portalJobs(plain.id)).toHaveLength(0);

      const dup = await newLead("portal:cli2#duplicado");
      await move(dup, st.perdido, { lostReason: "Duplicado" });
      expect(await portalJobs(dup.id)).toHaveLength(0);

      delete process.env.PORTAL_URL;
      const off = await newLead("portal:cli3");
      await move(off, st.contato);
      expect(await portalJobs(off.id)).toHaveLength(0);
    });

    it("says nothing of a deal the team works in another funnel, until the lead is in the one the store sent it to", async () => {
      const produtos = await db.pipeline.create({ data: { name: "Produtos", slug: "produtos" } });
      const aberto = await db.stage.create({ data: { pipelineId: produtos.id, name: "Em negociação", position: 0 } });
      const ganho = await db.stage.create({ data: { pipelineId: produtos.id, name: "Ganho", position: 1, kind: "WON" } });
      const descartado = await db.stage.create({ data: { pipelineId: produtos.id, name: "Descartado", position: 2, kind: "LOST", key: "descartado" } });
      // Open in Produtos when a store referred her to Cotações: she stays there, and the referral is on her timeline
      const lead = await db.lead.create({
        data: { name: "Rui", source: "site", pipelineId: produtos.id, stageId: aberto.id, qualification: { parceiro: "Garagem Sul", [REFERRAL_FUNNEL]: cotacoes.id } },
      });
      await db.leadEvent.create({ data: { leadId: lead.id, type: "lead.form", actor: "Parceiro", summary: "x", data: { ref: "portal:rui" } } });
      await move(lead, ganho);
      await move(lead, descartado, { lostReason: "Descartado pela IA: não tem o capital mínimo" });
      expect(await portalJobs(lead.id)).toHaveLength(0);
      expect(await portal.sendPortalStatus(await current(lead.id))).toBe("Nada a enviar ao portal");
      expect(calls).toHaveLength(0);
      await move(lead, st.contato);
      expect(await portalJobs(lead.id)).toHaveLength(1);
    });

    it("runs the portal's notices after the other jobs, a few per run", async () => {
      const lead = await newLead();
      const old = new Date(Date.now() - 60_000);
      await db.job.createMany({ data: Array.from({ length: 5 }, () => ({ type: "portal.status", leadId: lead.id, runAt: old, maxAttempts: 6 })) });
      // Queued after them, and still taken in the same run
      const other = await db.job.create({ data: { type: "teste.outro", leadId: lead.id } });
      await jobs.runDueJobs(1);
      expect(await db.job.count({ where: { type: "portal.status", status: "DONE" } })).toBe(3);
      expect((await db.job.findUniqueOrThrow({ where: { id: other.id } })).attempts).toBe(1);
    });

    it("a notice cut off in the middle goes again while it has attempts left", async () => {
      const lead = await newLead();
      const old = new Date(Date.now() - 20 * 60_000);
      const cut = await db.job.create({ data: { type: "portal.status", leadId: lead.id, status: "RUNNING", attempts: 1, maxAttempts: 6, runAt: old } });
      const spent = await db.job.create({ data: { type: "portal.status", leadId: lead.id, status: "RUNNING", attempts: 6, maxAttempts: 6, runAt: old } });
      await jobs.runDueJobs();
      expect(await db.job.findUniqueOrThrow({ where: { id: cut.id } })).toMatchObject({ status: "DONE", attempts: 2, result: "Portal atualizado: 1 indicação(ões)" });
      expect(calls).toHaveLength(1);
      expect(await db.job.findUniqueOrThrow({ where: { id: spent.id } })).toMatchObject({ status: "FAILED", lastError: "Interrompida no meio (o servidor parou)." });
      // Only the one out of attempts asks the team
      expect(await db.task.count({ where: { leadId: lead.id, title: "Automação interrompida (portal.status): verificar" } })).toBe(1);
    });

    it("keeps the notice when the deal closes, while the AI and e-mails stop", async () => {
      const lead = await newLead();
      await move(lead, st.perdido, { lostReason: "Fechou com outra corretora" });
      expect((await portalJobs(lead.id)).map((j) => j.status)).toEqual(["PENDING"]);
    });
  });

  describe("notice to the portal", () => {
    it("sends a loss with its reason", async () => {
      const lead = await newLead();
      await move(lead, st.perdido, { lostReason: "Achou caro" });
      const result = await portal.sendPortalStatus(await current(lead.id));
      expect(result).toBe("Portal atualizado: 1 indicação(ões)");
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://portal.local/api/crm/etapa");
      expect(calls[0].headers).toMatchObject({ Authorization: "Bearer teste-local", "Content-Type": "application/json" });
      expect(calls[0].body).toEqual({
        refs: ["portal:cli1"],
        lead: lead.id,
        status: "PERDIDO",
        etapa: "Perdido",
        motivo: "Achou caro",
        apolice: false,
        em: (await current(lead.id)).stageEnteredAt.toISOString(),
      });
    });

    it("sends a won quote with its policy, and an open stage without a reason", async () => {
      const lead = await newLead();
      await db.leadEvent.create({ data: { leadId: lead.id, type: "lead.form", actor: "Parceiro", summary: "x", data: { ref: "portal:cli7" } } });
      await move(lead, st.contato);
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls[0].body).toMatchObject({ refs: ["portal:cli1", "portal:cli7"], status: "EM_ATENDIMENTO", etapa: "Em contato", motivo: null, apolice: false });

      await attach(lead.id);
      await move(lead, st.ganho);
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls[1].body).toMatchObject({ status: "FECHADO", etapa: "Ganho", motivo: null, apolice: true });
    });

    it("a closed referral stays as the store saw it when the client is referred again", async () => {
      const sentRefs = async (id: string) => {
        await portal.sendPortalStatus(await current(id));
        return calls.at(-1)?.body.refs;
      };
      // Lost, then referred again: the lead starts over for the new referral only, and the old one keeps its loss
      const lost = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lost.id }, data: { phone: "5541999998888" } });
      await move(lost, st.perdido, { lostReason: "Achou caro" });
      expect((await refer("portal:cli2")).status).toBe(200);
      expect((await current(lost.id)).stageId).toBe(st.novo.id);
      expect(await sentRefs(lost.id)).toEqual(["portal:cli2"]);
      expect(calls.at(-1)?.body.status).toBe("NOVO");

      // Won, then referred again (a renewal): the sale won keeps its status when the team works the new one
      await attach(lost.id);
      await move(lost, st.ganho);
      expect((await refer("portal:cli3")).status).toBe(200);
      await move(lost, st.contato);
      expect(await sentRefs(lost.id)).toEqual(["portal:cli3"]);
      // The renewal is another sale: last year's policy does not win it
      expect(await actions.moveLeadAction(lost.id, st.ganho.id)).toMatchObject({ need: "apolice" });

      // Referred again while open: both referrals follow the lead
      expect((await refer("portal:cli4")).status).toBe(200);
      expect(await sentRefs(lost.id)).toEqual(["portal:cli3", "portal:cli4"]);
    });

    it("a closed referral stays as the store saw it when the client writes the new referral's code from her phone", async () => {
      const old = await newLead("portal:old111aaaaaa");
      await db.lead.update({ where: { id: old.id }, data: { phone: "5541999998888" } });
      await move(old, st.perdido, { lostReason: "Achou caro" });
      // The new referral came with another phone (the store's): her code joins it to the lead she writes from
      const fresh = await newLead("portal:new222bbbbbb");
      await db.lead.update({ where: { id: fresh.id }, data: { phone: "5541977776666", qualification: { parceiro: "Lotus Veículos" } } });
      await db.leadEvent.create({ data: { leadId: fresh.id, type: "lead.form", actor: "Parceiro", summary: "Indicação recebida.", data: { ref: "portal:new222bbbbbb" } } });
      await leads.handleInbound({ phone: "5541999998888", body: "Olá! Pedido BBBBBB", externalId: "wamid.join1", at: new Date() });
      expect((await current(old.id)).stageId).toBe(st.novo.id);
      await portal.sendPortalStatus(await current(old.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:new222bbbbbb"], status: "NOVO" });
    });

    it("a close still in the queue goes to the referral it closed when another referral reopens the lead", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      await move(lead, st.perdido, { lostReason: "Achou caro" });
      const lostAt = (await current(lead.id)).stageEnteredAt.toISOString();
      // The portal is down: the close waits in the queue
      reply = () => new Response("fora do ar", { status: 503 });
      await jobs.runDueJobs();
      expect((await refer("portal:cli2")).status).toBe(200);
      expect((await current(lead.id)).stageId).toBe(st.novo.id);
      // Filed with the close it found before the lead started over, so no notice of the new stage goes without it
      const filed = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "lead.form", data: { path: ["ref"], equals: "portal:cli2" } } });
      expect(filed.data).toMatchObject({ closedRefs: ["portal:cli1"], closedAt: lostAt });
      const reopened = await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "stage.changed", summary: "Perdido → Novo" } });
      expect(filed.createdAt.getTime()).toBeLessThanOrEqual(reopened.createdAt.getTime());

      reply = () => Response.json({ ok: true, atualizados: 1, ignorados: [] });
      calls.length = 0;
      await runPortalJobs();
      expect(await db.job.count({ where: { leadId: lead.id, type: "portal.status", status: { not: "DONE" } } })).toBe(0);
      const sent = calls.map((c) => c.body);
      expect(sent).toContainEqual({ refs: ["portal:cli1"], lead: lead.id, status: "PERDIDO", etapa: "Perdido", motivo: "Achou caro", apolice: false, em: lostAt });
      // The new referral only ever hears the lead's new stage
      const toNew = sent.filter((b) => (b.refs as string[]).includes("portal:cli2"));
      expect(toNew.length).toBeGreaterThan(0);
      for (const b of toNew) expect(b).toMatchObject({ refs: ["portal:cli2"], status: "NOVO" });
    });

    it("a referral reaching a lead that stays won waits for it to move, and the policy sent later goes to the sale it is for", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      // Won by a rule, without the policy
      await leads.moveLead(lead.id, st.ganho.id, "Automação", {}, { rules: false });
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Ganho" });
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli1"], status: "FECHADO", apolice: false });
      // That sale's policy arrives late: the store that won it hears of it, not the one that came after
      await attach(lead.id);
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli1"], status: "FECHADO", apolice: true });

      // The team works the new referral (a new deal, says the person): only it follows the lead, and its sale needs a
      // policy of its own
      expect(await actions.moveLeadAction(lead.id, st.contato.id)).toMatchObject({ need: "reopen" });
      expect(await actions.moveLeadAction(lead.id, st.contato.id, undefined, "new")).toEqual({});
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli2"], status: "EM_ATENDIMENTO", apolice: false });
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toMatchObject({ need: "apolice" });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli2"], status: "FECHADO", apolice: true });
    });

    it("a referral that fails halfway is received again when the store resends it, unless the lead already started over", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      await move(lead, st.perdido, { lostReason: "Achou caro" });
      const byRef = (ref: string) => db.leadEvent.count({ where: { leadId: lead.id, type: "lead.form", data: { path: ["ref"], equals: ref } } });
      // Before the lead moves: nothing stays, and the store's retry does it all
      const early = vi.spyOn(db.pipeline, "findUnique").mockRejectedValueOnce(new Error("banco fora"));
      await expect(refer("portal:cli2")).rejects.toThrow("banco fora");
      early.mockRestore();
      expect(await byRef("portal:cli2")).toBe(0);
      expect((await current(lead.id)).stageId).toBe(st.perdido.id);
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: true, task: true });
      // After the lead moved: the referral stays filed with the close it found
      await move(lead, st.perdido, { lostReason: "Sem interesse" });
      const late = vi.spyOn(db.task, "updateMany").mockRejectedValueOnce(new Error("banco fora"));
      await expect(refer("portal:cli3")).rejects.toThrow("banco fora");
      late.mockRestore();
      expect(await byRef("portal:cli3")).toBe(1);
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual(["portal:cli3"]);
    });

    it("a won deal the lead leaves for an open stage stays won for its referral, even with the Ganho still in the queue", async () => {
      const ref = "portal:won111aaaaaa";
      const lead = await newLead(ref);
      await attach(lead.id);
      await move(lead, st.ganho);
      const wonAt = (await current(lead.id)).stageEnteredAt.toISOString();
      // The portal is down: the Ganho waits in the queue
      reply = () => new Response("fora do ar", { status: 503 });
      await jobs.runDueJobs();
      // The client comes back for a new deal (a message, a form, or a person reopening it)
      await move(lead, st.contato);
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual([]);
      expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "lead.reopened" } })).toMatchObject({
        actor: "Gerente",
        summary: "Reaberto depois do Ganho: no portal, a indicação (pedido AAAAAA) continua como venda fechada.",
        data: { closedRefs: [ref], closedAt: wonAt },
      });
      reply = () => Response.json({ ok: true, atualizados: 1, ignorados: [] });
      calls.length = 0;
      await runPortalJobs();
      expect(calls.map((c) => c.body)).toEqual([{ refs: [ref], lead: lead.id, status: "FECHADO", etapa: "Ganho", motivo: null, apolice: true, em: wonAt }]);
      // The new deal says nothing to it
      await move(lead, st.perdido, { lostReason: "Achou caro" });
      expect(await db.job.count({ where: { leadId: lead.id, type: "portal.status", status: "PENDING" } })).toBe(0);

      // A sale cancelled (Ganho → Perdido) is still the store's news, and so is a client back from a loss
      const other = await newLead("portal:won222bbbbbb");
      await attach(other.id);
      await move(other, st.ganho);
      await move(other, st.perdido, { lostReason: "Cliente cancelou a apólice" });
      await portal.sendPortalStatus(await current(other.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:won222bbbbbb"], status: "PERDIDO", motivo: "Cliente cancelou a apólice" });
      await move(other, st.contato);
      expect(await portal.leadPortalRefs(await current(other.id))).toEqual(["portal:won222bbbbbb"]);
    });

    it("a person taking a won sale back to an open stage says it is a new deal: the store keeps the sale, the next Ganho needs a policy of its own", async () => {
      const lead = await newLead("portal:won111aaaaaa");
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      const wonAt = (await current(lead.id)).stageEnteredAt.toISOString();
      // Asked first, and nothing moves until the person answers
      expect(await actions.moveLeadAction(lead.id, st.contato.id)).toEqual({ need: "reopen", error: "Diga se a venda foi desfeita ou se é um novo atendimento." });
      expect((await current(lead.id)).stageId).toBe(st.ganho.id);
      expect(await actions.moveLeadAction(lead.id, st.contato.id, undefined, "new")).toEqual({});
      expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "stage.changed" }, orderBy: { createdAt: "desc" } })).toMatchObject({
        actor: "Wellington",
        summary: "Ganho → Em contato: novo atendimento",
      });
      expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "lead.reopened" } })).toMatchObject({ data: { closedRefs: ["portal:won111aaaaaa"], closedAt: wonAt } });
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual([]);
      calls.length = 0;
      await runPortalJobs();
      for (const b of calls.map((c) => c.body)) expect(b).toMatchObject({ status: "FECHADO", etapa: "Ganho", em: wonAt });
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toMatchObject({ need: "apolice" });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      // Nobody follows the new deal, so leaving its Ganho asks nothing
      expect(await actions.moveLeadAction(lead.id, st.contato.id)).toEqual({});
    });

    it("a person taking a won sale back to an open stage says it was undone: the store follows the lead again, and its policy still counts", async () => {
      const lead = await newLead("portal:won111aaaaaa");
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      expect(await actions.moveLeadAction(lead.id, st.proposta.id)).toMatchObject({ need: "reopen" });
      expect(await actions.moveLeadAction(lead.id, st.proposta.id, undefined, "undone")).toEqual({});
      expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "stage.changed" }, orderBy: { createdAt: "desc" } })).toMatchObject({
        actor: "Wellington",
        summary: "Ganho → Proposta enviada: a venda foi desfeita",
      });
      // Nothing closed: the store hears the open stage
      expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "lead.reopened" } })).toBe(0);
      calls.length = 0;
      await runPortalJobs();
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:won111aaaaaa"], status: "PROPOSTA", etapa: "Proposta enviada", motivo: null });
      // The policy attached before still wins the sale
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:won111aaaaaa"], status: "FECHADO", apolice: true });
      // Undone again, then lost: the store reads the reason
      expect(await actions.moveLeadAction(lead.id, st.proposta.id, undefined, "undone")).toEqual({});
      expect(await actions.moveLeadAction(lead.id, st.perdido.id, "Desistiu da compra")).toEqual({});
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:won111aaaaaa"], status: "PERDIDO", motivo: "Desistiu da compra" });
    });

    it("a sale undone takes along the referral that found it won, as if it had reached an open lead", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Ganho" });
      expect(await actions.moveLeadAction(lead.id, st.contato.id, undefined, "undone")).toEqual({});
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual(["portal:cli1", "portal:cli2"]);
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli1", "portal:cli2"], status: "EM_ATENDIMENTO" });
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
    });

    it("automatic moves out of a won sale keep the store's sale, asking nobody", async () => {
      const lead = await newLead("portal:won111aaaaaa");
      await attach(lead.id);
      await move(lead, st.ganho);
      await move(lead, st.contato);
      expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "stage.changed" }, orderBy: { createdAt: "desc" } })).toMatchObject({ summary: "Ganho → Em contato" });
      expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "lead.reopened" } })).toBe(1);
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual([]);
    });

    describe("another funnel", () => {
      let aberto: Stage;
      let ganhoProdutos: Stage;
      beforeEach(async () => {
        const produtos = await db.pipeline.create({ data: { name: "Produtos", slug: "produtos" } });
        aberto = await db.stage.create({ data: { pipelineId: produtos.id, name: "Em negociação", position: 0 } });
        ganhoProdutos = await db.stage.create({ data: { pipelineId: produtos.id, name: "Ganho", position: 1, kind: "WON" } });
      });
      // A store's referral to Cotações
      const referred = (externalId: string, stageId = st.novo.id) =>
        db.lead.create({
          data: { name: "Maria Souza", source: "Parceiro Lotus", externalId, pipelineId: cotacoes.id, stageId, qualification: { parceiro: "Lotus Veículos", [REFERRAL_FUNNEL]: cotacoes.id } },
        });

      it("a Ganho in another funnel closes nothing: back in Cotações the store follows, and its own Ganho reaches it", async () => {
        const ref = "portal:loja11aaaaaa";
        const lead = await referred(ref, st.contato.id);
        await move(lead, aberto);
        await move(lead, ganhoProdutos);
        await move(lead, st.contato);
        expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "lead.reopened" } })).toBe(0);
        expect(await portal.leadPortalRefs(await current(lead.id))).toEqual([ref]);
        await attach(lead.id);
        expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
        const wonAt = (await current(lead.id)).stageEnteredAt.toISOString();
        calls.length = 0;
        await runPortalJobs();
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c.body).toEqual({ refs: [ref], lead: lead.id, status: "FECHADO", etapa: "Ganho", motivo: null, apolice: true, em: wonAt });
      });

      it("a won sale taken to an open stage of another funnel asks nothing: the store keeps the sale", async () => {
        const ref = "portal:won111aaaaaa";
        const lead = await referred(ref);
        await attach(lead.id);
        expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
        const wonAt = (await current(lead.id)).stageEnteredAt.toISOString();
        expect(await actions.moveLeadAction(lead.id, aberto.id)).toEqual({});
        expect(await current(lead.id)).toMatchObject({ stageId: aberto.id });
        expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "stage.changed" }, orderBy: { createdAt: "desc" } })).toMatchObject({
          summary: "Ganho → Em negociação (outro funil)",
        });
        expect(await db.leadEvent.findFirstOrThrow({ where: { leadId: lead.id, type: "lead.reopened" } })).toMatchObject({ data: { closedRefs: [ref], closedAt: wonAt } });
        calls.length = 0;
        await runPortalJobs();
        expect(calls.map((c) => c.body)).toEqual([{ refs: [ref], lead: lead.id, status: "FECHADO", etapa: "Ganho", motivo: null, apolice: true, em: wonAt }]);
        // Back in Cotações the sale stays closed for the store
        expect(await actions.moveLeadAction(lead.id, st.contato.id)).toEqual({});
        expect(await portal.leadPortalRefs(await current(lead.id))).toEqual([]);

        // An answer sent along anyway is not taken: still a new deal
        const other = await referred("portal:won222bbbbbb");
        await attach(other.id);
        expect(await actions.moveLeadAction(other.id, st.ganho.id)).toEqual({});
        expect(await actions.moveLeadAction(other.id, aberto.id, undefined, "undone")).toEqual({});
        expect(await db.leadEvent.count({ where: { leadId: other.id, type: "lead.reopened" } })).toBe(1);
        expect(await portal.leadPortalRefs(await current(other.id))).toEqual([]);
      });
    });

    it("out of a loss a referral found, a Ganho needs a policy from after it arrived", async () => {
      const lead = await newLead("portal:cli1");
      // She asked for no more messages: a referral does not reopen her, and waits
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888", whatsappOptOut: true } });
      await attach(lead.id);
      await move(lead, st.ganho);
      await move(lead, st.perdido, { lostReason: "Cliente cancelou a apólice" });
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Perdido" });
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toMatchObject({ need: "apolice" });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
    });

    it("out of a loss a referral found, the Ganho is that referral's sale: the store that lost keeps its loss", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888", whatsappOptOut: true } });
      await move(lead, st.perdido, { lostReason: "Achou caro" });
      const lostAt = (await current(lead.id)).stageEnteredAt.toISOString();
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Perdido" });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      expect(await portal.leadPortalRefs(await current(lead.id))).toEqual(["portal:cli2"]);
      calls.length = 0;
      await runPortalJobs();
      const sent = calls.map((c) => c.body);
      // Store A only ever hears its loss, as it was; store B the sale, with the policy attached after it arrived
      for (const b of sent.filter((b) => (b.refs as string[]).includes("portal:cli1"))) {
        expect(b).toEqual({ refs: ["portal:cli1"], lead: lead.id, status: "PERDIDO", etapa: "Perdido", motivo: "Achou caro", apolice: false, em: lostAt });
      }
      const won = sent.filter((b) => b.status === "FECHADO");
      expect(won.length).toBeGreaterThan(0);
      for (const b of won) expect(b).toMatchObject({ refs: ["portal:cli2"], apolice: true });
    });

    it("the late policy of a sale a referral found won does not win that referral's sale out of the loss that followed", async () => {
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      // Won by a rule, store B refers her while it is won, then that sale's policy arrives
      await leads.moveLead(lead.id, st.ganho.id, "Automação", {}, { rules: false });
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Ganho" });
      await attach(lead.id);
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli1"], status: "FECHADO", apolice: true });
      // Cancelled, then won again by hand: store B's sale, which needs its own
      expect(await actions.moveLeadAction(lead.id, st.perdido.id, "Cliente cancelou a apólice")).toEqual({});
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toMatchObject({ need: "apolice" });
      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body).toMatchObject({ refs: ["portal:cli2"], status: "FECHADO", apolice: true });
    });

    it("a referral that reached a closed lead waits through moves between closed stages, and follows once it is open", async () => {
      const pago = await db.stage.create({ data: { pipelineId: cotacoes.id, name: "Apólice paga", position: 6, kind: "WON" } });
      const arquivo = await db.stage.create({ data: { pipelineId: cotacoes.id, name: "Arquivados", position: 7, kind: "LOST" } });
      const lead = await newLead("portal:cli1");
      await db.lead.update({ where: { id: lead.id }, data: { phone: "5541999998888" } });
      await attach(lead.id);
      await move(lead, st.ganho);
      // Store B refers her while the sale is won: the lead stays won and the referral waits
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ moved: false, stage: "Ganho" });
      const sentTo = async () => {
        await portal.sendPortalStatus(await current(lead.id));
        return calls.at(-1)?.body;
      };
      await move(lead, pago);
      expect(await sentTo()).toMatchObject({ refs: ["portal:cli1"], status: "FECHADO" });
      // The sale is cancelled: store A hears it with the reason, store B nothing of a deal that is not hers
      await move(lead, st.perdido, { lostReason: "Cliente cancelou a apólice" });
      expect(await sentTo()).toMatchObject({ refs: ["portal:cli1"], status: "PERDIDO", motivo: "Cliente cancelou a apólice" });
      await move(lead, arquivo);
      expect(await sentTo()).toMatchObject({ refs: ["portal:cli1"], status: "PERDIDO" });
      // Open again: store B follows, store A keeps the loss
      await move(lead, st.contato);
      expect(await sentTo()).toMatchObject({ refs: ["portal:cli2"], status: "EM_ATENDIMENTO" });
    });

    it("a lead the store's new referral took the phone from does not answer for it", async () => {
      // A contact that never wrote, lost, with the phone the store typed for another client
      const old = await db.lead.create({
        data: { name: "João Lima", phone: "5541999998888", source: "site", pipelineId: cotacoes.id, stageId: st.perdido.id, lostReason: "Sem interesse" },
      });
      const made = (await (await refer("portal:cli2")).json()) as { id: string; created: boolean };
      expect(made.created).toBe(true);
      expect(await current(old.id)).toMatchObject({ phone: null, externalId: null });
      expect(await portal.leadPortalRefs(await current(made.id))).toEqual(["portal:cli2"]);
      await move(old, st.contato);
      expect(await portalJobs(old.id)).toHaveLength(0);
      // The store's retry finds the referral's own lead
      expect(await (await refer("portal:cli2")).json()).toMatchObject({ id: made.id, repeated: true });
    });

    it("a referral that fails before the lead moves takes back the ref it gave a contact without one", async () => {
      const known = await db.lead.create({ data: { name: "Maria Souza", phone: "5541999998888", source: "site", pipelineId: cotacoes.id, stageId: st.contato.id } });
      const fail = vi.spyOn(db.task, "updateMany").mockRejectedValueOnce(new Error("banco fora"));
      await expect(refer("portal:cli2")).rejects.toThrow("banco fora");
      fail.mockRestore();
      expect((await current(known.id)).externalId).toBeNull();
      // The store's retry is worked, not answered as a repeat
      const again = (await (await refer("portal:cli2")).json()) as Record<string, unknown>;
      expect(again).toMatchObject({ id: known.id, task: true });
      expect(again.repeated).toBeUndefined();
      expect((await current(known.id)).externalId).toBe("portal:cli2");
    });

    it("the store reads a neutral reason for a loss nobody explained or a WhatsApp that never arrived", async () => {
      const lead = await newLead();
      await leads.moveLead(lead.id, st.perdido.id, "Wellington", {}, { rules: false });
      expect((await current(lead.id)).lostReason).toBe("Encerrado sem motivo informado (Wellington)");
      await portal.sendPortalStatus(await current(lead.id));
      expect(calls.at(-1)?.body.motivo).toBe("Encerrado sem motivo informado");

      const unreached = await newLead("portal:cli8");
      await move(unreached, st.erro, { lostReason: "WhatsApp não chega neste contato: (#131026) Message undeliverable" });
      // A rule closes it after some days: the reason stays, and the store reads it in plain words
      await jobs.runAction(await current(unreached.id), "move", { toStageId: st.perdido.id }, "sem resposta em Erro no WhatsApp");
      expect((await current(unreached.id)).lostReason).toMatch(/^WhatsApp não chega neste contato/);
      await portal.sendPortalStatus(await current(unreached.id));
      expect(calls.at(-1)?.body).toMatchObject({ status: "PERDIDO", motivo: "Não conseguimos falar com o cliente pelo WhatsApp" });
    });

    it("the AI's discard says its own sentence, never the manager's summary", () => {
      expect(jobs.discardReason({ reason: "  Não tem carro  " })).toBe("Descartado pela IA: Não tem carro");
      const decision = { reason: "", summary: "Disse que ganha R$ 3 mil e está endividado" };
      expect(jobs.discardReason(decision)).toBe("Descartado pela IA");
    });

    it("says nothing about Erro no WhatsApp", async () => {
      const lead = await newLead();
      await move(lead, st.erro, { lostReason: "WhatsApp não chega neste contato" });
      expect(await portal.sendPortalStatus(await current(lead.id))).toBe("Nada a enviar ao portal");
      expect(calls).toHaveLength(0);
    });

    it("fails on 401 or 500, so the queue tries again", async () => {
      const lead = await current((await newLead()).id);
      reply = () => new Response("Token inválido.", { status: 401 });
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow("Portal respondeu 401: Token inválido.");
      reply = () => new Response("boom", { status: 500 });
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow(/^Portal respondeu 500/);
    });

    it("says in Portuguese when the portal cannot be reached, and takes only the portal's own confirmation", async () => {
      const lead = await current((await newLead()).id);
      reply = () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      };
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow("Portal fora do ar ou inacessível (ECONNREFUSED).");
      reply = () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      };
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow("Portal sem resposta em 10 s.");
      // Another site answering 200, or a redirect (never followed), is not a delivered notice
      reply = () => new Response("<!DOCTYPE html><html></html>", { status: 200 });
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow(/^Portal respondeu 200 sem confirmar o aviso/);
      reply = () => new Response(null, { status: 308, headers: { location: "https://outro.local/api/crm/etapa" } });
      await expect(portal.sendPortalStatus(lead)).rejects.toThrow("Portal respondeu 308 (redireciona para https://outro.local/api/crm/etapa): ");
      expect(calls.at(-1)?.redirect).toBe("manual");
    });

    it("runs from the queue: retried on failure, done on success", async () => {
      const lead = await newLead();
      await move(lead, st.contato);
      reply = () => new Response("fora do ar", { status: 503 });
      await jobs.runDueJobs();
      const [failed] = await portalJobs(lead.id);
      expect(failed).toMatchObject({ status: "PENDING", attempts: 1, lastError: "Portal respondeu 503: fora do ar" });
      expect(failed.runAt.getTime()).toBeGreaterThan(Date.now());

      reply = () => Response.json({ ok: true, atualizados: 1, ignorados: [] });
      await db.job.update({ where: { id: failed.id }, data: { runAt: new Date() } });
      await jobs.runDueJobs();
      expect((await portalJobs(lead.id))[0]).toMatchObject({ status: "DONE", result: "Portal atualizado: 1 indicação(ões)" });
      expect(calls.at(-1)?.body).toMatchObject({ status: "EM_ATENDIMENTO" });
    });
  });

  describe("policy upload", () => {
    const post = (leadId: string, query: string, body?: BodyInit) =>
      docsRoute.POST(new Request(`http://crm.local/api/leads/${leadId}/documentos?${query}`, { method: "POST", body }), { params: Promise.resolve({ id: leadId }) });
    const start = (leadId: string, file: { name: string; mimeType: string; size: number }) => post(leadId, "step=start", JSON.stringify(file));

    it("keeps the pieces, the size and the fingerprint, and the team can download it", async () => {
      const lead = await newLead();
      const bytes = Buffer.from("%PDF-1.4 apólice 123 da Maria Souza");
      const res = await start(lead.id, { name: "apolice.pdf", mimeType: "application/pdf", size: bytes.length });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      expect((await post(lead.id, `step=chunk&id=${id}`, new Uint8Array(bytes.subarray(0, 10)))).status).toBe(200);
      expect((await post(lead.id, `step=chunk&id=${id}`, new Uint8Array(bytes.subarray(10)))).status).toBe(200);
      const done = await post(lead.id, `step=finish&id=${id}`);
      expect(await done.json()).toMatchObject({ id, name: "apolice.pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      const saved = await db.leadDocument.findUniqueOrThrow({ where: { id } });
      expect(Buffer.from(saved.data).equals(bytes)).toBe(true);
      expect(saved).toMatchObject({ kind: "APOLICE", uploadedBy: "Wellington", mimeType: "application/pdf" });
      expect(await db.leadEvent.findFirst({ where: { leadId: lead.id, type: "lead.document" } })).toMatchObject({ actor: "Wellington", summary: "Documento da venda anexado: apolice.pdf" });
      // Finished: no more pieces
      expect((await post(lead.id, `step=chunk&id=${id}`, new Uint8Array([1]))).status).toBe(404);

      const file = await docRoute.GET(new Request("http://crm.local"), { params: Promise.resolve({ id: lead.id, docId: id }) });
      expect(file.headers.get("Content-Type")).toBe("application/pdf");
      expect(file.headers.get("Content-Disposition")).toContain("attachment");
      expect(file.headers.get("Cache-Control")).toBe("private, no-store");
      expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
      // Another lead's address does not open it
      const other = await newLead(null);
      expect((await docRoute.GET(new Request("http://crm.local"), { params: Promise.resolve({ id: other.id, docId: id }) })).status).toBe(404);

      session.user = null;
      expect((await docRoute.GET(new Request("http://crm.local"), { params: Promise.resolve({ id: lead.id, docId: id }) })).status).toBe(401);
      expect((await start(lead.id, { name: "apolice.pdf", mimeType: "application/pdf", size: 10 })).status).toBe(401);
    });

    it("refuses other types, files over 20 MB and a file that is not what it says", async () => {
      const lead = await newLead();
      const word = await start(lead.id, { name: "apolice.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100 });
      expect(word.status).toBe(400);
      expect(await word.json()).toEqual({ error: "Envie a apólice ou o contrato em PDF, JPG ou PNG." });
      const big = await start(lead.id, { name: "apolice.pdf", mimeType: "application/pdf", size: 20 * 1024 * 1024 + 1 });
      expect(big.status).toBe(400);
      expect(await big.json()).toEqual({ error: "Arquivo maior que 20 MB." });
      // A size that lied at the start is still stopped by the pieces
      const { id } = (await (await start(lead.id, { name: "foto.png", mimeType: "image/png", size: 10 })).json()) as { id: string };
      expect((await post(lead.id, `step=chunk&id=${id}`, new Uint8Array(20 * 1024 * 1024 + 1))).status).toBe(400);
      // A text renamed to .pdf
      const fake = (await (await start(lead.id, { name: "apolice.pdf", mimeType: "", size: 5 })).json()) as { id: string };
      await post(lead.id, `step=chunk&id=${fake.id}`, new Uint8Array(Buffer.from("hello")));
      expect((await post(lead.id, `step=finish&id=${fake.id}`)).status).toBe(400);
      expect(await db.leadDocument.count({ where: { id: fake.id } })).toBe(0);
      expect((await start("nao-existe", { name: "a.pdf", mimeType: "application/pdf", size: 5 })).status).toBe(404);
    });

    it("an upload given up on long ago is cleaned whatever lead the next upload is for", async () => {
      const other = await newLead(null);
      const stale = await db.leadDocument.create({
        data: { leadId: other.id, name: "x.pdf", mimeType: "application/pdf", size: 10, data: new Uint8Array(0), uploadedBy: "W", createdAt: new Date(Date.now() - 2 * 86_400_000) },
      });
      const lead = await newLead();
      expect((await start(lead.id, { name: "apolice.pdf", mimeType: "application/pdf", size: 10 })).status).toBe(200);
      expect(await db.leadDocument.count({ where: { id: stale.id } })).toBe(0);
    });

    it("a policy attached to a lead already won goes to the portal", async () => {
      const lead = await newLead();
      await leads.moveLead(lead.id, st.ganho.id, "Automação", {}, { rules: false });
      expect(await portalJobs(lead.id)).toHaveLength(1);
      const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      const { id } = (await (await start(lead.id, { name: "apolice.jpg", mimeType: "image/jpeg", size: bytes.length })).json()) as { id: string };
      await post(lead.id, `step=chunk&id=${id}`, new Uint8Array(bytes));
      expect((await post(lead.id, `step=finish&id=${id}`)).status).toBe(200);
      expect(await portalJobs(lead.id)).toHaveLength(2);
    });
  });

  describe("moving by hand", () => {
    it("asks for the reason of a loss and the policy of a won quote before moving", async () => {
      const lead = await newLead();
      expect(await actions.moveLeadAction(lead.id, st.perdido.id)).toEqual({ need: "reason", error: "Informe o motivo da perda." });
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({ need: "apolice", error: "Anexe a apólice (no consórcio, o contrato) antes de marcar como Ganho." });
      expect((await current(lead.id)).stageId).toBe(st.novo.id);

      expect(await actions.moveLeadAction(lead.id, st.perdido.id, "  Fechou com outra corretora ")).toEqual({});
      expect(await current(lead.id)).toMatchObject({ stageId: st.perdido.id, status: "LOST", lostReason: "Fechou com outra corretora", aiPaused: true });

      await attach(lead.id);
      expect(await actions.moveLeadAction(lead.id, st.ganho.id)).toEqual({});
      expect(await current(lead.id)).toMatchObject({ stageId: st.ganho.id, status: "WON", lostReason: null });
    });

    it("only a won quote looks for its policy", async () => {
      const franquias = await db.pipeline.create({ data: { name: "Vendas de Franquias" } });
      const aberto = await db.stage.create({ data: { pipelineId: franquias.id, name: "Em negociação", position: 0 } });
      const ganho = await db.stage.create({ data: { pipelineId: franquias.id, name: "Ganho", position: 1, kind: "WON" } });
      const lead = await db.lead.create({ data: { name: "Ana", source: "site", pipelineId: franquias.id, stageId: aberto.id } });
      const count = vi.spyOn(db.leadDocument, "count");
      expect(await actions.moveLeadAction(lead.id, ganho.id)).toEqual({});
      expect(count).not.toHaveBeenCalled();
      count.mockRestore();
    });

    it("a stale screen moving a lead to the stage it is already in reloads instead of asking", async () => {
      const { revalidatePath } = await import("next/cache");
      const lead = await newLead("portal:cli1", { stageId: st.perdido.id });
      vi.mocked(revalidatePath).mockClear();
      expect(await actions.moveLeadAction(lead.id, st.perdido.id)).toEqual({});
      expect(vi.mocked(revalidatePath).mock.calls.map(([path]) => path)).toEqual(["/funil", `/leads/${lead.id}`]);
    });

    it("the Perdido card refuses an empty reason with a message", async () => {
      const lead = await newLead();
      const form = new FormData();
      form.set("reason", "  ");
      expect(await actions.markLostAction(lead.id, null, form)).toEqual({ error: "Informe o motivo da perda." });
      form.set("reason", "Sem interesse");
      expect(await actions.markLostAction(lead.id, null, form)).toEqual({});
      expect(await current(lead.id)).toMatchObject({ stageId: st.perdido.id, lostReason: "Sem interesse" });
    });
  });
});
