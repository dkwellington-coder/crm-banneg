import { z } from "zod";
import { db } from "./db";
import { sendEmail } from "./email";
import { enqueue } from "./queue";

/** Where the portal's notices go when it names no address: the insurance team's box. */
export const PORTAL_EMAIL_TO = "seguros@banneg.com.br";
// The portal's own words only go to the team, never to a client or a store: an address of the company's own domain
const TEAM_DOMAIN = "@banneg.com.br";
// One "@", the domain's, with a name before it
const teamAddress = (v: string) => v.endsWith(TEAM_DOMAIN) && v.indexOf("@") > 0 && v.indexOf("@") === v.length - TEAM_DOMAIN.length;
const JOB = "portal.email";

// One line, for the subject: a line break in a header would start another header
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** What POST /api/portal/email takes: a notice the portal writes (a store asking for a training session...). */
export const PortalEmailInput = z.object({
  // The portal's id for this notice: the same ref sent again sends nothing new
  ref: z.string().trim().min(1).max(120),
  para: z
    .email()
    .max(200)
    .transform((v) => v.toLowerCase())
    .refine(teamAddress, { message: `O portal só manda e-mail para endereços ${TEAM_DOMAIN}.` })
    .optional(),
  // Cut, not refused: a long store name must not hold the whole notice back
  assunto: z.string().max(2000).transform((v) => oneLine(v).slice(0, 200).trim()).pipe(z.string().min(1)),
  texto: z.string().trim().min(1).max(8000),
  // The store's e-mail: the team's answer goes straight to it. One the mail server would not take is left out, and the
  // notice still goes (the e-mail is also in the text).
  responderPara: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => {
      const e = v?.trim().toLowerCase();
      return e && z.email().max(200).safeParse(e).success ? e : undefined;
    }),
});
export type PortalEmail = z.infer<typeof PortalEmailInput>;
type Payload = { ref: string; para: string; assunto: string; texto: string; responderPara?: string };
/**
 * A notice whose every word the CRM wrote itself, from its own fixed sentences (the partner's notice, partnerNotice): the
 * only kind that may go outside the company's domain. Never built from a body the portal sent as it came.
 */
export type TrustedPortalEmail = Payload & { trusted: true };

/**
 * Queues the notice; the cron sends it, with the queue's retries when the mail server fails. The ref stays in the job's
 * payload after it runs (the dedupeKey does not), so the portal sending the same notice again (it never heard the answer)
 * sends it once. A notice that failed every try can be sent again. The domain is checked here too, not only by
 * PortalEmailInput, so the portal's own words never leave the company whoever calls this; a trusted notice skips it.
 */
export async function queuePortalEmail(input: PortalEmail | TrustedPortalEmail) {
  const para = input.para ?? PORTAL_EMAIL_TO;
  const trusted = "trusted" in input && input.trusted === true;
  if (!trusted && !teamAddress(para)) throw new Error(`O portal só manda e-mail para endereços ${TEAM_DOMAIN}.`);
  const existing = await db.job.findFirst({
    where: { type: JOB, status: { notIn: ["FAILED", "CANCELLED"] }, payload: { path: ["ref"], equals: input.ref } },
    select: { id: true, status: true },
  });
  // The status lets the portal tell "already sent" from "still in the queue" when it sends the same notice again
  if (existing) return { id: existing.id, repeated: true, status: existing.status };
  const payload: Payload = { ref: input.ref, para, assunto: input.assunto, texto: input.texto, ...(input.responderPara && { responderPara: input.responderPara }) };
  const job = await enqueue(JOB, { payload, dedupeKey: `${JOB}:${input.ref}`, maxAttempts: 6 });
  return { id: job.id, repeated: false, status: job.status };
}

/** The job: the notice goes even in test mode, which only holds back messages to leads (the team and a partner are not). */
export async function sendPortalEmail(payload: unknown) {
  const p = payload as Payload;
  const id = await sendEmail(p.para, p.assunto, p.texto, [], undefined, p.responderPara);
  return `E-mail do portal enviado para ${p.para}${id ? ` (${id})` : ""}.`;
}

// The partner's notice: the portal sends only names and the links, and the CRM writes the rest, so a leaked token can send
// nothing but these notices. A name that carries a link or an address would put the sender's words in the Banneg's mail.
const PARTNER_SUBJECTS = {
  PENDENCIA: "O Banneg precisa de você no portal de indicações",
  RECADO: "Você tem um recado do Banneg no portal de indicações",
  CANCELAMENTO: "O Banneg cancelou uma indicação no portal",
  CRIAR_SENHA: "Seu acesso ao portal de indicações do Banneg",
  REDEFINIR_SENHA: "Crie uma senha nova no portal de indicações do Banneg",
};
const WELCOME_SUBJECTS = {
  LOJA: "Seu cadastro no portal de indicações do Banneg foi aprovado",
  AFILIADO: "Seu cadastro no portal de indicações do Banneg foi aprovado",
  INDICADOR: "Você foi cadastrado como indicador no portal do Banneg",
  SUPERVISOR: "Seu acesso de supervisor no portal de indicações do Banneg",
};
const looksLikeLink = (v: string) => /@|:\/\/|www\.|[a-z0-9]\.[a-z]{2,}/i.test(v);
const shortName = (min: number) =>
  z
    .string()
    .max(2000)
    .transform(oneLine)
    .pipe(z.string().min(min).max(80).refine((v) => !looksLikeLink(v), { message: "Sem link nem e-mail no nome." }));
