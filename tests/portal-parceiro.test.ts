// What the portal tells the CRM of a referral (a note, a cancellation, the cancellation taken back) and the e-mail it asks
// the CRM to send a partner. Only with the portal's token; a cancellation closes the lead only when nobody else's deal
// goes with it; each notice counts once. The partner's e-mail is the CRM's own text, with only the names and a link to
// the portal from outside, so it is the one notice that may leave the company's domain. The same route sends the
// partner's welcome (a supervisor's too, who indicates no client herself) and the one-time links to create a password or
// a new one, also in the CRM's own words. The validation and the texts always run; the routes only when TEST_DATABASE_URL
// is set. The mail server and the portal (fetch) are stubbed, and nothing leaves the machine.
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
// The button and the link to the general conversation say "Falar com o Banneg" on the partner's screens (the portal's /loja)
const FOOTER = 'Este é um aviso automático do Banneg. Para falar com a equipe, use "Falar com o Banneg" no portal.';
const welcome = { ref: "aviso2", para: "Ana@Lotus.com.br", nome: "Ana", tipo: "BOAS_VINDAS", perfil: "LOJA", link: `${PORTAL}/login` };
const senhaLink = `${PORTAL}/senha/q8Xr-3vT_k2LmN0pQ7sZbW4yHc9dF6gJ1aE5uR8iO2w`;
const access = { ref: "aviso3", para: "ana@lotus.com.br", nome: "Ana", tipo: "CRIAR_SENHA", link: senhaLink };

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
    const about = (sobre: string | undefined) => {
      const notice = input.parse({ ...partner, sobre });
      return "sobre" in notice ? notice.sobre : "(another tipo)";
    };
    expect(about(undefined)).toBeUndefined();
    expect(about("  ")).toBeUndefined();
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

  it("takes the welcome of each kind of partner, with the link to create the password or without it", () => {
    expect(input.parse(welcome)).toEqual({ ...welcome, para: "ana@lotus.com.br" });
    for (const perfil of ["LOJA", "AFILIADO", "INDICADOR", "SUPERVISOR"]) expect(input.parse({ ...welcome, perfil })).toMatchObject({ tipo: "BOAS_VINDAS", perfil });
    expect(input.parse({ ...welcome, perfil: "SUPERVISOR", senhaLink })).toEqual({ ...welcome, para: "ana@lotus.com.br", perfil: "SUPERVISOR", senhaLink });
    // A store or an affiliate turned supervisor: the account already exists
    expect(input.parse({ ...welcome, perfil: "SUPERVISOR", convertido: true })).toEqual({ ...welcome, para: "ana@lotus.com.br", perfil: "SUPERVISOR", convertido: true });
    expect(input.parse({ ...welcome, senhaLink: ` ${senhaLink} ` })).toEqual({ ...welcome, para: "ana@lotus.com.br", senhaLink });
    const indicador = input.parse({ ...welcome, perfil: "INDICADOR", quem: " Lotus\r\nVeículos " });
    expect(indicador).toMatchObject({ perfil: "INDICADOR", quem: "Lotus Veículos" });
    // No quem, or an empty one, is the same: the e-mail does not name who registered the indicador
    for (const quem of [undefined, "", "  "]) expect(input.parse({ ...welcome, perfil: "INDICADOR", quem })).not.toHaveProperty("quem", expect.anything());
  });

  it("takes the links to create a password and a new one, and keeps no field of another notice", () => {
    for (const tipo of ["CRIAR_SENHA", "REDEFINIR_SENHA"]) {
      expect(input.parse({ ...access, tipo, para: "Ana@Lotus.com.br" }), tipo).toEqual({ ...access, tipo });
      expect(input.parse({ ...access, tipo, sobre: "a indicação de Maria", senhaLink, perfil: "LOJA", quem: "Lotus" }), tipo).toEqual({ ...access, tipo });
    }
    // Nor does a pendência keep the welcome's fields
    expect(input.parse({ ...partner, perfil: "LOJA", senhaLink: "https://golpe.com/senha", quem: "Lotus" })).toEqual({ ...partner, para: "ana@lotus.com.br" });
  });

  it("the link to create the password is a page of this portal too", () => {
    for (const bad of [
      "https://golpe.com/senha/abc",
      "https://portal.banneg.com.br.golpe.com/senha/abc",
      "http://portal.banneg.com.br/senha/abc",
      PORTAL,
      `${PORTAL}/senha/abc https://golpe.com`,
      `${PORTAL}/senha/abc"onmouseover="x`,
      `${PORTAL}/senha/<b>`,
      `${PORTAL}/senha/'x`,
      `${PORTAL}/${"x".repeat(500)}`,
      "",
      "javascript:alert(1)",
    ]) {
      expect(input.safeParse({ ...welcome, senhaLink: bad }).success, `senhaLink ${bad.slice(0, 60)}`).toBe(false);
      for (const tipo of ["CRIAR_SENHA", "REDEFINIR_SENHA"]) expect(input.safeParse({ ...access, tipo, link: bad }).success, `${tipo} ${bad.slice(0, 60)}`).toBe(false);
    }
    expect(input.safeParse({ ...welcome, link: "https://golpe.com/login" }).success).toBe(false);
  });

  it("refuses an unknown kind of partner, a quem that carries a link or an address, and a notice without its link", () => {
    for (const bad of [
      { perfil: "SUPERVISORA" },
      { perfil: "supervisor" },
      { perfil: "loja" },
      { perfil: "" },
      { perfil: undefined },
      { perfil: "INDICADOR", quem: "Lotus @ana" },
      { perfil: "INDICADOR", quem: "ana@golpe.com" },
      { perfil: "INDICADOR", quem: "veja https://golpe" },
      { perfil: "INDICADOR", quem: "www.golpe" },
      { perfil: "INDICADOR", quem: "L".repeat(81) },
      { perfil: "SUPERVISOR", convertido: "sim" },
      { perfil: "SUPERVISOR", convertido: null },
      { nome: "Ana, pague em golpe.com" },
      { nome: "" },
      { para: "não é e-mail" },
      { link: undefined },
      { tipo: "BOAS VINDAS" },
    ]) {
      expect(input.safeParse({ ...welcome, ...bad }).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    for (const tipo of ["CRIAR_SENHA", "REDEFINIR_SENHA"]) {
      for (const bad of [{ link: undefined }, { para: undefined }, { nome: "veja https://x" }, { ref: "" }]) {
        expect(input.safeParse({ ...access, tipo, ...bad }).success, `${tipo} ${JSON.stringify(bad)}`).toBe(false);
      }
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

describe("welcome and password texts", () => {
  const login = `${PORTAL}/login`;
  const para = "ana@lotus.com.br";
  const STEPS = [
    "Primeiros passos:",
    "1. Em Recebimento, cadastre a chave Pix que vai receber as comissões.",
    "2. Em Divulgar, pegue o seu link de cotação e as artes prontas para mandar aos clientes.",
    "3. Em Indicar, cadastre o cliente com as fotos dos documentos. O Banneg faz o atendimento e a cotação.",
    "4. Em Treinamentos, veja o básico de cada produto e o manual do portal.",
  ].join("\n");
  // An indicador has no quote link nor Divulgar: the steps are renumbered without it
  const INDICADOR_STEPS = [
    "Primeiros passos:",
    "1. Em Recebimento, cadastre a chave Pix que vai receber as comissões.",
    "2. Em Indicar, cadastre o cliente com as fotos dos documentos. O Banneg faz o atendimento e a cotação.",
    "3. Em Treinamentos, veja o básico de cada produto e o manual do portal.",
  ].join("\n");
  const FORGOT = 'Esqueceu a senha? Na tela de entrar, use "Esqueci minha senha".';
  const APPROVED = "Seu cadastro no portal de indicações do Banneg foi aprovado.";
  const COMMISSION = "cliente que você indicar e fechar com o Banneg rende comissão para você.";
  const CREATE = `Para entrar, crie sua senha por este link. Ele vale por 7 dias e só uma vez:\n${senhaLink}\n\nDepois, entre sempre com o e-mail ${para} e a senha que você criou:\n${login}`;
  // A supervisor indicates no client herself: no quote link nor Indicar, but the signup link for her partners and Parceiros
  const SUPERVISOR_STEPS = [
    "Primeiros passos:",
    "1. Em Recebimento, cadastre a chave Pix que vai receber as comissões.",
    "2. Em Divulgar, pegue o link de cadastro para garagens e afiliados. Quem se cadastrar por ele fica abaixo de você depois da aprovação do Banneg.",
    "3. Em Parceiros, acompanhe as indicações e as vendas da sua equipe e a sua parte.",
    "4. Em Treinamentos, veja o básico de cada produto e o manual do portal.",
  ].join("\n");
  const SUPERVISOR =
    "Você agora é supervisor no portal de indicações do Banneg. Em cada venda dos parceiros abaixo de você, o Banneg paga a você um % a mais, além da comissão deles.";

  it("a store or an affiliate approved: with the password chosen at signup, or a link to create one", () => {
    for (const perfil of ["LOJA", "AFILIADO"] as const) {
      expect(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil, link: login }), perfil).toEqual({
        assunto: "Seu cadastro no portal de indicações do Banneg foi aprovado",
        texto: `Olá, Ana.\n\n${APPROVED} A partir de agora, cada ${COMMISSION}\n\nEntre com o e-mail ${para} e a senha que você escolheu no cadastro:\n${login}\n\n${STEPS}\n\n${FORGOT}\n\n${FOOTER}`,
      });
      expect(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil, link: login, senhaLink }), perfil).toEqual({
        assunto: "Seu cadastro no portal de indicações do Banneg foi aprovado",
        texto: `Olá, Ana.\n\n${APPROVED} A partir de agora, cada ${COMMISSION}\n\n${CREATE}\n\n${STEPS}\n\n${FORGOT}\n\n${FOOTER}`,
      });
    }
    // A quem sent for a store is not the store's business: its e-mail never names one
    expect(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "LOJA", link: login, quem: "Lotus Veículos" }).texto).not.toContain("Lotus");
  });

  it("an indicador: who registered it, without Divulgar, and the password whoever registered it gave", () => {
    expect(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "INDICADOR", link: login, senhaLink, quem: "Lotus Veículos" })).toEqual({
      assunto: "Você foi cadastrado como indicador no portal do Banneg",
      texto: `Olá, Ana.\n\nLotus Veículos cadastrou você como indicador no portal de indicações do Banneg. Cada ${COMMISSION}\n\n${CREATE}\n\n${INDICADOR_STEPS}\n\n${FORGOT}\n\n${FOOTER}`,
    });
    expect(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "INDICADOR", link: login, quem: "Lotus Veículos" }).texto).toBe(
      `Olá, Ana.\n\nLotus Veículos cadastrou você como indicador no portal de indicações do Banneg. Cada ${COMMISSION}\n\nEntre com o e-mail ${para} e a senha que Lotus Veículos te passou:\n${login}\n\n${INDICADOR_STEPS}\n\n${FORGOT}\n\n${FOOTER}`,
    );
    const nobody = partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "INDICADOR", link: login });
    expect(nobody.texto).toContain("\n\nVocê foi cadastrado como indicador no portal de indicações do Banneg. Cada cliente");
    expect(nobody.texto).toContain(`Entre com o e-mail ${para} e a senha que quem cadastrou você te passou:\n${login}`);
    for (const texto of [nobody.texto, partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "INDICADOR", link: login, senhaLink }).texto]) {
      expect(texto).not.toContain("Divulgar");
      expect(texto).not.toContain("link de cotação");
      expect(texto).not.toContain("4.");
    }
  });

  it("a supervisor: paid on top of her partners' sales, with their signup link and Parceiros, never a client's steps", () => {
    const assunto = "Seu acesso de supervisor no portal de indicações do Banneg";
    const created = partnerNotice({ nome: "Andressa", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login, senhaLink });
    expect(created).toEqual({ assunto, texto: `Olá, Andressa.\n\n${SUPERVISOR}\n\n${CREATE}\n\n${SUPERVISOR_STEPS}\n\n${FORGOT}\n\n${FOOTER}` });
    // Without the link: the password she chose at signup, as a store or an affiliate turned supervisor before approval
    const approved = partnerNotice({ nome: "Andressa", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login });
    expect(approved).toEqual({
      assunto,
      texto: `Olá, Andressa.\n\n${SUPERVISOR}\n\nEntre com o e-mail ${para} e a senha que você escolheu no cadastro:\n${login}\n\n${SUPERVISOR_STEPS}\n\n${FORGOT}\n\n${FOOTER}`,
    });
    // A quem sent with her is not named, as for a store
    expect(partnerNotice({ nome: "Andressa", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login, senhaLink, quem: "Lotus Veículos" })).toEqual(created);
    // A store or an affiliate turned supervisor: the same account, whose password she may never have chosen (the admin created
    // it, and its welcome's link expired), so the e-mail says how to create one in place of the forgot line
    const converted = partnerNotice({ nome: "Rede Sul Veículos", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login, convertido: true });
    expect(converted).toEqual({
      assunto,
      texto: `Olá, Rede Sul Veículos.\n\n${SUPERVISOR}\n\nEntre com o mesmo e-mail ${para} e a senha que você já usa no portal:\n${login}\n\n${SUPERVISOR_STEPS}\n\nAinda não tem senha ou esqueceu a sua? Na tela de entrar, use "Esqueci minha senha".\n\n${FOOTER}`,
    });
    expect(converted.texto).not.toContain("escolheu no cadastro");
    expect(converted.texto).not.toContain(FORGOT);
    // With a link to create the password, the link is what she uses
    expect(partnerNotice({ nome: "Andressa", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login, senhaLink, convertido: true })).toEqual(created);
    for (const texto of [created.texto, approved.texto, converted.texto]) {
      expect(texto).not.toContain("Em Indicar");
      expect(texto).not.toContain("link de cotação");
      expect(texto).not.toContain("cliente que você indicar");
      expect(texto).not.toContain(APPROVED);
      expect(texto).not.toContain("5.");
    }
    // Nor do a store's and an indicador's e-mails get any of hers
    for (const perfil of ["LOJA", "AFILIADO", "INDICADOR"] as const) {
      const { assunto: other, texto } = partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil, link: login, senhaLink });
      expect(other, perfil).not.toBe(assunto);
      for (const hers of ["supervisor", "Em Parceiros", "link de cadastro", "abaixo de você"]) expect(texto, `${perfil} ${hers}`).not.toContain(hers);
    }
  });

  it("the link to create the password, sent by the team", () => {
    expect(partnerNotice({ nome: "Ana", para, tipo: "CRIAR_SENHA", link: senhaLink })).toEqual({
      assunto: "Seu acesso ao portal de indicações do Banneg",
      texto: `Olá, Ana.\n\nA equipe do Banneg mandou um link para você criar a senha do portal de indicações. Ele vale por 7 dias e só uma vez:\n${senhaLink}\n\nDepois, entre com o e-mail ${para} e a senha que você criou.\n\n${FOOTER}`,
    });
  });

  it("a new password asked for: to anyone who logs in to the portal, so no button of the partner's screens", () => {
    expect(partnerNotice({ nome: "Ana", para, tipo: "REDEFINIR_SENHA", link: senhaLink })).toEqual({
      assunto: "Crie uma senha nova no portal de indicações do Banneg",
      texto: `Olá, Ana.\n\nRecebemos um pedido para trocar a senha da sua conta no portal de indicações do Banneg. Para criar uma senha nova, abra este link. Ele vale por 2 horas e só uma vez:\n${senhaLink}\n\nSe não foi você que pediu, ignore este e-mail. Sua senha continua a mesma.\n\nEste é um aviso automático do Banneg.`,
    });
  });

  it("the links are the e-mail's only clickable links, the one to create the password first", () => {
    const html = emailHtml(partnerNotice({ nome: "Ana", para, tipo: "BOAS_VINDAS", perfil: "LOJA", link: login, senhaLink }).texto);
    expect([...html.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1])).toEqual([senhaLink, login]);
    // The quotes of "Esqueci minha senha" and "Falar com o Banneg" are only text
    expect(html).toContain("use &quot;Esqueci minha senha&quot;");
    // A supervisor's too: her signup link is in the portal, never in the e-mail
    const supervisor = emailHtml(partnerNotice({ nome: "Andressa", para, tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: login, senhaLink }).texto);
    expect([...supervisor.matchAll(/<a href="([^"]+)">/g)].map((m) => m[1])).toEqual([senhaLink, login]);
    expect(supervisor).toContain("o Banneg paga a você um % a mais, além da comissão deles.");
    for (const tipo of ["CRIAR_SENHA", "REDEFINIR_SENHA"] as const) {
      expect([...emailHtml(partnerNotice({ nome: "Ana", para, tipo, link: senhaLink }).texto).matchAll(/<a href="([^"]+)">/g)].map((m) => m[1]), tipo).toEqual([senhaLink]);
    }
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

  it("queues the welcome and the links to create a password in the CRM's own words, and sends each ref once", async () => {
    const indicador = { ...welcome, perfil: "INDICADOR", quem: "Lotus Veículos", senhaLink };
    const first = await post(indicador);
    expect(first.status).toBe(202);
    const { id } = await first.json();
    const text = partnerNotice({ nome: "Ana", para: "ana@lotus.com.br", tipo: "BOAS_VINDAS", perfil: "INDICADOR", link: welcome.link, senhaLink, quem: "Lotus Veículos" });
    expect((await db.job.findUniqueOrThrow({ where: { id } })).payload).toEqual({ ref: "parceiro:aviso2", para: "ana@lotus.com.br", ...text, responderPara: PORTAL_EMAIL_TO });
    // The same notice again (the portal never heard the answer) sends nothing new, whatever else comes with its ref
    expect(await (await post(indicador)).json()).toMatchObject({ ok: true, id, repeated: true });
    expect(await (await post(welcome)).json()).toMatchObject({ id, repeated: true });
    const links: Record<string, string> = {};
    for (const [ref, tipo] of [["aviso3", "CRIAR_SENHA"], ["aviso4", "REDEFINIR_SENHA"]]) {
      const res = await post({ ...access, ref, tipo, link: `${senhaLink}${ref}` });
      expect(res.status, tipo).toBe(202);
      links[tipo] = (await res.json()).id;
      expect((await post({ ...access, ref, tipo, link: `${senhaLink}${ref}` })).status, tipo).toBe(200);
    }
    await drain();
    expect(mail.sent.map(({ to, subject, replyTo }) => ({ to, subject, replyTo })).sort((a, b) => a.subject.localeCompare(b.subject))).toEqual([
      { to: "ana@lotus.com.br", subject: "Crie uma senha nova no portal de indicações do Banneg", replyTo: PORTAL_EMAIL_TO },
      { to: "ana@lotus.com.br", subject: "Seu acesso ao portal de indicações do Banneg", replyTo: PORTAL_EMAIL_TO },
      { to: "ana@lotus.com.br", subject: "Você foi cadastrado como indicador no portal do Banneg", replyTo: PORTAL_EMAIL_TO },
    ]);
    expect(mail.sent.find((m) => m.subject.startsWith("Você foi"))?.body).toBe(text.texto);
    // Each one-time link reaches the person only in its own e-mail
    for (const [tipo, ref] of [["CRIAR_SENHA", "aviso3"], ["REDEFINIR_SENHA", "aviso4"]]) {
      expect(mail.sent.filter((m) => m.body.includes(`${senhaLink}${ref}`)), tipo).toHaveLength(1);
      expect((await db.job.findUniqueOrThrow({ where: { id: links[tipo] } })).status, tipo).toBe("DONE");
    }
    expect(await (await post(indicador)).json()).toMatchObject({ id, repeated: true, status: "DONE" });
    await drain();
    expect(mail.sent).toHaveLength(3);
  });

  it("queues a supervisor's welcome in the CRM's own words, once", async () => {
    const supervisor = { ...welcome, ref: "aviso5", para: "Andressa@Gmail.com", nome: "Andressa", perfil: "SUPERVISOR", senhaLink };
    const first = await post(supervisor);
    expect(first.status).toBe(202);
    const { id } = await first.json();
    const text = partnerNotice({ nome: "Andressa", para: "andressa@gmail.com", tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: welcome.link, senhaLink });
    expect(text.assunto).toBe("Seu acesso de supervisor no portal de indicações do Banneg");
    expect((await db.job.findUniqueOrThrow({ where: { id } })).payload).toEqual({ ref: "parceiro:aviso5", para: "andressa@gmail.com", ...text, responderPara: PORTAL_EMAIL_TO });
    expect(await (await post(supervisor)).json()).toMatchObject({ ok: true, id, repeated: true });
    await drain();
    expect(mail.sent).toEqual([{ to: "andressa@gmail.com", subject: text.assunto, body: text.texto, replyTo: PORTAL_EMAIL_TO }]);
    expect(await (await post(supervisor)).json()).toMatchObject({ id, repeated: true, status: "DONE" });
    await drain();
    expect(mail.sent).toHaveLength(1);
  });

  it("queues a converted supervisor's welcome with the password she already uses", async () => {
    const converted = { ...welcome, ref: "aviso6", para: "rede@sul.com.br", nome: "Rede Sul Veículos", perfil: "SUPERVISOR", convertido: true };
    const res = await post(converted);
    expect(res.status).toBe(202);
    const { id } = await res.json();
    const text = partnerNotice({ nome: "Rede Sul Veículos", para: "rede@sul.com.br", tipo: "BOAS_VINDAS", perfil: "SUPERVISOR", link: welcome.link, convertido: true });
    expect(text.texto).toContain("a senha que você já usa no portal");
    expect((await db.job.findUniqueOrThrow({ where: { id } })).payload).toEqual({ ref: "parceiro:aviso6", para: "rede@sul.com.br", ...text, responderPara: PORTAL_EMAIL_TO });
    await drain();
    expect(mail.sent).toEqual([{ to: "rede@sul.com.br", subject: text.assunto, body: text.texto, replyTo: PORTAL_EMAIL_TO }]);
  });

  it("refuses an unknown kind of partner, a quem with an address and a link to create the password outside the portal", async () => {
    for (const bad of [
      { perfil: "SUPERVISORA" },
      { perfil: "supervisor" },
      { perfil: undefined },
      { perfil: "INDICADOR", quem: "ana@golpe.com" },
      { perfil: "INDICADOR", quem: "Lotus @ golpe" },
      { senhaLink: "https://golpe.com/senha/abc" },
      { senhaLink: `${PORTAL}/senha/abc https://golpe.com` },
    ]) {
      const res = await post({ ...welcome, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    for (const tipo of ["CRIAR_SENHA", "REDEFINIR_SENHA"]) expect((await post({ ...access, tipo, link: "https://golpe.com/senha/abc" })).status, tipo).toBe(400);
    expect((await post(welcome, "Bearer outro")).status).toBe(401);
    expect((await post(access, "")).status).toBe(401);
    expect(await db.job.count()).toBe(0);
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
