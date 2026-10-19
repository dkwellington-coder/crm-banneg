// While both CRMs are in use, each WhatsApp notification is passed on to the old CRM, unchanged.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_APP_SECRET = "s";
delete process.env.META_APP_ID;
delete process.env.WHATSAPP_FORWARD_URL;

const OLD = "https://crm.banneg.com.br/api/whatsapp/webhook";

describe.skipIf(!dbUrl)("copy to the old CRM", () => {
  let db: typeof import("@/lib/db").db;
  let fwd: typeof import("@/lib/whatsapp-forward");
  const calls: { url: string; init?: RequestInit }[] = [];
  let callback = OLD;

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    fwd = await import("@/lib/whatsapp-forward");
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (url.endsWith("/app")) return json({ id: "app1" });
      if (url.endsWith("/app1/subscriptions"))
        return json({ data: [{ object: "page", callback_url: "https://x/page" }, { object: "whatsapp_business_account", callback_url: callback, active: true }] });
      return new Response("ok", { status: 200 });
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    callback = OLD;
    delete process.env.WHATSAPP_FORWARD_URL;
    fwd.resetForwardCache();
    await db.$executeRawUnsafe('TRUNCATE "Setting" CASCADE');
  });

  const meta = () => new Headers({ "x-hub-signature-256": "sha256=abc", "x-hub-signature": "sha1=def" });

  it("sends Meta's body and signature to the address set in the Meta app", async () => {
    expect(await fwd.forwardCopy('{"entry":[]}', meta())).toEqual({ status: 200 });
    const sent = calls.find((c) => c.url === OLD)!;
    expect(sent.init?.body).toBe('{"entry":[]}');
    expect(sent.init?.headers).toMatchObject({ "x-hub-signature-256": "sha256=abc", "x-hub-signature": "sha1=def", "x-crm-banneg-copy": "1" });
    // The app is asked with its own app token, and the answer is kept for an hour
    expect(calls.find((c) => c.url.endsWith("/subscriptions"))?.init?.headers).toEqual({ Authorization: "Bearer app1|s" });
    calls.length = 0;
    await fwd.forwardCopy("{}", meta());
    expect(calls.map((c) => c.url)).toEqual([OLD]);
  });

  it("never sends a copy back, nor to itself, and can be turned off", async () => {
    expect(await fwd.forwardCopy("{}", new Headers({ "x-crm-banneg-copy": "1" }))).toEqual({ skipped: "copy" });
    callback = "https://crm-banneg-banneg.vercel.app/api/whatsapp/webhook";
    expect(await fwd.forwardCopy("{}", meta())).toEqual({ skipped: "no-target" });
    process.env.WHATSAPP_FORWARD_URL = "";
    fwd.resetForwardCache();
    expect(await fwd.forwardCopy("{}", meta())).toEqual({ skipped: "no-target" });
  });

  it("the owner's switch stops the copy, so only this CRM attends, and can turn it back on", async () => {
    await fwd.forwardCopy("{}", meta());
    expect(calls.some((c) => c.url === OLD)).toBe(true);
    await fwd.setWhatsAppCopy(true, "Wellington");
    calls.length = 0;
    // Even with the old address still cached
    expect(await fwd.forwardCopy("{}", meta())).toEqual({ skipped: "no-target" });
    expect(calls).toHaveLength(0);
    await fwd.setWhatsAppCopy(false, "Wellington");
    expect(await fwd.forwardCopy("{}", meta())).toEqual({ status: 200 });
  });

  it("a failing old CRM does not break anything", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/app")) return new Response(JSON.stringify({ id: "app1" }));
      if (url.endsWith("/subscriptions")) return new Response(JSON.stringify({ data: [{ object: "whatsapp_business_account", callback_url: OLD }] }));
      throw new Error("connect ECONNREFUSED");
    });
    expect(await fwd.forwardCopy("{}", meta())).toEqual({ error: "connect ECONNREFUSED" });
  });
});
