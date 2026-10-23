// The COF by e-mail: documents uploaded in pieces, the e-mail kept byte for byte, and the lead's opening,
// download and confirmation of receipt. SMTP is stubbed. Runs only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const rawSent = vi.hoisted(() => [] as { to: string; raw: Buffer }[]);
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendRawEmail: vi.fn(async (to: string, raw: Buffer) => {
    rawSent.push({ to, raw });
    return "250 2.0.0 Ok: queued as ABC123";
  }),
}));

// The AI's answer, set by each test
const nextDecision = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/sdr", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdr")>()),
  runSdrTurn: vi.fn(async () => nextDecision.value),
}));

describe.skipIf(!dbUrl)("COF", () => {
  let db: typeof import("@/lib/db").db;
  let leads: typeof import("@/lib/leads");
  let cof: typeof import("@/lib/cof");
  let jobs: typeof import("@/lib/jobs");

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    leads = await import("@/lib/leads");
    cof = await import("@/lib/cof");
    jobs = await import("@/lib/jobs");
  });

  beforeEach(async () => {
    rawSent.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","User","EmailTemplate","Setting","FranchiseDocument","CofDelivery" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
  });

  const upload = async (name: string, content: string | Uint8Array, pieces = 2) => {
    const doc = await db.franchiseDocument.create({ data: { name, mimeType: "application/pdf", size: content.length, data: new Uint8Array(0), uploadedBy: "W" } });
    const bytes = Buffer.from(content);
    const step = Math.ceil(bytes.length / pieces);
    for (let at = 0; at < bytes.length; at += step) expect(await cof.appendDocumentChunk(doc.id, new Uint8Array(bytes.subarray(at, at + step)))).toBe(true);
    return (await cof.finishDocument(doc.id))!;
  };

  it("sends the documents, keeps the e-mail and records the lead's receipt", async () => {
    const { lead } = await leads.createLead({ name: "Rafa Lima", phone: "11955550000", email: "rafa@x.com", source: "site" }, "teste");

    // Nothing uploaded yet: a task instead of an empty COF
    expect(await cof.sendCof(lead, "Wellington")).toMatch(/nenhum documento/);
    expect(await db.task.count({ where: { leadId: lead.id, title: { contains: "Subir a COF" } } })).toBe(1);

    const circular = await upload("COF Banneg.pdf", "%PDF-1.4 circular de oferta");
    await upload("Contrato.pdf", "%PDF-1.4 contrato", 3);
    expect(circular).toMatchObject({ size: 27, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Buffer.from((await db.franchiseDocument.findUniqueOrThrow({ where: { id: circular.id } })).data).toString()).toBe("%PDF-1.4 circular de oferta");

    expect(await cof.sendCof(lead, "Wellington")).toBe("COF enviada para rafa@x.com.");
    const d = await db.cofDelivery.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(d).toMatchObject({ to: "rafa@x.com", attached: true, sentBy: "Wellington", smtpResponse: expect.stringContaining("250") });
    expect(d.subject).toMatch(/^COF - Circular de Oferta de Franquia/);
    // The copy is exactly what went to the server, with both files attached and the receipt link
    const raw = Buffer.from(d.raw!).toString();
    expect(Buffer.from(rawSent[0].raw).toString()).toBe(raw);
    expect(raw).toContain("COF Banneg.pdf");
    expect(raw).toContain("Contrato.pdf");
    expect(d.body).toContain(`/cof/${d.token}`);
    expect(d.body).toContain("Olá, Rafa!");
    expect(await db.message.count({ where: { leadId: lead.id, channel: "EMAIL", direction: "OUT" } })).toBe(1);

    // An automation firing again does not resend the same files; the team's button does
    const fresh = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(await jobs.runAction(fresh, "cof", {})).toMatch(/já foi enviada/);
    expect(rawSent).toHaveLength(1);

    // Opened, downloaded (only this COF's files), confirmed once with IP and device
    await cof.markCofOpened(d.token, "email");
    expect((await db.cofDelivery.findUniqueOrThrow({ where: { id: d.id } })).openedAt).toBeTruthy();
    expect(await cof.downloadCofDocument(d.token, "outro")).toBeNull();
    const file = await cof.downloadCofDocument(d.token, circular.id);
    expect(Buffer.from(file!.data).toString()).toBe("%PDF-1.4 circular de oferta");
    const confirmed = await cof.confirmCof(d.token, "200.1.2.3", "Mozilla/5.0");
    expect(confirmed).toMatchObject({ confirmIp: "200.1.2.3", confirmAgent: "Mozilla/5.0" });
    const again = await cof.confirmCof(d.token, "9.9.9.9", "x");
    expect(again?.confirmedAt).toEqual(confirmed?.confirmedAt);
    expect(again?.confirmIp).toBe("200.1.2.3");
    expect(cof.cofDeadline(confirmed!).getTime() - confirmed!.confirmedAt!.getTime()).toBe(10 * 86_400_000);
    const events = (await db.leadEvent.findMany({ where: { leadId: lead.id, type: { startsWith: "cof." } } })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["cof.sent", "cof.opened", "cof.downloaded", "cof.confirmed"]));

    // A new version of the documents goes again with the automation
    await upload("Balanço 2025.pdf", "%PDF-1.4 balanco");
    expect(await jobs.runAction(fresh, "cof", {})).toBe("COF enviada para rafa@x.com.");
  });

  it("goes by e-mail when the lead asks the AI for it before the meeting, once for the same files", async () => {
    const { queue } = { queue: await import("@/lib/queue") };
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
    const { lead } = await leads.createLead({ name: "Rafa Lima", phone: "11955550000", email: "rafa@x.com", source: "site" }, "teste");
    await upload("COF Banneg.pdf", "%PDF-1.4 circular de oferta");
    const asked = {
      reply: "",
      extracted: { name: null, email: null, city: null, state: null, capital: null, timeline: null, experience: null, decisionMaker: null },
      score: 60,
      temperature: "morno",
      decision: "continue",
      slotIndex: null,
      handoffTo: null,
      sendCof: true,
      reason: "pediu a COF",
      summary: "Rafa pediu a COF antes da reunião.",
    };
    const turn = async () => {
      await queue.enqueue("sdr.reply", { leadId: lead.id });
      await jobs.runDueJobs();
    };
    nextDecision.value = asked;
    await turn();
    const d = await db.cofDelivery.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(d).toMatchObject({ to: "rafa@x.com", sentBy: "Duda" });
    expect(await db.leadEvent.count({ where: { leadId: lead.id, type: "cof.requested" } })).toBe(1);
    // Asking again does not send the same files twice
    await turn();
    expect(rawSent).toHaveLength(1);
    // The AI only gets the rule when there is a COF to send
    const { buildSystemPrompt } = await import("@/lib/sdr");
    const { DEFAULT_SETTINGS } = await import("@/lib/settings");
    const base = { agentName: "Duda", persona: "x", settings: DEFAULT_SETTINGS, knowledge: [] };
    expect(buildSystemPrompt({ ...base, cofReady: true })).toContain("marque sendCof = true");
    expect(buildSystemPrompt(base)).not.toContain("sendCof");
  });

  // The text a PDF draws (pdf-lib writes it in hex, WinAnsi)
  const pdfTexts = async (pdf: Uint8Array) =>
    (await PDFDocument.load(pdf)).context
      .enumerateIndirectObjects()
      .flatMap(([, o]) => (o instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(o).decode()).toString("latin1").split("\n") : []))
      .flatMap((line) => line.match(/^<([0-9A-F]+)> Tj$/i)?.slice(1) ?? [])
      .map((hex) => Buffer.from(hex, "hex").toString("latin1"));
  const attachment = (raw: string, name: string) => {
    const part = raw.split(/\r?\n--/).find((p) => p.includes(`filename="${name}"`))!;
    return new Uint8Array(Buffer.from(part.split(/\r?\n\r?\n/)[1], "base64"));
  };

  it("writes the candidate, the e-mail it went to and the sending date in each COF, and asks for the name first", async () => {
    const tpl = await PDFDocument.create();
    const page = tpl.addPage();
    Object.values(cof.COF_FIELDS).forEach((field, i) => tpl.getForm().createTextField(field).addToPage(page, { x: 50, y: 700 - i * 20, width: 300, height: 14 }));
    const circular = await upload("COF Banneg.pdf", await tpl.save());
    const contract = await upload("Contrato.pdf", "%PDF-1.4 contrato");

    // Without a name the COF does not go with a blank candidate: someone asks first
    const { lead: unnamed } = await leads.createLead({ phone: "11955552222", email: "semnome@x.com", source: "site" }, "teste");
    expect(await cof.sendCof(unnamed, "Automação")).toMatch(/sem nome/);
    expect(await db.task.count({ where: { leadId: unnamed.id, title: { contains: "nome do lead" } } })).toBe(1);
    expect(rawSent).toHaveLength(0);

    const { lead } = await leads.createLead({ name: "Rafaela Conceição Lima", phone: "11955550000", email: "rafa@x.com", source: "site" }, "teste");
    const today = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    expect(await cof.sendCof(lead, "Wellington")).toBe("COF enviada para rafa@x.com.");
    const d = await db.cofDelivery.findFirstOrThrow({ where: { leadId: lead.id } });
    const fill = { candidato: "Rafaela Conceição Lima", email: "rafa@x.com", data: today };
    expect(d.documents).toEqual([expect.objectContaining({ id: circular.id, fill }), expect.objectContaining({ id: contract.id, fill })]);

    // The attachment and the download carry her name, e-mail and date, locked (no field left to edit)
    const sent = attachment(Buffer.from(d.raw!).toString(), "COF Banneg.pdf");
    const downloaded = (await cof.downloadCofDocument(d.token, circular.id))!.data;
    for (const pdf of [sent, downloaded]) {
      expect(await pdfTexts(pdf)).toEqual(expect.arrayContaining([today, "Rafaela Conceição Lima", "rafa@x.com"]));
      expect((await PDFDocument.load(pdf)).getForm().getFields()).toHaveLength(0);
    }
    // The template in Ajustes stays blank, and a PDF without the fields goes as it is
    const stored = await db.franchiseDocument.findUniqueOrThrow({ where: { id: circular.id } });
    expect((await PDFDocument.load(stored.data)).getForm().getFields()).toHaveLength(3);
    expect(Buffer.from((await cof.downloadCofDocument(d.token, contract.id))!.data).toString()).toBe("%PDF-1.4 contrato");
  });

  it("asks for the e-mail and respects the lead who asked for no e-mails", async () => {
    await upload("COF.pdf", "%PDF");
    const { lead } = await leads.createLead({ name: "Sem Email", phone: "11955551111", source: "site" }, "teste");
    expect(await cof.sendCof(lead, "Automação")).toMatch(/sem e-mail/);
    expect(await db.task.count({ where: { leadId: lead.id, title: { contains: "e-mail do lead" } } })).toBe(1);
    const optedOut = await db.lead.update({ where: { id: lead.id }, data: { email: "a@x.com", emailOptOut: true } });
    expect(await cof.sendCof(optedOut, "Automação")).toMatch(/não receber e-mails/);
    expect(rawSent).toHaveLength(0);
  });
});
