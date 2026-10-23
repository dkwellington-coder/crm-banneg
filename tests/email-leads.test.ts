// E-mails sent to the leads box (leads@banneg.com.br) become leads in the chosen funnel.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
delete process.env.LEADS_IMAP_USER;
process.env.SMTP_FROM = "Expansão Banneg <expansao@banneg.com.br>";

// Loaded after DATABASE_URL is set, since the module opens the database
const { readLeadEmail, formFields, findPhone } = await import("@/lib/email-leads");
const { installDefaultPipeline } = await import("@/lib/pipeline-defaults");

const BOX = "leads@banneg.com.br";
const OWN_PHONE = "5517996790187";
const opts = { mailbox: BOX, ownPhones: [OWN_PHONE], ownDomains: ["banneg.com.br"] };

function eml(headers: Record<string, string>, body: string, type = "text/plain") {
  const all = { "Message-ID": `<${Math.random().toString(36).slice(2)}@mail.test>`, Date: "Wed, 22 Oct 2026 18:00:00 -0300", To: BOX, "Content-Type": `${type}; charset=utf-8`, ...headers };
  return Buffer.from(`${Object.entries(all).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`);
}
const read = async (raw: Buffer) => readLeadEmail(await simpleParser(raw), opts);

describe("reading an e-mail", () => {
  it("a person writing: the sender is the lead, the phone comes from the text and the AI gets the e-mail", async () => {
    const r = await read(
      eml({ From: "Maria Silva <Maria.Silva@gmail.com>", Subject: "Franquia" }, "Olá, quero saber da franquia.\nMeu WhatsApp é (17) 99123-4567.\nObrigada!"),
    );
    expect(r.skip).toBeUndefined();
    if (r.skip !== undefined) return;
    expect(r.lead).toMatchObject({ name: "Maria Silva", email: "maria.silva@gmail.com", phone: "5517991234567" });
    expect(r.lead.qualification).toEqual({ "Assunto do e-mail": "Franquia", "E-mail do lead": expect.stringContaining("quero saber da franquia") });
    expect(r.quote).toBe(false);
  });

  it("a site form sent by the site: the contact comes from the answers, the rest goes to the AI", async () => {
    const r = await read(
      eml(
        { From: "Site Banneg <wordpress@banneg.com.br>", "Reply-To": "joao@x.com", Subject: "Novo contato pelo site" },
        "Nome: João Lima\nE-mail: joao@x.com\nTelefone: 11 98888-7777\nCidade: Campinas\nProduto: Seguro auto\nMensagem: Quero uma cotação",
      ),
    );
    if (r.skip !== undefined) throw new Error(r.skip);
    expect(r.lead).toMatchObject({ name: "João Lima", email: "joao@x.com", phone: "5511988887777", city: "Campinas" });
    expect(r.lead.qualification).toEqual({ Produto: "Seguro auto", Mensagem: "Quero uma cotação", "Assunto do e-mail": "Novo contato pelo site" });
    expect(r.quote).toBe(true);
  });

  it("a lead forwarded by the team: the contact is the forwarded sender, never the person who forwarded it", async () => {
    const r = await read(
      eml(
        { From: "Wellington <wellington@banneg.com.br>", Subject: "Fwd: franquia" },
        "Segue lead\n\nWellington\nBanneg (17) 98160-0088\n\n---------- Forwarded message ---------\nDe: Carla Dias <carla@hotmail.com>\nDate: ter., 21 de out. de 2026\nSubject: franquia\nTo: <wellington@banneg.com.br>\n\nTenho interesse, me liga no 21 97777-6666",
      ),
    );
    if (r.skip !== undefined) throw new Error(r.skip);
    expect(r.lead).toMatchObject({ name: "Carla Dias", email: "carla@hotmail.com", phone: "5521977776666" });
  });

  it("a reply: the quoted e-mail and the company's own number are not the lead's phone", async () => {
    const r = await read(
      eml(
        { From: "pedro@x.com", Subject: "Re: Banneg" },
        "Quero sim, me chame no WhatsApp da Banneg (17) 99679-0187.\n\nEm ter., 21 de out. de 2026 às 10:00, Expansão Banneg <expansao@banneg.com.br> escreveu:\n> Fale com a gente no (11) 92013-8123",
      ),
    );
    if (r.skip !== undefined) throw new Error(r.skip);
    expect(r.lead).toMatchObject({ email: "pedro@x.com", phone: null, name: null });
    expect(r.body).not.toContain("92013");
  });

  it("an HTML-only form", async () => {
    const r = await read(
      eml({ From: "noreply@formularios.com", Subject: "Formulário" }, "<p><b>Nome:</b> Ana Paz</p><p><b>Telefone:</b> (61) 9325-8573</p><p><b>E-mail:</b> ana@x.com</p>", "text/html"),
    );
    if (r.skip !== undefined) throw new Error(r.skip);
    expect(r.lead).toMatchObject({ name: "Ana Paz", email: "ana@x.com", phone: "556193258573" });
  });

  it("the site's form (WPForms), sent from the box to itself: the answers under each label make the lead", async () => {
    // Classic template: the label in one table row, the answer in the next
    const classic = await read(
      eml(
        { From: `Website Demos <${BOX}>`, Subject: "New Entry: Simple Contact Form" },
        `<table><tbody><tr><td style="padding:10px"><strong>Nome</strong></td></tr><tr><td>Jo&atilde;o da Silva</td></tr>
<tr><td><strong>E-mail</strong></td></tr><tr><td><a href="mailto:joao@x.com">joao@x.com</a></td></tr>
<tr><td><strong>Telefone</strong></td></tr><tr><td>(11) 98888-7777</td></tr>
<tr><td><strong>Comment or Message</strong></td></tr><tr><td>Quero uma cota&ccedil;&atilde;o<br>de seguro auto</td></tr></tbody></table>
<p>Sent from <a href="https://banneg.com.br">Website Demos</a></p>`,
        "text/html",
      ),
    );
    if (classic.skip !== undefined) throw new Error(classic.skip);
    expect(classic.lead).toMatchObject({ name: "João da Silva", email: "joao@x.com", phone: "5511988887777" });
    expect(classic.lead.qualification).toMatchObject({ "Comment or Message": "Quero uma cotação de seguro auto" });
    expect(classic.body).toContain("Quero uma cotação");
    // The quote is in the answers, not in the subject
    expect(classic.quote).toBe(true);

    // Newer template: label and answer in the same cell
    const modern = await read(
      eml(
        { From: `Website Demos <${BOX}>`, Subject: "New Entry: Simple Contact Form" },
        `<table><tr class="smart-tag"><td class="field-name field-value"><strong>Name</strong><span class="field-value-break"></span>Maria Souza</td></tr><tr class="smart-tag"><td><strong>Email</strong><br><a href="mailto:maria@y.com">maria@y.com</a></td></tr><tr><td><strong>Comment or Message</strong><br>Oi, quero saber de consórcio. Meu zap 21 97777-6666</td></tr></table>`,
        "text/html",
      ),
    );
    if (modern.skip !== undefined) throw new Error(modern.skip);
    expect(modern.lead).toMatchObject({ name: "Maria Souza", email: "maria@y.com", phone: "5521977776666" });

    // Plain text template
    const plain = await read(eml({ From: BOX, Subject: "New Entry: Contato" }, "--- Name ---\n\nRui Lima\n\n--- Email ---\n\nrui@z.com\n\n--- Comment or Message ---\n\nLigar à tarde"));
    if (plain.skip !== undefined) throw new Error(plain.skip);
    expect(plain.lead).toMatchObject({ name: "Rui Lima", email: "rui@z.com" });
    expect(plain.lead.qualification).toMatchObject({ "Comment or Message": "Ligar à tarde" });
  });

  it("skips auto-replies, bounces, newsletters and e-mails with no contact", async () => {
    expect((await read(eml({ From: "a@x.com", "Auto-Submitted": "auto-replied", Subject: "Oi" }, "Estou fora")))).toMatchObject({ skip: "resposta automática" });
    expect((await read(eml({ From: "a@x.com", Subject: "Resposta automática: Franquia" }, "Estou fora")))).toMatchObject({ skip: "resposta automática" });
    expect((await read(eml({ From: "MAILER-DAEMON@locaweb.com.br", Subject: "Undelivered" }, "x")))).toMatchObject({ skip: "aviso de e-mail não entregue" });
    expect((await read(eml({ From: "news@loja.com", "List-Unsubscribe": "<https://x>", Subject: "Ofertas" }, "Promoções da semana")))).toMatchObject({
      skip: "newsletter ou e-mail em massa",
    });
    expect((await read(eml({ From: `Banneg | Cotações <${BOX}>`, Subject: "WP Mail SMTP: HTML test email" }, "<p>Congrats, test email was sent successfully!</p>", "text/html")))).toMatchObject({
      skip: "sem e-mail nem telefone do lead",
    });
    expect((await read(eml({ From: "odair@banneg.com.br", Subject: "Reunião" }, "Pessoal, reunião amanhã.")))).toMatchObject({
      skip: "sem e-mail nem telefone do lead",
    });
  });

  it("form lines and phones", () => {
    expect(formFields("Olá, tudo bem: sim\nhttps://banneg.com.br\nNome completo: Rui").name).toBe("Rui");
    expect(formFields("https://banneg.com.br").lines).toBe(0);
    expect(findPhone("CNPJ 12.345.678/0001-90, pedido 2026", [])).toBeNull();
    expect(findPhone("+55 (11) 98765-4321", [])).toBe("5511987654321");
    expect(findPhone("ligue (017) 99679-0187", [OWN_PHONE])).toBeNull();
  });
});

