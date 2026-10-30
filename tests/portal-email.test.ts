// The portal's notices by e-mail (a store asking for an online training session): only with the portal's token, only to
// the company's own addresses, queued and sent once per ref. The validation always runs; the route and the queue only
// when TEST_DATABASE_URL is set. The mail server is stubbed, and nothing leaves the machine.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emailHtml } from "@/lib/email";
import { PORTAL_EMAIL_TO, PortalEmailInput } from "@/lib/portal-email";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; body: string; replyTo?: string }[], fail: false }));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: vi.fn(async (to: string, subject: string, body: string, _a?: unknown, _h?: unknown, replyTo?: string) => {
    if (mail.fail) throw new Error("Servidor de e-mail fora do ar");
    mail.sent.push({ to, subject, body, replyTo });
    return `<id${mail.sent.length}@teste>`;
  }),
}));

const notice = { ref: "treinamento:abc123", assunto: "Pedido de treinamento online: Lotus Veículos", texto: "Ana pediu um treinamento.", responderPara: "ana@lotus.com.br" };

describe("portal notice input", () => {
  it("takes a notice to the team and leaves the address to the CRM when the portal names none", () => {
    expect(PortalEmailInput.parse(notice)).toEqual(notice);
    expect(PortalEmailInput.parse({ ...notice, para: "Seguros@Banneg.com.br" }).para).toBe("seguros@banneg.com.br");
    expect(PORTAL_EMAIL_TO).toBe("seguros@banneg.com.br");
  });

  it("never writes outside the company's domain, nor to a look-alike domain", () => {
    for (const para of ["cliente@gmail.com", "x@banneg.com.br.evil.com", "x@evilbanneg.com.br", "banneg.com.br", "a@b@banneg.com.br"]) {
      expect(PortalEmailInput.safeParse({ ...notice, para }).success, para).toBe(false);
    }
  });

  it("keeps the subject on one line and refuses an empty notice", () => {
    expect(PortalEmailInput.parse({ ...notice, assunto: "Pedido\r\nBcc: x@y.com" }).assunto).toBe("Pedido Bcc: x@y.com");
    expect(PortalEmailInput.safeParse({ ...notice, assunto: " \n " }).success).toBe(false);
    expect(PortalEmailInput.safeParse({ ...notice, texto: "  " }).success).toBe(false);
    expect(PortalEmailInput.safeParse({ ...notice, ref: "" }).success).toBe(false);
    expect(PortalEmailInput.safeParse({ ...notice, texto: "x".repeat(8001) }).success).toBe(false);
  });

  it("cuts a long subject and drops a reply address the mail server would refuse, and the notice still goes", () => {
    expect(PortalEmailInput.parse({ ...notice, assunto: "Pedido: " + "L".repeat(400) }).assunto).toHaveLength(200);
    for (const responderPara of ["não é e-mail", "fulano..silva@gmail.com", "fulano.@gmail.com", "a@b.c", "joão@loja.com.br", "x@loja.com?bcc=y%40z.com"]) {
      const r = PortalEmailInput.safeParse({ ...notice, responderPara });
      expect(r.success, responderPara).toBe(true);
      expect(r.data?.responderPara, responderPara).toBeUndefined();
    }
    expect(PortalEmailInput.parse({ ...notice, responderPara: " Ana@Lotus.com.br " }).responderPara).toBe("ana@lotus.com.br");
  });

  it("turns links into links without letting a quote add attributes", () => {
    const html = emailHtml('Veja https://banneg.com.br/"style="color:red e https://x.com/?a=1&b=2');
    expect(html).toContain('<a href="https://banneg.com.br/">https://banneg.com.br/</a>&quot;style=&quot;color:red');
    expect(html).toContain('<a href="https://x.com/?a=1&amp;b=2">');
    expect(html).not.toMatch(/<a [^>]*style=/);
  });
});

describe.skipIf(!dbUrl)("portal notice route and queue", () => {
  let db: typeof import("@/lib/db").db;
  let jobs: typeof import("@/lib/jobs");
  let api: typeof import("@/app/api/portal/email/route");
  const token = process.env.PORTAL_LEADS_TOKEN;
  const post = (body: unknown, auth = "Bearer portal-token") =>
    api.POST(new Request("http://x/api/portal/email", { method: "POST", headers: { authorization: auth }, body: typeof body === "string" ? body : JSON.stringify(body) }));
  const drain = async () => {
    for (let i = 0; i < 5; i++) if ((await jobs.runDueJobs()).length === 0) break;
  };

  beforeAll(async () => {
    process.env.PORTAL_LEADS_TOKEN = "portal-token";
    db = (await import("@/lib/db")).db;
    jobs = await import("@/lib/jobs");
    api = await import("@/app/api/portal/email/route");
  });
  afterAll(() => {
    process.env.PORTAL_LEADS_TOKEN = token;
  });

  beforeEach(async () => {
    mail.sent.length = 0;
    mail.fail = false;
    await db.$executeRawUnsafe('TRUNCATE "Job","Setting" CASCADE');
    // Test mode holds back messages to leads, not the team's own notices
    await db.setting.create({ data: { key: "crm", value: { testMode: true } } });
  });

  it("refuses another site's token, a bad body and an address outside the company", async () => {
    expect((await post(notice, "Bearer outro")).status).toBe(401);
    expect((await post(notice, "")).status).toBe(401);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...notice, para: "cliente@gmail.com" })).status).toBe(400);
    expect(await db.job.count()).toBe(0);
  });

  it("queues the notice, sends it to seguros@ with the store as reply-to, and sends a repeated ref once", async () => {
    const first = await post(notice);
    expect(first.status).toBe(202);
    const { id, status } = await first.json();
    expect(status).toBe("PENDING");
    const again = await post(notice);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id, repeated: true, status: "PENDING" });
    await drain();
    expect(mail.sent).toEqual([{ to: "seguros@banneg.com.br", subject: notice.assunto, body: notice.texto, replyTo: "ana@lotus.com.br" }]);
    expect(await db.job.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DONE", dedupeKey: null });
    // Sent already: the same ref after the job ran still sends nothing, and the portal hears that it went
    const sent = await post(notice);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ id, repeated: true, status: "DONE" });
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(await db.job.count()).toBe(1);
  });

  it("retries while the mail server is down, and a notice that failed every try can go again", async () => {
    mail.fail = true;
    const { id } = await (await post(notice)).json();
    await drain();
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    expect(job).toMatchObject({ status: "PENDING", attempts: 1, lastError: "Servidor de e-mail fora do ar" });
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    await db.job.update({ where: { id }, data: { status: "FAILED", dedupeKey: null } });
    mail.fail = false;
    const retry = await post(notice);
    expect(retry.status).toBe(202);
    await drain();
    expect(mail.sent).toHaveLength(1);
  });
});