// An optional name: empty is the same as none
const optionalName = () =>
  shortName(0)
    .optional()
    .transform((v) => v || undefined);

/**
 * What POST /api/portal/aviso-parceiro takes, for the portal at portal (PORTAL_URL without the trailing slash): every
 * link must be a page of it. One schema, by tipo:
 * - PENDENCIA, RECADO, CANCELAMENTO: the Banneg left a pendência or a message for the partner, or cancelled a referral;
 * - BOAS_VINDAS: the welcome, once per partner, when the Banneg approves a signup or an account is created for it (by the
 *   admin, or an indicador by the partner above it). perfil SUPERVISOR is the partner above stores and affiliates, paid by
 *   the Banneg a % of their sales on top of their own commission. link is the login page; senhaLink, the one-time link to
 *   create the password, comes only for an account with no password of its own yet;
 * - CRIAR_SENHA, REDEFINIR_SENHA: a one-time link to create the password (the admin sent it) or a new one ("Esqueci minha
 *   senha", any role of the portal). The job's payload keeps the link: it works once and expires.
 */
export function partnerNoticeInput(portal: string) {
  // A page of the portal, with nothing that could end the link in the e-mail or start another one after it
  const page = z
    .string()
    .trim()
    .max(500)
    .refine((v) => v.startsWith(`${portal}/`) && !/[\s"'<>]/.test(v), { message: "O link precisa ser uma página do portal." });
  const common = {
    // The portal's id for this notice (its outbox row): the same ref sent again sends nothing new
    ref: z.string().trim().min(1).max(120),
    para: z
      .email()
      .max(200)
      .transform((v) => v.toLowerCase()),
    // The partner's first name
    nome: shortName(1),
    link: page,
  };
  return z.discriminatedUnion("tipo", [
    // sobre: "a indicação de Maria"
    z.object({ ...common, tipo: z.enum(["PENDENCIA", "RECADO", "CANCELAMENTO"]), sobre: optionalName() }),
    // quem: the name of whoever registered an indicador
    z.object({ ...common, tipo: z.literal("BOAS_VINDAS"), perfil: z.enum(["LOJA", "AFILIADO", "INDICADOR", "SUPERVISOR"]), senhaLink: page.optional(), quem: optionalName() }),
    z.object({ ...common, tipo: z.enum(["CRIAR_SENHA", "REDEFINIR_SENHA"]) }),
  ]);
}
export type PartnerNotice = z.infer<ReturnType<typeof partnerNoticeInput>>;
type NoticeOf<T extends PartnerNotice["tipo"]> = Extract<PartnerNotice, { tipo: T }>;
/** What the e-mail is written from: the notice without its ref. The Banneg's own notices never write the address. */
export type PartnerNoticeText =
  | (Pick<NoticeOf<"PENDENCIA" | "RECADO" | "CANCELAMENTO">, "nome" | "tipo" | "link"> & { sobre?: string })
  | (Omit<NoticeOf<"BOAS_VINDAS">, "ref" | "senhaLink" | "quem"> & { senhaLink?: string; quem?: string })
  | Omit<NoticeOf<"CRIAR_SENHA" | "REDEFINIR_SENHA">, "ref">;

const AUTOMATIC = "Este é um aviso automático do Banneg.";
// The words of the button and the link to the general conversation on the partner's screens (the portal's /loja). Not on
// the new password's e-mail: it may go to anyone who logs in to the portal, a client too, who has no such button.
const TALK_TO_US = `${AUTOMATIC} Para falar com a equipe, use "Falar com o Banneg" no portal.`;

/**
 * The welcome: how to get in (the password the partner chose at signup, the one whoever registered an indicador gave it, or
 * a link to create one) and the first steps. An indicador has no quote link of its own and no Divulgar: its step is left out.
 * A supervisor indicates no client herself (no quote link, no Indicar): her Divulgar has the signup link for the garages and
 * affiliates she brings, and Parceiros shows their referrals and sales. A quem sent with her is not named, as for a store.
 */
function welcome({ nome, para, perfil, link, senhaLink, quem }: Extract<PartnerNoticeText, { tipo: "BOAS_VINDAS" }>) {
  const indicador = perfil === "INDICADOR";
  const supervisor = perfil === "SUPERVISOR";
  const opening = indicador
    ? `${quem ? `${quem} cadastrou você` : "Você foi cadastrado"} como indicador no portal de indicações do Banneg. Cada cliente que você indicar e fechar com o Banneg rende comissão para você.`
    : supervisor
      ? "Você agora é supervisor no portal de indicações do Banneg. Em cada venda dos parceiros abaixo de você, o Banneg paga a você um % a mais, além da comissão deles."
      : "Seu cadastro no portal de indicações do Banneg foi aprovado. A partir de agora, cada cliente que você indicar e fechar com o Banneg rende comissão para você.";
  const password = indicador ? `${quem ?? "quem cadastrou você"} te passou` : "você escolheu no cadastro";
  const access = senhaLink
    ? `Para entrar, crie sua senha por este link. Ele vale por 7 dias e só uma vez:\n${senhaLink}\n\nDepois, entre sempre com o e-mail ${para} e a senha que você criou:\n${link}`
    : `Entre com o e-mail ${para} e a senha que ${password}:\n${link}`;
  const middle = supervisor
    ? [
        "Em Divulgar, pegue o link de cadastro para garagens e afiliados. Quem se cadastrar por ele fica abaixo de você depois da aprovação do Banneg.",
        "Em Parceiros, acompanhe as indicações e as vendas da sua equipe e a sua parte.",
      ]
    : [
        ...(indicador ? [] : ["Em Divulgar, pegue o seu link de cotação e as artes prontas para mandar aos clientes."]),
        "Em Indicar, cadastre o cliente com as fotos dos documentos. O Banneg faz o atendimento e a cotação.",
      ];
  const steps = [
    "Em Recebimento, cadastre a chave Pix que vai receber as comissões.",
    ...middle,
    "Em Treinamentos, veja o básico de cada produto e o manual do portal.",
  ].map((step, i) => `${i + 1}. ${step}`);
  return {
    assunto: WELCOME_SUBJECTS[perfil],
    texto: `Olá, ${nome}.\n\n${opening}\n\n${access}\n\nPrimeiros passos:\n${steps.join("\n")}\n\nEsqueceu a senha? Na tela de entrar, use "Esqueci minha senha".\n\n${TALK_TO_US}`,
  };
}

/** The one-time link to create the password (the admin sent it) or a new one (the person asked for it). */
function passwordLink({ nome, tipo, para, link }: Extract<PartnerNoticeText, { tipo: "CRIAR_SENHA" | "REDEFINIR_SENHA" }>) {
  return {
    assunto: PARTNER_SUBJECTS[tipo],
    texto:
      tipo === "CRIAR_SENHA"
        ? `Olá, ${nome}.\n\nA equipe do Banneg mandou um link para você criar a senha do portal de indicações. Ele vale por 7 dias e só uma vez:\n${link}\n\nDepois, entre com o e-mail ${para} e a senha que você criou.\n\n${TALK_TO_US}`
        : `Olá, ${nome}.\n\nRecebemos um pedido para trocar a senha da sua conta no portal de indicações do Banneg. Para criar uma senha nova, abra este link. Ele vale por 2 horas e só uma vez:\n${link}\n\nSe não foi você que pediu, ignore este e-mail. Sua senha continua a mesma.\n\n${AUTOMATIC}`,
  };
}

/** The partner's e-mail, in the CRM's words: only the names, what it is about and the links come from the portal. */
export function partnerNotice(notice: PartnerNoticeText) {
  switch (notice.tipo) {
    case "BOAS_VINDAS":
      return welcome(notice);
    case "CRIAR_SENHA":
    case "REDEFINIR_SENHA":
      return passwordLink(notice);
  }
  const { nome, tipo, sobre, link } = notice;
  const about = sobre ? `, sobre ${sobre}` : "";
  const frase =
    tipo === "PENDENCIA"
      ? `O Banneg deixou uma pendência para você${about}.`
      : tipo === "RECADO"
        ? `O Banneg deixou um recado para você${about}.`
        : `O Banneg cancelou ${sobre ?? "uma indicação sua"}. O motivo está no portal.`;
  const answer = tipo !== "CANCELAMENTO" ? " e responder" : "";
  return {
    assunto: PARTNER_SUBJECTS[tipo],
    texto: `Olá, ${nome}.\n\n${frase}\n\nPara ver${answer}, entre no portal:\n${link}\n\n${TALK_TO_US}`,
  };
}

/**
 * Queues the partner's notice as a portal.email job, sent once per ref like the team's (under its own prefix, so the
 * portal's two kinds of notice never take each other's ref). A partner answering the e-mail reaches the team's box.
 */
export function queuePartnerNotice(input: PartnerNotice) {
  return queuePortalEmail({ trusted: true, ref: `parceiro:${input.ref}`, para: input.para, ...partnerNotice(input), responderPara: PORTAL_EMAIL_TO });
}