describe.skipIf(!dbUrl)("reading the box", () => {
  let db: typeof import("@/lib/db").db;
  let emailLeads: typeof import("@/lib/email-leads");
  let franchise: { id: string };
  let box: Record<number, Buffer>;
  let validity: string;
  let failLogin: boolean;
  const open = async () => {
    if (failLogin) throw Object.assign(new Error("Authentication failed"), { authenticationFailed: true });
    return {
      uidValidity: validity,
      newSince: async (lastUid: number | null) => Object.keys(box).map(Number).filter((uid) => !lastUid || uid > lastUid),
      read: async (uid: number) => (box[uid] ? { uid, source: box[uid] } : null),
      close: async () => {},
    };
  };
  const now = (iso = "2026-10-22T21:00:00Z") => new Date(iso);

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    emailLeads = await import("@/lib/email-leads");
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    franchise = await installDefaultPipeline(db);
    box = {};
    validity = "1";
    failLogin = false;
  });

  it("creates each e-mail's lead once, keeps the e-mail in the conversation and gives a person the leads without WhatsApp", async () => {
    box[1] = eml({ From: "Maria Silva <maria@gmail.com>", Subject: "Franquia", "Message-ID": "<m1@x>" }, "Quero saber da franquia. WhatsApp 17 99123-4567");
    box[2] = eml({ From: "Caio <caio@x.com>", Subject: "Informações", "Message-ID": "<m2@x>" }, "Me mandem informações por e-mail.");
    box[3] = eml({ From: "a@x.com", "Auto-Submitted": "auto-replied", Subject: "Ausente", "Message-ID": "<m3@x>" }, "Estou fora");
    expect(await emailLeads.pullEmailLeads(now(), { open })).toEqual({ read: 3, created: 2 });

    const maria = await db.lead.findFirstOrThrow({ where: { email: "maria@gmail.com" }, include: { messages: true, tasks: true } });
    expect(maria).toMatchObject({ name: "Maria Silva", phone: "5517991234567", source: "E-mail", campaign: "Franquia", pipelineId: franchise.id });
    expect(maria.messages).toMatchObject([{ channel: "EMAIL", direction: "IN", status: "RECEIVED", externalId: "email:m1@x" }]);
    expect(maria.messages[0].body).toContain("Quero saber da franquia");
    // With WhatsApp the automations and the AI take it
    expect(maria.tasks).toEqual([]);
    const caio = await db.lead.findFirstOrThrow({ where: { email: "caio@x.com" }, include: { tasks: true } });
    expect(caio.tasks.map((t) => t.title)).toEqual(["Responder e-mail do lead"]);

    const state = await emailLeads.emailLeadsState();
    expect(state).toMatchObject({ lastUid: 3, uidValidity: "1", created: 2, error: null });
    expect(state.log?.map((l) => l.result)).toEqual(["ignorado: resposta automática", "lead novo", "lead novo"]);

    // Nothing new: nothing read again
    expect(await emailLeads.pullEmailLeads(now("2026-10-22T21:02:00Z"), { open })).toEqual({ read: 0, created: 0 });
    // The server renumbered the box: the same e-mails are not leads twice
    validity = "2";
    expect(await emailLeads.pullEmailLeads(now("2026-10-22T21:04:00Z"), { open })).toEqual({ read: 3, created: 0 });
    expect(await db.lead.count()).toBe(2);
    expect(await db.message.count()).toBe(2);
  });

  it("a lead already here gets the e-mail in its conversation and a task, in the funnel chosen for the box", async () => {
    const produtos = await db.pipeline.create({ data: { name: "Cotações", slug: "cotacoes", position: 3 } });
    await db.stage.create({ data: { pipelineId: produtos.id, key: "novo", name: "Novo", position: 0 } });
    await emailLeads.setEmailLeadsFunnel(produtos.id);
    box[1] = eml({ From: "Rui <rui@x.com>", Subject: "Cotação", "Message-ID": "<r1@x>" }, "Quero cotar um seguro.");
    await emailLeads.pullEmailLeads(now(), { open });
    const rui = await db.lead.findFirstOrThrow({ where: { email: "rui@x.com" } });
    expect(rui.pipelineId).toBe(produtos.id);
    await db.task.updateMany({ data: { doneAt: new Date() } });

    box[2] = eml({ From: "Rui <RUI@x.com>", Subject: "Outra dúvida", "Message-ID": "<r2@x>" }, "E consórcio?");
    expect(await emailLeads.pullEmailLeads(now("2026-10-22T21:02:00Z"), { open })).toEqual({ read: 1, created: 0 });
    expect(await db.lead.count()).toBe(1);
    expect(await db.message.count({ where: { leadId: rui.id } })).toBe(2);
    expect(await db.task.count({ where: { leadId: rui.id, doneAt: null } })).toBe(1);
    expect(await db.leadEvent.findFirst({ where: { leadId: rui.id, type: "lead.email" } })).toMatchObject({ summary: `Mandou um e-mail para ${BOX}: "Outra dúvida"` });
  });

  it("quote requests (the site's quote form) go to the quotes funnel, the rest to the box's funnel", async () => {
    const quotes = await db.pipeline.create({ data: { name: "Cotações/ Seguros e Consórcios", slug: "parceiro-veiculos", position: 6 } });
    await db.stage.create({ data: { pipelineId: quotes.id, key: "novo", name: "Novo", position: 0 } });
    expect((await emailLeads.quoteFunnel(await emailLeads.emailLeadsState()))?.id).toBe(quotes.id);
    box[1] = eml(
      { From: `Website Demos <${BOX}>`, Subject: "New Entry: Simple Contact Form", "Message-ID": "<q1@x>" },
      "Comment or Message: SOLICITAÇÃO DE COTAÇÃO - ALICE / SITE BANNEG\nProduto: Seguro auto\nNome: Lia\nWhatsApp: 17981600011\nE-mail: lia@x.com",
    );
    box[2] = eml({ From: "Téo <teo@x.com>", Subject: "Franquia", "Message-ID": "<q2@x>" }, "Quero abrir uma franquia. 11 98888-1111");
    await emailLeads.pullEmailLeads(now(), { open });
    expect((await db.lead.findFirstOrThrow({ where: { email: "lia@x.com" } })).pipelineId).toBe(quotes.id);
    expect((await db.lead.findFirstOrThrow({ where: { email: "teo@x.com" } })).pipelineId).toBe(franchise.id);

    // "O mesmo funil dos leads": quotes too go to the box's funnel
    await emailLeads.setEmailLeadsFunnel(null, null);
    expect(await emailLeads.quoteFunnel(await emailLeads.emailLeadsState())).toBeNull();
    box[3] = eml({ From: "Ivo <ivo@x.com>", Subject: "Orçamento de seguro", "Message-ID": "<q3@x>" }, "Me mandem um orçamento. 11 97777-2222");
    await emailLeads.pullEmailLeads(now("2026-10-22T21:02:00Z"), { open });
    expect((await db.lead.findFirstOrThrow({ where: { email: "ivo@x.com" } })).pipelineId).toBe(franchise.id);
    // Choosing the main funnel again keeps the quotes choice
    await emailLeads.setEmailLeadsFunnel(quotes.id);
    expect(await emailLeads.emailLeadsState()).toMatchObject({ pipelineId: quotes.id, quotePipelineId: null });
  });

  it("a refused password is shown on Integrações and not retried every 2 minutes", async () => {
    failLogin = true;
    const first = await emailLeads.pullEmailLeads(now(), { open });
    expect(first).toEqual({ error: `A Locaweb recusou o login de ${BOX}. Confira a senha em LEADS_IMAP_PASSWORD no Vercel.` });
    expect(await emailLeads.pullEmailLeads(now("2026-10-22T21:02:00Z"), { open })).toEqual({ skipped: first.error });
    failLogin = false;
    box[1] = eml({ From: "ana@x.com", Subject: "Oi", "Message-ID": "<a1@x>" }, "Oi");
    // The button on Integrações tries right away
    expect(await emailLeads.pullEmailLeads(now("2026-10-22T21:03:00Z"), { open, force: true })).toEqual({ read: 1, created: 1 });
    expect((await emailLeads.emailLeadsState()).error).toBeNull();
  });
});
