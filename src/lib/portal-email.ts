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

// The partner's notice: the portal sends only names and the link, and the CRM writes the rest, so a leaked token can send
// nothing but this notice. A name that carries a link or an address would put the sender's words in the Banneg's mail.
const PARTNER_SUBJECTS = {
  PENDENCIA: "O Banneg precisa de você no portal de indicações",
  RECADO: "Você tem um recado do Banneg no portal de indicações",
  CANCELAMENTO: "O Banneg cancelou uma indicação no portal",
};
const looksLikeLink = (v: string) => /@|:\/\/|www\.|[a-z0-9]\.[a-z]{2,}/i.test(v);
const shortName = (min: number) =>
  z
    .string()
    .max(2000)
    .transform(oneLine)
    .pipe(z.string().min(min).max(80).refine((v) => !looksLikeLink(v), { message: "Sem link nem e-mail no nome." }));

/**
 * What POST /api/portal/aviso-parceiro takes, for the portal at portal (PORTAL_URL without the trailing slash): the
 * link must be a page of it.
 */
export function partnerNoticeInput(portal: string) {
  return z.object({
    // The portal's id for this notice (its outbox row): the same ref sent again sends nothing new
    ref: z.string().trim().min(1).max(120),
    para: z
      .email()
      .max(200)
      .transform((v) => v.toLowerCase()),
    // The partner's first name
    nome: shortName(1),
    tipo: z.enum(["PENDENCIA", "RECADO", "CANCELAMENTO"]),
    // "a indicação de Maria": empty is the same as none
    sobre: shortName(0)
      .optional()
      .transform((v) => v || undefined),
    link: z
      .string()
      .trim()
      .max(500)
      .refine((v) => v.startsWith(`${portal}/`) && !/[\s"'<>]/.test(v), { message: "O link precisa ser uma página do portal." }),
  });
}
export type PartnerNotice = z.infer<ReturnType<typeof partnerNoticeInput>>;

/** The partner's e-mail, in the CRM's words: only the name, what it is about and the link come from the portal. */
export function partnerNotice({ nome, tipo, sobre, link }: Pick<PartnerNotice, "nome" | "tipo" | "link"> & { sobre?: string }) {
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
    texto: `Olá, ${nome}.\n\n${frase}\n\nPara ver${answer}, entre no portal:\n${link}\n\nEste é um aviso automático do Banneg. Para falar com a equipe, responda pelo portal.`,
  };
}

/**
 * Queues the partner's notice as a portal.email job, sent once per ref like the team's (under its own prefix, so the
 * portal's two kinds of notice never take each other's ref). A partner answering the e-mail reaches the team's box.
 */
export function queuePartnerNotice(input: PartnerNotice) {
  return queuePortalEmail({ trusted: true, ref: `parceiro:${input.ref}`, para: input.para, ...partnerNotice(input), responderPara: PORTAL_EMAIL_TO });
}
