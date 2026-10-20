// One WhatsApp number per funnel: the referral funnel talks from Alice's number while every other funnel keeps the
// main one, and a conversation never switches number midway. Meta (fetch) and Claude are stubbed; the DB part runs
// only when TEST_DATABASE_URL is set.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { installDefaultPipeline } from "@/lib/pipeline-defaults";

const dbUrl = process.env.TEST_DATABASE_URL;
if (dbUrl) process.env.DATABASE_URL = dbUrl;
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.SDR_DEBOUNCE_MS = "0";

// Alice's number (017) in the same WhatsApp Business account as the main one (123)
const ALICE_NUMBER = "456";

describe.skipIf(!dbUrl)("WhatsApp number per funnel", () => {
  let db: typeof import("@/lib/db").db;
  let whatsapp: typeof import("@/lib/whatsapp");
  let messaging: typeof import("@/lib/messaging");
  // Every call to Meta: the URL says which number it went from
  const calls: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const sentFrom = () => calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.url.split("/").at(-2));

  beforeAll(async () => {
    db = (await import("@/lib/db")).db;
    whatsapp = await import("@/lib/whatsapp");
    messaging = await import("@/lib/messaging");
    vi.stubGlobal("fetch", async (url: string, init?: { method?: string; body?: unknown }) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.endsWith("/media")) return Response.json({ id: `up-${calls.length}` });
      if (url.endsWith("/messages")) return Response.json({ messages: [{ id: `wamid.${calls.length}.${Date.now()}` }] });
      throw new Error(`unexpected ${url}`);
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    await db.$executeRawUnsafe(
      'TRUNCATE "Job","LeadEvent","Message","Meeting","Task","Lead","SdrAgent","AutomationRule","Stage","Pipeline","Goal","User","Session","WhatsAppTemplate","EmailTemplate","Setting" CASCADE',
    );
    await installDefaultPipeline(db);
    await db.setting.create({ data: { key: "crm", value: { testMode: false } } });
    await db.sdrAgent.create({ data: { name: "Duda", persona: "x" } });
  });

  const newLead = async (data: Partial<Prisma.LeadUncheckedCreateInput> = {}) => {
    const pipeline = await db.pipeline.findFirstOrThrow({ where: { isDefault: true }, include: { stages: true } });
    return db.lead.create({ data: { name: "Maria Souza", phone: "5541999998888", pipelineId: pipeline.id, stageId: pipeline.stages[0].id, ...data } });
  };

  it("sends from the lead's number, and from the main one when the lead has none", async () => {
    const onMain = await newLead({ lastInboundAt: new Date() });
    const onAlice = await newLead({ phone: "5541999997777", whatsappNumberId: ALICE_NUMBER, lastInboundAt: new Date() });
    await messaging.sendWhatsApp(onMain, "Oi!", "Duda");
    await messaging.sendWhatsApp(onAlice, "Oi!", "Alice");
    await messaging.sendWhatsApp(onAlice, "Escolha", "Alice", { buttons: ["Sim", "Não"] });
    expect(sentFrom()).toEqual(["123", ALICE_NUMBER, ALICE_NUMBER]);

    // Outside the 24 h window the template goes from the lead's number too
    calls.length = 0;
    await db.whatsAppTemplate.create({ data: { name: "retomada", body: "Oi, {{1}}!", purpose: "reengagement" } });
    await messaging.sendWhatsApp({ ...onAlice, lastInboundAt: null }, "Oi!", "Alice", "reengagement");
    expect(calls).toMatchObject([{ url: `https://graph.facebook.com/v21.0/${ALICE_NUMBER}/messages`, body: { type: "template" } }]);

    // The helpers without a number keep the main one (the integration test message)
    calls.length = 0;
    await whatsapp.sendText("5541999998888", "teste");
    await whatsapp.sendTemplate("5541999998888", "retomada", "pt_BR", ["teste"], null, ALICE_NUMBER);
    expect(sentFrom()).toEqual(["123", ALICE_NUMBER]);
  });

  it("uploads an audio on the number that sends it", async () => {
    const lead = await newLead({ whatsappNumberId: ALICE_NUMBER, lastInboundAt: new Date() });
    const res = await messaging.sendAudioMessage(lead, new Uint8Array([1, 2, 3]), "audio/ogg", "Alice");
    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.url.split("/").slice(-2).join("/"))).toEqual([`${ALICE_NUMBER}/media`, `${ALICE_NUMBER}/messages`]);
    expect(calls[1].body).toMatchObject({ type: "audio", audio: { id: "up-1" } });
  });
});
