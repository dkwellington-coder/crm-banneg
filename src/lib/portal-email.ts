import { z } from "zod";
import { db } from "./db";
import { sendEmail } from "./email";
import { enqueue } from "./queue";

/** Where the portal's notices go when it names no address: the insurance team's box. */
export const PORTAL_EMAIL_TO = "seguros@banneg.com.br";
// The portal only writes to the team, never to a client or a store: an address of the company's own domain
const TEAM_DOMAIN = "@banneg.com.br";
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
    .refine((v) => v.endsWith(TEAM_DOMAIN), { message: `O portal só manda e-mail para endereços ${TEAM_DOMAIN}.` })
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
 * Queues the notice; the cron sends it, with the queue's retries when the mail server fails. The ref stays in the job's
 * payload after it runs (the dedupeKey does not), so the portal sending the same notice again (it never heard the answer)
 * sends it once. A notice that failed every try can be sent again.
 */
export async function queuePortalEmail(input: PortalEmail) {
  const existing = await db.job.findFirst({
    where: { type: JOB, status: { notIn: ["FAILED", "CANCELLED"] }, payload: { path: ["ref"], equals: input.ref } },
    select: { id: true, status: true },
  });
  // The status lets the portal tell "already sent" from "still in the queue" when it sends the same notice again
  if (existing) return { id: existing.id, repeated: true, status: existing.status };
  const payload: Payload = { ref: input.ref, para: input.para ?? PORTAL_EMAIL_TO, assunto: input.assunto, texto: input.texto, ...(input.responderPara && { responderPara: input.responderPara }) };
  const job = await enqueue(JOB, { payload, dedupeKey: `${JOB}:${input.ref}`, maxAttempts: 6 });
  return { id: job.id, repeated: false, status: job.status };
}

/** The job: the notice goes to the team even in test mode, which only holds back messages to leads. */
export async function sendPortalEmail(payload: unknown) {
  const p = payload as Payload;
  const id = await sendEmail(p.para, p.assunto, p.texto, [], undefined, p.responderPara);
  return `E-mail do portal enviado para ${p.para}${id ? ` (${id})` : ""}.`;
}
